import { util } from 'fabric';
import type { FabricObject, StaticCanvas } from 'fabric';
import type { SerializedFabricObject } from '../document/document-format';
import { yieldToEventLoop } from '../util/concurrency';
import { enlivenPage, pickPageFields } from './page-state';
import type { PageField } from './page-state';
import { childrenOf, walkObjects } from './walk-objects';

export interface SerializedCanvas extends Partial<Record<PageField, unknown>> {
  version?: string;
  objects: SerializedFabricObject[];
}

function keepOriginExplicit(liveObjects: readonly FabricObject[], serializedObjects: SerializedFabricObject[]): void {
  const pending: Array<[FabricObject, SerializedFabricObject]> = [];
  serializedObjects.forEach((serialized, index) => {
    const live = liveObjects[index];
    if (live) pending.push([live, serialized]);
  });
  while (pending.length > 0) {
    const [live, serialized] = pending.pop()!;
    serialized.originX ??= live.originX;
    serialized.originY ??= live.originY;
    const liveChildren = childrenOf(live);
    serialized.objects?.forEach((child, index) => {
      const liveChild = liveChildren[index];
      if (liveChild) pending.push([liveChild, child]);
    });
  }
}

export function serializeCanvas(canvas: StaticCanvas, propertiesToInclude: string[]): SerializedCanvas {
  const serialized = canvas.toObject(propertiesToInclude) as SerializedCanvas;
  const objects = serialized.objects ?? [];
  keepOriginExplicit(canvas.getObjects(), objects);
  return { version: serialized.version, ...pickPageFields(serialized), objects };
}

function countSerializedTree(root: SerializedFabricObject): number {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const object = pending.pop()!;
    count += 1;
    if (object.objects) pending.push(...object.objects);
  }
  return count;
}

function countLiveTree(root: FabricObject): number {
  let count = 0;
  walkObjects([root], () => {
    count += 1;
  });
  return count;
}

function describeObject(serialized: SerializedFabricObject): string {
  return serialized.id ? `"${serialized.type}" object ${serialized.id}` : `"${serialized.type}" object`;
}

function refuseMissingObjects(serialized: SerializedFabricObject, created?: FabricObject, error?: unknown): void {
  if (error !== undefined || created === undefined) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown reason');
    throw new Error(`The ${describeObject(serialized)} could not be created: ${reason}`);
  }
  const expected = countSerializedTree(serialized);
  const actual = countLiveTree(created);
  if (actual !== expected) {
    throw new Error(`Only ${actual} of ${expected} objects inside the ${describeObject(serialized)} could be created`);
  }
}

const strictReviver = refuseMissingObjects as unknown as Parameters<StaticCanvas['loadFromJSON']>[1];

export function createObjects(serializedObjects: SerializedFabricObject[]): Promise<FabricObject[]> {
  return util.enlivenObjects<FabricObject>(serializedObjects, { reviver: strictReviver });
}

export interface CanvasLoadOptions {
  signal: AbortSignal;
  /** Called once everything is created, just before the canvas is cleared. Throw to keep the canvas as it is. */
  beforeSwap?: () => void;
  /** How many top-level objects to create before letting the browser breathe. */
  chunkSize?: number;
  /** Called after each chunk with the number of top-level objects created so far. */
  onObjects?: (done: number, total: number) => void;
}

export const DEFAULT_LOAD_CHUNK_SIZE = 100;

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Loads content like `canvas.loadFromJSON`, but creates the objects a chunk at
 * a time and yields to the browser in between, so big documents do not
 * freeze the page. Like Fabric, every object is created before the canvas is
 * cleared: a failure or cancel leaves the old content in place.
 */
export async function loadIntoCanvas(
  canvas: StaticCanvas,
  content: SerializedCanvas,
  { signal, chunkSize = DEFAULT_LOAD_CHUNK_SIZE, onObjects, beforeSwap }: CanvasLoadOptions,
): Promise<void> {
  const total = content.objects.length;
  const size = Math.max(1, Math.floor(chunkSize));
  const created: FabricObject[] = [];
  // The background, overlay and mask are created alongside the objects and
  // set in the same swap, so a failure leaves all of them as they were.
  const background = enlivenPage(content, signal);
  // Fabric rejects the background promise only after the objects; keep it from
  // being reported as unhandled while the chunks run.
  background.catch(() => undefined);

  try {
    onObjects?.(0, total);
    for (let start = 0; start < total; start += size) {
      if (signal.aborted) throw abortError();
      const chunk = content.objects.slice(start, start + size);
      created.push(...(await util.enlivenObjects<FabricObject>(chunk, { reviver: strictReviver, signal })));
      onObjects?.(created.length, total);
      if (start + size < total) await yieldToEventLoop();
    }
    const enlivenedBackground = await background;
    if (signal.aborted) throw abortError();
    beforeSwap?.();

    const renderOnAddRemove = canvas.renderOnAddRemove;
    canvas.renderOnAddRemove = false;
    try {
      canvas.clear();
      canvas.add(...created);
      if (content.version !== undefined) canvas.set({ version: content.version } as never);
      canvas.set(enlivenedBackground as never);
    } finally {
      canvas.renderOnAddRemove = renderOnAddRemove;
    }
  } catch (error) {
    // Objects that never reached the canvas still hold image elements.
    if (!created.some((object) => object.canvas === canvas)) created.forEach((object) => object.dispose?.());
    throw error;
  }
}
