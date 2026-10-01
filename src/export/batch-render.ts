import { StaticCanvas } from 'fabric';
import type { FabricObject } from 'fabric';
import type { AssetOptions } from '../assets/asset-pipeline';
import { createDocumentEngine } from '../engine/create-document-engine';
import type { DocumentEngine, ExportResult } from '../engine/create-document-engine';
import { DocumentEngineError, isDocumentEngineError } from '../engine/errors';
import type { CustomObjectDefinition } from '../fabric/object-registry';
import { walkObjects } from '../fabric/walk-objects';
import type { ContentLimits } from '../security/content-limits';
import type { ExportOptions } from './export-options';

/**
 * Renders many documents with a few reusable off-screen canvases
 * (fabric.js #4848). Each job loads a document, exports it, and then frees
 * everything the job created: objects, their cache canvases and image
 * elements. Memory therefore stays flat however many documents go through.
 */

export interface RenderDocumentsOptions extends Omit<ExportOptions, 'signal'> {
  /** How many documents render at the same time, each on its own canvas. Default 2. */
  concurrency?: number;
  signal?: AbortSignal;
  /** Called after each document, rendered or failed. */
  onProgress?: (progress: { done: number; total: number | undefined }) => void;
  customObjects?: CustomObjectDefinition[];
  assets?: AssetOptions;
  limits?: ContentLimits;
}

export interface RenderedDocument {
  /** Position of the document in the input. */
  index: number;
  documentId: string | undefined;
  result?: ExportResult;
  /** Set when this document failed. The other documents still render. */
  error?: DocumentEngineError;
}

interface Slot {
  element: HTMLCanvasElement;
  canvas: StaticCanvas;
  engine: DocumentEngine;
}

/**
 * Releases a canvas's pixels now. Fabric's `dispose` drops its references,
 * but in browsers the memory behind a canvas comes back only much later,
 * when the garbage collector gets to it.
 */
function releaseCanvas(value: unknown): void {
  if (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) {
    value.width = 0;
    value.height = 0;
  }
}

function disposeObject(object: FabricObject): void {
  const owned = object as unknown as Record<string, unknown>;
  for (const key of ['_cacheCanvas', '_filteredEl', '_element', '_originalElement']) releaseCanvas(owned[key]);
  object.dispose?.();
}

/** Frees the objects on a canvas: their cache canvases and image elements. */
export function disposeObjects(canvas: StaticCanvas): void {
  const objects = canvas.getObjects();
  canvas.remove(...objects);
  walkObjects(objects, (object) => {
    disposeObject(object);
    if (object.clipPath) disposeObject(object.clipPath as FabricObject);
  });
  for (const key of ['backgroundImage', 'overlayImage'] as const) {
    const image = canvas[key];
    if (image) {
      disposeObject(image);
      canvas[key] = undefined;
    }
  }
}

function createSlot(options: RenderDocumentsOptions): Slot {
  if (typeof document === 'undefined') {
    throw new DocumentEngineError('EXPORT_FAILED', 'Rendering documents needs a browser DOM');
  }
  const element = document.createElement('canvas');
  const canvas = new StaticCanvas(element, { renderOnAddRemove: false, enableRetinaScaling: false });
  const engine = createDocumentEngine({
    canvas,
    customObjects: options.customObjects,
    assets: options.assets,
    limits: options.limits,
    // Each job replaces the whole document, so there is nothing to undo.
    history: { limit: 1 },
  });
  return { element, canvas, engine };
}

async function releaseSlot(slot: Slot): Promise<void> {
  disposeObjects(slot.canvas);
  slot.engine.destroy();
  await slot.canvas.dispose();
  slot.element.width = 0;
  slot.element.height = 0;
}

function toEngineError(error: unknown): DocumentEngineError {
  if (isDocumentEngineError(error)) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new DocumentEngineError('EXPORT_FAILED', `The document could not be rendered: ${reason}`, { cause: error });
}

function documentIdOf(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : undefined;
}

async function renderOne(slot: Slot, input: unknown, options: RenderDocumentsOptions, signal: AbortSignal): Promise<ExportResult> {
  const { concurrency: _concurrency, onProgress: _onProgress, customObjects: _custom, assets: _assets, limits: _limits, ...exportOptions } =
    options;
  try {
    await slot.engine.loadDocument(input, { signal, discardUnsavedChanges: true });
    return await slot.engine.export({ ...exportOptions, signal });
  } finally {
    disposeObjects(slot.canvas);
    slot.engine.clearHistory();
  }
}

/**
 * Renders each document and yields the results as they finish, so they can
 * be uploaded or saved one by one instead of all being held in memory.
 * Documents can be `FabricDocument`s or plain Fabric JSON, and can come from
 * an async iterable, such as pages of a database query.
 */
export async function* renderDocuments(
  documents: Iterable<unknown> | AsyncIterable<unknown>,
  options: RenderDocumentsOptions,
): AsyncGenerator<RenderedDocument, void, undefined> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const total = Array.isArray(documents) ? documents.length : undefined;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();

  const iterator =
    Symbol.asyncIterator in (documents as object)
      ? (documents as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      : (documents as Iterable<unknown>)[Symbol.iterator]();
  const slots: Slot[] = [];
  const idle: Slot[] = [];
  const running = new Map<number, Promise<RenderedDocument>>();
  let nextIndex = 0;
  let exhausted = false;
  let done = 0;

  async function take(): Promise<{ index: number; value: unknown } | undefined> {
    if (exhausted) return undefined;
    const next = await iterator.next();
    if (next.done) {
      exhausted = true;
      return undefined;
    }
    return { index: nextIndex++, value: next.value };
  }

  function start(slot: Slot, job: { index: number; value: unknown }): void {
    const task = renderOne(slot, job.value, options, controller.signal).then(
      (result): RenderedDocument => ({ index: job.index, documentId: documentIdOf(job.value), result }),
      (error: unknown): RenderedDocument => ({ index: job.index, documentId: documentIdOf(job.value), error: toEngineError(error) }),
    );
    running.set(
      job.index,
      task.finally(() => idle.push(slot)),
    );
  }

  try {
    while (true) {
      if (controller.signal.aborted) throw new DocumentEngineError('EXPORT_ABORTED', 'Rendering was cancelled');
      while (running.size < concurrency && !exhausted) {
        const job = await take();
        if (!job) break;
        let slot = idle.pop();
        if (!slot) {
          slot = createSlot(options);
          slots.push(slot);
        }
        start(slot, job);
      }
      if (running.size === 0) break;
      const finished = await Promise.race(running.values());
      running.delete(finished.index);
      done += 1;
      options.onProgress?.({ done, total });
      if (controller.signal.aborted) throw new DocumentEngineError('EXPORT_ABORTED', 'Rendering was cancelled');
      yield finished;
    }
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', stop);
    await Promise.allSettled(running.values());
    await Promise.all(slots.map(releaseSlot));
    if (!exhausted) await (iterator as AsyncIterator<unknown> & Partial<Iterator<unknown>>).return?.();
  }
}
