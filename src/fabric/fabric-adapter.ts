import { util } from 'fabric';
import type { FabricObject, StaticCanvas } from 'fabric';
import type { SerializedFabricObject } from '../document/document-format';
import { childrenOf, walkObjects } from './walk-objects';

export interface SerializedCanvas {
  version?: string;
  background?: unknown;
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
  return { version: serialized.version, background: serialized.background, objects };
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

export async function loadIntoCanvas(
  canvas: StaticCanvas,
  content: SerializedCanvas,
  signal: AbortSignal,
): Promise<void> {
  const json: Record<string, unknown> = { objects: content.objects };
  if (content.version !== undefined) json.version = content.version;
  if (content.background !== undefined) json.background = content.background;
  await canvas.loadFromJSON(json, strictReviver, { signal });
}
