import { util } from 'fabric';
import type { FabricImage } from 'fabric';
import type { DocumentEngine } from '../engine/create-document-engine';
import { yieldToEventLoop } from '../util/concurrency';
import { canRunInWorker, runFilterPipeline } from './pipeline';
import type { PipelineFilter } from './pipeline';
import type { ApplyMessage, CancelMessage, WorkerReply } from './worker-entry';

export interface ImageFilter {
  type?: string;
  isNeutralState(): boolean;
  toObject(): Record<string, unknown>;
}

export interface FilterWorkerOptions {
  createWorker?: () => Worker;
  worker?: boolean;
  poolSize?: number;
  bandRows?: number;
  engine?: DocumentEngine;
}

export interface ApplyFilterOptions {
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
}

export interface FilterWorker {
  apply(image: FabricImage, filters?: ImageFilter[], options?: ApplyFilterOptions): Promise<boolean>;
  readonly mode: 'worker' | 'main-thread';
  terminate(): void;
}

interface ImageInternals {
  _element: CanvasImageSource;
  _originalElement: HTMLImageElement | HTMLCanvasElement;
  _filteredEl?: HTMLCanvasElement;
  _filterScalingX: number;
  _filterScalingY: number;
  _lastScaleX: number;
  _lastScaleY: number;
  cacheKey: string;
  filters: ImageFilter[];
  removeTexture?(key: string): void;
  applyFilters(filters?: ImageFilter[]): void;
}

interface Slot {
  worker: Worker;
  job: Job | undefined;
}

interface Job {
  id: number;
  image: FabricImage;
  filters: ImageFilter[];
  options: ApplyFilterOptions;
  session: number | undefined;
  settled: boolean;
  slot?: Slot;
  resolve(updated: boolean): void;
  reject(reason: unknown): void;
}

function sizeOf(element: HTMLImageElement | HTMLCanvasElement): { width: number; height: number } {
  return {
    width: (element as HTMLImageElement).naturalWidth || element.width,
    height: (element as HTMLImageElement).naturalHeight || element.height,
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The filter run was aborted', 'AbortError');
}

export function createFilterWorker(options: FilterWorkerOptions = {}): FilterWorker {
  const engine = options.engine;
  const latest = new WeakMap<FabricImage, number>();
  const jobs = new Map<number, Job>();
  const queue: Job[] = [];
  let slots: Slot[] | undefined;
  let workersFailed = options.worker === false;
  let nextId = 0;

  function makeWorker(): Worker | undefined {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return undefined;
    try {
      return options.createWorker ? options.createWorker() : new Worker(new URL('./worker-entry.js', import.meta.url), { type: 'module' });
    } catch {
      return undefined;
    }
  }

  function pool(): Slot[] | undefined {
    if (workersFailed) return undefined;
    if (slots) return slots;
    const made: Slot[] = [];
    for (let index = 0; index < Math.max(1, options.poolSize ?? 1); index += 1) {
      const worker = makeWorker();
      if (!worker) break;
      const slot: Slot = { worker, job: undefined };
      worker.onmessage = (event: MessageEvent<WorkerReply>) => onReply(slot, event.data);
      worker.onerror = (event) => {
        event.preventDefault?.();
        workersFailed = true;
        const job = slot.job;
        slot.job = undefined;
        slots?.forEach((each) => each.worker.terminate());
        slots = undefined;
        if (job && !job.settled) void runOnMainThread(job);
        queue.splice(0).forEach((waiting) => void runOnMainThread(waiting));
      };
      made.push(slot);
    }
    if (made.length === 0) {
      workersFailed = true;
      return undefined;
    }
    return (slots = made);
  }

  function settle(job: Job, outcome: { updated: boolean } | { error: unknown }): void {
    if (job.settled) return;
    job.settled = true;
    jobs.delete(job.id);
    if ('error' in outcome) job.reject(outcome.error);
    else job.resolve(outcome.updated);
  }

  function cancel(job: Job, reason?: unknown): void {
    if (job.settled) return;
    if (job.slot) job.slot.worker.postMessage({ type: 'cancel', id: job.id } satisfies CancelMessage);
    settle(job, reason === undefined ? { updated: false } : { error: reason });
  }

  function commit(job: Job, draw: ((ctx: CanvasRenderingContext2D, width: number, height: number) => void) | undefined): void {
    if (job.settled) return;
    if (latest.get(job.image) !== job.id || (engine && engine.getDocumentInfo().session !== job.session)) {
      settle(job, { updated: false });
      return;
    }
    const image = job.image as unknown as ImageInternals;
    const write = (): void => {
      image.filters = job.filters;
      image.removeTexture?.(`${image.cacheKey}_filtered`);
      if (!draw) {
        image._element = image._originalElement;
        image._filteredEl = undefined;
        image._filterScalingX = 1;
        image._filterScalingY = 1;
      } else {
        const { width, height } = sizeOf(image._originalElement);
        let target = image._filteredEl;
        if (image._element === image._originalElement || !target) {
          target = util.createCanvasElement();
          image._filteredEl = target;
        } else {
          image._lastScaleX = 1;
          image._lastScaleY = 1;
        }
        image._element = target;
        target.width = width;
        target.height = height;
        draw(target.getContext('2d')!, width, height);
        if (target.width !== image._originalElement.width || target.height !== image._originalElement.height) {
          image._filterScalingX = target.width / image._originalElement.width;
          image._filterScalingY = target.height / image._originalElement.height;
        }
      }
      job.image.set('dirty', true);
    };
    if (engine) engine.transaction('Apply filters', write);
    else write();
    job.image.canvas?.requestRenderAll();
    settle(job, { updated: true });
  }

  async function runOnMainThread(job: Job): Promise<void> {
    if (job.settled) return;
    const image = job.image as unknown as ImageInternals;
    const active = job.filters.filter((filter) => filter && !filter.isNeutralState());
    if (!canRunInWorker(active as never)) {
      await yieldToEventLoop();
      if (job.settled || latest.get(job.image) !== job.id) return settle(job, { updated: false });
      if (engine) engine.transaction('Apply filters', () => image.applyFilters(job.filters));
      else image.applyFilters(job.filters);
      image.filters = job.filters;
      job.image.canvas?.requestRenderAll();
      job.options.onProgress?.(1);
      return settle(job, { updated: true });
    }
    const { width, height } = sizeOf(image._originalElement);
    const scratch = util.createCanvasElement();
    scratch.width = width;
    scratch.height = height;
    const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image._originalElement, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    try {
      const result = await runFilterPipeline(
        active as unknown as PipelineFilter[],
        { sourceWidth: width, sourceHeight: height, imageData, originalImageData: imageData, originalEl: image._originalElement, canvasEl: scratch, ctx, filterBackend: undefined },
        { bandRows: options.bandRows, pause: yieldToEventLoop, isCancelled: () => job.settled, onProgress: job.options.onProgress },
      );
      if (!result) return;
      commit(job, (target, targetWidth, targetHeight) => {
        if (result.width !== targetWidth || result.height !== targetHeight) {
          target.canvas.width = result.width;
          target.canvas.height = result.height;
        }
        target.putImageData(result, 0, 0);
      });
    } catch (error) {
      settle(job, { error });
    } finally {
      scratch.width = 0;
      scratch.height = 0;
    }
  }

  async function start(slot: Slot, job: Job): Promise<void> {
    slot.job = job;
    job.slot = slot;
    const image = job.image as unknown as ImageInternals;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(image._originalElement);
    } catch (error) {
      slot.job = undefined;
      settle(job, { error });
      pump();
      return;
    }
    if (job.settled || slot.job !== job) {
      bitmap.close();
      if (slot.job === job) slot.job = undefined;
      pump();
      return;
    }
    const active = job.filters.filter((filter) => filter && !filter.isNeutralState());
    const message: ApplyMessage = { type: 'apply', id: job.id, bitmap, filters: active.map((filter) => filter.toObject()), bandRows: options.bandRows };
    slot.worker.postMessage(message, [bitmap]);
  }

  function onReply(slot: Slot, reply: WorkerReply): void {
    const job = slot.job?.id === reply.id ? slot.job : undefined;
    if (reply.type === 'progress') {
      if (job && !job.settled) job.options.onProgress?.(reply.done);
      return;
    }
    if (job) slot.job = undefined;
    if (reply.type === 'done') {
      if (job) {
        commit(job, (ctx) => {
          if (reply.bitmap.width !== ctx.canvas.width || reply.bitmap.height !== ctx.canvas.height) {
            ctx.canvas.width = reply.bitmap.width;
            ctx.canvas.height = reply.bitmap.height;
          }
          ctx.drawImage(reply.bitmap, 0, 0);
        });
      }
      reply.bitmap.close();
    } else if (reply.type === 'error' && job) {
      settle(job, { error: new Error(`The filter worker failed: ${reply.message}`) });
    }
    pump();
  }

  function pump(): void {
    const available = pool();
    if (!available) {
      queue.splice(0).forEach((job) => void runOnMainThread(job));
      return;
    }
    for (const slot of available) {
      if (slot.job) continue;
      let job = queue.shift();
      while (job && job.settled) job = queue.shift();
      if (!job) return;
      void start(slot, job);
    }
  }

  return {
    get mode() {
      return pool() ? 'worker' : 'main-thread';
    },
    apply(image, filters, applyOptions = {}) {
      const list = [...(filters ?? (image as unknown as ImageInternals).filters ?? [])];
      const id = (nextId += 1);
      const previous = latest.get(image);
      latest.set(image, id);
      if (previous !== undefined) {
        const replaced = jobs.get(previous);
        if (replaced) cancel(replaced);
      }
      return new Promise<boolean>((resolve, reject) => {
        const job: Job = { id, image, filters: list, options: applyOptions, session: engine?.getDocumentInfo().session, settled: false, resolve, reject };
        jobs.set(id, job);
        const { signal } = applyOptions;
        if (signal?.aborted) return cancel(job, abortReason(signal));
        signal?.addEventListener('abort', () => cancel(job, abortReason(signal)), { once: true });
        if (list.every((filter) => !filter || filter.isNeutralState())) {
          commit(job, undefined);
          applyOptions.onProgress?.(1);
          return;
        }
        if (!canRunInWorker(list.filter((filter) => filter && !filter.isNeutralState()) as never) || !pool()) {
          void runOnMainThread(job);
          return;
        }
        queue.push(job);
        pump();
      });
    },
    terminate() {
      slots?.forEach((slot) => slot.worker.terminate());
      slots = undefined;
      workersFailed = true;
      [...jobs.values()].forEach((job) => cancel(job));
      queue.length = 0;
    },
  };
}
