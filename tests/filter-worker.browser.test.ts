import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Canvas, Canvas2dFilterBackend, FabricImage, filters, setFilterBackend } from 'fabric';
import { createDocumentEngine } from '../src';
import type { DocumentEngine } from '../src';
import { createFilterWorker } from '../src/filters';
import type { FilterWorker, ImageFilter } from '../src/filters';

const workers: FilterWorker[] = [];
const engines: DocumentEngine[] = [];
const canvases: Canvas[] = [];

beforeAll(() => {
  setFilterBackend(new Canvas2dFilterBackend());
});

afterEach(async () => {
  workers.splice(0).forEach((worker) => worker.terminate());
  engines.splice(0).forEach((engine) => engine.destroy());
  for (const canvas of canvases.splice(0)) await canvas.dispose();
});

const pictureUrls = new Map<string, string>();

async function picture(width = 640, height = 480): Promise<FabricImage> {
  let pictureUrl = pictureUrls.get(`${width}x${height}`);
  if (!pictureUrl) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#123456');
    gradient.addColorStop(0.5, '#f0a030');
    gradient.addColorStop(1, '#30c080');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    for (let index = 0; index < 400; index += 1) {
      ctx.fillStyle = `hsl(${(index * 37) % 360} 70% 50%)`;
      ctx.fillRect((index * 97) % width, (index * 53) % height, 40, 25);
    }
    pictureUrl = canvas.toDataURL('image/png');
    pictureUrls.set(`${width}x${height}`, pictureUrl);
  }
  return FabricImage.fromURL(pictureUrl);
}

const heavyFilters = (): ImageFilter[] => [
  new filters.Blur({ blur: 0.2 }),
  new filters.Convolute({ matrix: [0, -1, 0, -1, 5, -1, 0, -1, 0] }),
  new filters.Brightness({ brightness: 0.1 }),
  new filters.Contrast({ contrast: 0.2 }),
  new filters.Sepia(),
];

function pixelsOf(image: FabricImage): Uint8ClampedArray {
  const element = (image as unknown as { _element: HTMLCanvasElement })._element;
  const canvas = document.createElement('canvas');
  canvas.width = element.width;
  canvas.height = element.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(element, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

function largestDifference(first: Uint8ClampedArray, second: Uint8ClampedArray): number {
  let largest = 0;
  for (let index = 0; index < first.length; index += 1) largest = Math.max(largest, Math.abs(first[index]! - second[index]!));
  return largest;
}

async function heartbeats(work: () => Promise<unknown>): Promise<number> {
  const channel = new MessageChannel();
  let beats = 0;
  let running = true;
  channel.port1.onmessage = () => {
    beats += 1;
    if (running) channel.port2.postMessage(null);
  };
  channel.port2.postMessage(null);
  await work();
  running = false;
  channel.port1.close();
  return beats;
}

async function longestBlock(work: () => Promise<unknown>): Promise<number> {
  const channel = new MessageChannel();
  let last = performance.now();
  let longest = 0;
  let running = true;
  channel.port1.onmessage = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) channel.port2.postMessage(null);
  };
  channel.port2.postMessage(null);
  await work();
  running = false;
  longest = Math.max(longest, performance.now() - last);
  channel.port1.close();
  return longest;
}

describe('image filters off the main thread (fabric.js #9532)', () => {
  it('reproduces: applyFilters blocks the main thread for the whole run, and the worker does not', async () => {
    const reference = await picture(1200, 900);
    reference.filters = heavyFilters() as never;
    const fabricBlock = await longestBlock(async () => reference.applyFilters());
    expect(fabricBlock).toBeGreaterThan(40);

    const image = await picture(1200, 900);
    const worker = createFilterWorker();
    workers.push(worker);
    const workerBlock = await longestBlock(() => worker.apply(image, heavyFilters()));
    expect(workerBlock).toBeLessThan(fabricBlock / 2);
  });

  it('gives the same pixels as Fabric, with progress', async () => {
    const reference = await picture();
    reference.filters = heavyFilters() as never;
    reference.applyFilters();

    const image = await picture();
    const worker = createFilterWorker();
    workers.push(worker);
    expect(worker.mode).toBe('worker');
    const progress: number[] = [];
    expect(await worker.apply(image, heavyFilters(), { onProgress: (done) => progress.push(done) })).toBe(true);
    expect(largestDifference(pixelsOf(image), pixelsOf(reference))).toBeLessThanOrEqual(1);
    expect(image.filters.map((filter) => filter.type)).toEqual(['Blur', 'Convolute', 'Brightness', 'Contrast', 'Sepia']);
    expect(progress.length).toBeGreaterThan(5);
    expect(progress.every((done, index) => index === 0 || done >= progress[index - 1]!)).toBe(true);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('runs in steps on the main thread without workers, with the same pixels', async () => {
    const pointwise = (): ImageFilter[] => [new filters.Brightness({ brightness: 0.2 }), new filters.Grayscale(), new filters.Contrast({ contrast: 0.3 }), new filters.Saturation({ saturation: 0.4 })];
    const reference = await picture();
    reference.filters = pointwise() as never;
    expect(await heartbeats(async () => reference.applyFilters())).toBeLessThanOrEqual(1);
    const image = await picture();
    const worker = createFilterWorker({ worker: false, bandRows: 32 });
    workers.push(worker);
    expect(worker.mode).toBe('main-thread');
    expect(await heartbeats(() => worker.apply(image, pointwise()))).toBeGreaterThanOrEqual(480 / 32 / 2);
    expect(largestDifference(pixelsOf(image), pixelsOf(reference))).toBeLessThanOrEqual(1);
  });

  it('leaves the image as it was when aborted', async () => {
    const image = await picture();
    const original = (image as unknown as { _element: unknown })._element;
    const worker = createFilterWorker();
    workers.push(worker);
    const controller = new AbortController();
    const run = worker.apply(image, heavyFilters(), { signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect((image as unknown as { _element: unknown })._element).toBe(original);
    expect(image.filters).toEqual([]);
  });

  it('keeps only the newest run for an image', async () => {
    const image = await picture();
    const worker = createFilterWorker();
    workers.push(worker);
    const first = worker.apply(image, [new filters.Brightness({ brightness: 0.5 })]);
    const second = worker.apply(image, [new filters.Brightness({ brightness: -0.5 })]);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect((image.filters[0] as unknown as { brightness: number }).brightness).toBe(-0.5);
  });

  it('removes filters when given none, as applyFilters does', async () => {
    const image = await picture();
    const worker = createFilterWorker();
    workers.push(worker);
    await worker.apply(image, [new filters.Invert()]);
    await worker.apply(image, []);
    const internals = image as unknown as { _element: unknown; _originalElement: unknown };
    expect(internals._element).toBe(internals._originalElement);
  });

  it('uses Fabric for filters a worker cannot run', async () => {
    const image = await picture(200, 150);
    const worker = createFilterWorker();
    workers.push(worker);
    const resize = new filters.Resize({ scaleX: 0.5, scaleY: 0.5 });
    expect(await worker.apply(image, [resize, new filters.Invert()])).toBe(true);
    expect(image.filters).toHaveLength(2);
  });

  it('records one undo step in an engine', async () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element, { width: 300, height: 200 });
    canvases.push(canvas);
    const engine = createDocumentEngine({ canvas });
    engines.push(engine);
    const image = await picture(300, 200);
    canvas.add(image);
    await Promise.resolve();
    const worker = createFilterWorker({ engine });
    workers.push(worker);
    const before = engine.getHistory().undo.length;
    await worker.apply(image, [new filters.Grayscale()]);
    expect(engine.getHistory().undo.length).toBe(before + 1);
    expect(engine.getHistory().undo[0]).toBe('Apply filters');
    expect(engine.toDocument().objects[0]!.filters).toEqual([expect.objectContaining({ type: 'Grayscale' })]);
    await engine.undo();
    expect((engine.canvas.getObjects()[0] as FabricImage).filters).toEqual([]);
  });
});
