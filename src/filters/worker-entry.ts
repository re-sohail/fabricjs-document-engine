import { classRegistry } from 'fabric';
import { runFilterPipeline } from './pipeline';
import type { PipelineFilter } from './pipeline';

export interface ApplyMessage {
  type: 'apply';
  id: number;
  bitmap: ImageBitmap;
  filters: Array<Record<string, unknown>>;
  bandRows?: number;
}

export interface CancelMessage {
  type: 'cancel';
  id: number;
}

export type WorkerReply =
  | { type: 'progress'; id: number; done: number }
  | { type: 'done'; id: number; bitmap: ImageBitmap }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string };

interface WorkerScope {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ApplyMessage | CancelMessage>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const running = new Set<number>();
const cancelled = new Set<number>();

const channel = new MessageChannel();
const waiting: Array<() => void> = [];
channel.port1.onmessage = () => waiting.shift()?.();
const pause = (): Promise<void> =>
  new Promise((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(null);
  });

async function apply(message: ApplyMessage): Promise<void> {
  const { id, bitmap } = message;
  running.add(id);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const filters = (await Promise.all(
      message.filters.map((json) => (classRegistry.getClass(String(json.type)) as { fromObject(json: unknown): Promise<unknown> }).fromObject(json)),
    )) as PipelineFilter[];
    const result = await runFilterPipeline(
      filters,
      { sourceWidth: canvas.width, sourceHeight: canvas.height, imageData, originalImageData: imageData, originalEl: canvas, canvasEl: canvas, ctx, filterBackend: undefined },
      {
        bandRows: message.bandRows,
        pause,
        isCancelled: () => cancelled.has(id),
        onProgress: (done) => scope.postMessage({ type: 'progress', id, done }),
      },
    );
    if (!result) {
      scope.postMessage({ type: 'cancelled', id });
      return;
    }
    if (result.width !== canvas.width || result.height !== canvas.height) {
      canvas.width = result.width;
      canvas.height = result.height;
    }
    ctx.putImageData(result, 0, 0);
    const output = canvas.transferToImageBitmap();
    scope.postMessage({ type: 'done', id, bitmap: output }, [output]);
  } catch (error) {
    scope.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  } finally {
    running.delete(id);
    cancelled.delete(id);
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (running.has(message.id)) cancelled.add(message.id);
  } else void apply(message);
};
