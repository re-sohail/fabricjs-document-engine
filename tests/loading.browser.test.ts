import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Rect } from 'fabric';
import { createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, DocumentEngineOptions, FabricDocument, LoadProgress, SerializedFabricObject } from '../src';
import { createMemoryStorage } from '../src/storage';

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(options: Omit<DocumentEngineOptions, 'canvas'> = {}): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 300, height: 200 });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas, ...options });
  openEngines.push(engine);
  return engine;
}

function rects(count: number): SerializedFabricObject[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'Rect',
    id: `rect-${index}`,
    left: index % 300,
    top: Math.floor(index / 300),
    width: 4,
    height: 4,
    fill: 'teal',
  }));
}

function texts(count: number): SerializedFabricObject[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'Textbox',
    id: `text-${index}`,
    text: `Line ${index} with a few words to measure`,
    width: 120,
    fontSize: 12,
  }));
}

function images(count: number): SerializedFabricObject[] {
  const picture = document.createElement('canvas');
  picture.width = 8;
  picture.height = 8;
  picture.getContext('2d')!.fillRect(0, 0, 8, 8);
  return Array.from({ length: count }, (_, index) => ({
    type: 'Image',
    id: `image-${index}`,
    // Each URL is different, so every image really loads.
    src: `${picture.toDataURL()}#${index}`,
    left: index % 300,
    width: 8,
    height: 8,
  }));
}

function documentOf(objects: SerializedFabricObject[], extra: Partial<FabricDocument> = {}): FabricDocument {
  return {
    schemaVersion: 1,
    id: 'big',
    createdAt: '',
    updatedAt: '',
    canvas: { width: 300, height: 200 },
    objects,
    metadata: {},
    ...extra,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

function idsOn(engine: DocumentEngine): string[] {
  return engine.canvas.getObjects().map((object) => (object as unknown as { id: string }).id);
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`loading progress and cancelling on Fabric ${fabric.version}`, () => {
  it('reports each stage in order, and objects a chunk at a time', async () => {
    const engine = createEngine();
    const seen: LoadProgress[] = [];
    await engine.loadDocument(documentOf(rects(250)), { onProgress: (progress) => seen.push(progress) });

    expect([...new Set(seen.map((progress) => progress.stage))]).toEqual(['prepare', 'images', 'objects', 'done']);
    const objects = seen.filter((progress) => progress.stage === 'objects');
    expect(objects.map((progress) => progress.done)).toEqual([0, 100, 200, 250]);
    expect(objects.every((progress) => progress.total === 250 && progress.documentId === 'big')).toBe(true);
    expect(seen.at(-1)).toEqual({ documentId: 'big', stage: 'done', done: 1, total: 1 });
    expect(engine.canvas.getObjects()).toHaveLength(250);
  });

  it('sends the same progress as load:progress events', async () => {
    const engine = createEngine();
    const fromOption: LoadProgress[] = [];
    const fromEvent: LoadProgress[] = [];
    engine.on('load:progress', (progress) => fromEvent.push(progress));
    await engine.loadDocument(documentOf(rects(5)), { onProgress: (progress) => fromOption.push(progress) });
    expect(fromEvent).toEqual(fromOption);
  });

  it('counts images while it checks them', async () => {
    const engine = createEngine();
    const pixel = '/__test-assets__/pixel.png';
    const seen: LoadProgress[] = [];
    await engine.loadDocument(
      documentOf([
        { type: 'Image', id: 'a', src: `${pixel}?a`, width: 1, height: 1 },
        { type: 'Image', id: 'b', src: `${pixel}?b`, width: 1, height: 1 },
      ]),
      { onProgress: (progress) => seen.push(progress) },
    );
    expect(seen.filter((progress) => progress.stage === 'images').map((progress) => progress.done)).toEqual([0, 1, 2]);
  });

  it('refuses to start when the signal is already cancelled', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 5, height: 5 }));
    const error = await errorOf(engine.loadDocument(documentOf(rects(3)), { signal: AbortSignal.abort() }));
    expect(isDocumentEngineError(error) && error.code).toBe('LOAD_ABORTED');
    expect((error as Error).message).toBe('Loading was cancelled');
    expect(engine.canvas.getObjects()).toHaveLength(1);
  });

  it('keeps the old content when cancelled while objects are created', async () => {
    const engine = createEngine();
    await engine.loadDocument(documentOf(rects(2)));
    const before = idsOn(engine);
    const controller = new AbortController();
    const error = await errorOf(
      engine.loadDocument(documentOf(rects(500)), {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.stage === 'objects' && progress.done >= 100) controller.abort();
        },
      }),
    );
    expect(isDocumentEngineError(error) && error.code).toBe('LOAD_ABORTED');
    expect(idsOn(engine)).toEqual(before);
  });

  it('keeps the old content when cancelled while images load', async () => {
    const engine = createEngine();
    await engine.loadDocument(documentOf(rects(1)));
    const controller = new AbortController();
    const loading = engine.loadDocument(
      documentOf([{ type: 'Image', id: 'slow', src: '/__test-assets__/slow.png?ms=3000', width: 1, height: 1 }]),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    const error = await errorOf(loading);
    expect(isDocumentEngineError(error) && error.code).toBe('LOAD_ABORTED');
    expect(idsOn(engine)).toEqual(['rect-0']);
  });

  it('cancels a load from storage', async () => {
    const storage = createMemoryStorage();
    const engine = createEngine({ storage });
    await storage.saveDocument(documentOf(rects(3), { id: 'stored' }), { expectedRevision: null, signal: new AbortController().signal });
    const error = await errorOf(engine.load('stored', { signal: AbortSignal.abort() }));
    expect(isDocumentEngineError(error) && error.code).toBe('LOAD_ABORTED');
    expect(engine.canvas.getObjects()).toHaveLength(0);
  });

  it('still says a newer load replaced an older one', async () => {
    const engine = createEngine();
    const first = errorOf(engine.loadDocument(documentOf(rects(300))));
    await engine.loadDocument(documentOf(rects(2), { id: 'newer' }));
    const error = await first;
    expect(isDocumentEngineError(error) && error.code).toBe('LOAD_ABORTED');
    expect((error as Error).message).toContain('newer load');
    expect(engine.getDocumentInfo().id).toBe('newer');
  });

  it('ignores the signal once the load has finished', async () => {
    const engine = createEngine();
    const controller = new AbortController();
    await engine.loadDocument(documentOf(rects(3)), { signal: controller.signal });
    controller.abort();
    expect(engine.canvas.getObjects()).toHaveLength(3);
    await engine.loadDocument(documentOf(rects(1), { id: 'next' }));
    expect(engine.getDocumentInfo().id).toBe('next');
  });

  it('keeps the old content when an object in a later chunk cannot be created', async () => {
    const engine = createEngine();
    await engine.loadDocument(documentOf(rects(1)));
    const objects = rects(150);
    objects[140] = { type: 'Group', id: 'broken', objects: [{ type: 'Rect' }, { type: 'NoSuchShape' }] };
    engine.registerObject({ fabricClass: { type: 'NoSuchShape', fromObject: () => Promise.reject(new Error('no')) } });
    const error = await errorOf(engine.loadDocument(documentOf(objects)));
    expect(isDocumentEngineError(error) && error.code).toBe('LOAD_FAILED');
    expect(idsOn(engine)).toEqual(['rect-0']);
  });

  it('restores colour and gradient backgrounds', async () => {
    const engine = createEngine();
    await engine.loadDocument(documentOf(rects(1), { canvas: { width: 300, height: 200, background: '#ffeeaa' } }));
    expect(engine.canvas.backgroundColor).toBe('#ffeeaa');

    const gradient = new fabric.Gradient({
      type: 'linear',
      coords: { x1: 0, y1: 0, x2: 300, y2: 0 },
      colorStops: [
        { offset: 0, color: 'red' },
        { offset: 1, color: 'blue' },
      ],
    });
    await engine.loadDocument(
      documentOf(rects(1), { id: 'gradient', canvas: { width: 300, height: 200, background: gradient.toObject() } }),
    );
    expect(engine.canvas.backgroundColor).toBeInstanceOf(fabric.Gradient);
    await engine.loadDocument(documentOf(rects(1), { id: 'plain' }));
    expect(engine.canvas.backgroundColor).toBeFalsy();
  });

  it('gives the browser a turn between chunks of objects', async () => {
    const engine = createEngine();
    const yieldTurn = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    vi.stubGlobal('scheduler', { yield: yieldTurn });
    try {
      await engine.loadDocument(documentOf(rects(450)));
    } finally {
      vi.unstubAllGlobals();
    }
    // Five chunks of 100 objects, with a turn between each pair.
    expect(yieldTurn).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['5,000 shapes', () => rects(5000)],
    ['1,500 text boxes', () => texts(1500)],
    ['300 images', () => images(300)],
  ])('never blocks for long while %s load', async (_, makeObjects) => {
    const objects = makeObjects();
    const engine = createEngine();
    let last = performance.now();
    const stretches: Array<[string, number]> = [];
    await engine.loadDocument(documentOf(objects), {
      onProgress: (progress) => {
        const now = performance.now();
        stretches.push([`${progress.stage} ${progress.done}`, Math.round(now - last)]);
        last = now;
      },
    });
    expect(engine.canvas.getObjects()).toHaveLength(objects.length);
    // Each stretch takes about 10 ms, and the final swap into the canvas about
    // 50 ms, on a laptop. The budget leaves room for busy CI machines.
    expect(stretches.filter(([, ms]) => ms >= 500)).toEqual([]);
  }, 60_000);
});
