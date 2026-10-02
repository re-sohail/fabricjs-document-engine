import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Circle, FabricImage, IText, Rect } from 'fabric';
import { createClipboard, createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, DocumentEngineOptions, FabricDocument, SerializedFabricObject } from '../src';
import { createMemoryRecovery } from '../src/recovery';
import { exportPdf } from '../src/pdf';
import { readPdf } from './support/pdf';
import { createMemoryStorage } from '../src/storage';

/**
 * Document reliability: content that must survive saving and reopening,
 * changes that must count as unsaved work, and work that must not land in
 * the wrong document.
 */

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(options: Omit<DocumentEngineOptions, 'canvas'> = {}, size = { width: 300, height: 200 }): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, size);
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas, ...options });
  openEngines.push(engine);
  return engine;
}

const nextTick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => (isDocumentEngineError(error) ? error.code : error),
  );
}

function rects(count: number): SerializedFabricObject[] {
  return Array.from({ length: count }, (_, index) => ({ type: 'Rect', id: `r${index}`, left: index % 300, top: 5, width: 4, height: 4 }));
}

function documentOf(objects: SerializedFabricObject[], extra: Partial<FabricDocument> = {}): FabricDocument {
  return { schemaVersion: 1, id: 'doc', createdAt: '', updatedAt: '', canvas: { width: 300, height: 200 }, objects, metadata: {}, ...extra };
}

const pixel = '/__test-assets__/pixel.png';

afterEach(async () => {
  vi.restoreAllMocks();
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`document reliability on Fabric ${fabric.version}`, () => {
  it('1. keeps the background image, overlay and canvas mask through save and reopen', async () => {
    const source = createEngine();
    const canvas = source.canvas;
    canvas.backgroundImage = await FabricImage.fromURL(pixel);
    canvas.overlayColor = 'rgba(0, 0, 255, 0.25)';
    canvas.clipPath = new Circle({ radius: 80, left: 150, top: 100, originX: 'center', originY: 'center' });
    const saved = JSON.parse(JSON.stringify(source.toDocument())) as FabricDocument;

    expect(saved.assets?.images.map((image) => image.url)).toEqual([expect.stringContaining('pixel.png')]);

    const reopened = createEngine();
    await reopened.loadDocument(saved);
    expect(reopened.canvas.backgroundImage).toBeInstanceOf(FabricImage);
    expect(reopened.canvas.overlayColor).toBe('rgba(0, 0, 255, 0.25)');
    expect(reopened.canvas.clipPath).toBeInstanceOf(Circle);
  });

  it('1. opens canvas-level images from plain Fabric JSON', async () => {
    const json = {
      version: fabric.version,
      objects: [],
      backgroundImage: { type: 'Image', src: pixel, width: 1, height: 1 },
      overlayImage: { type: 'Image', src: pixel, width: 1, height: 1 },
    };
    const engine = createEngine();
    await engine.importFabricJson(json);
    expect(engine.canvas.backgroundImage).toBeInstanceOf(FabricImage);
    expect(engine.canvas.overlayImage).toBeInstanceOf(FabricImage);
  });

  it('1. refuses a missing background image before touching the canvas', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 5, height: 5 }));
    const document = documentOf([], {
      canvas: { width: 300, height: 200, backgroundImage: { type: 'Image', src: '/__test-assets__/gone.png' } } as FabricDocument['canvas'],
    });
    expect(await codeOf(engine.loadDocument(document))).toBe('MISSING_ASSETS');
    expect(engine.canvas.getObjects()).toHaveLength(1);
  });

  it('2. records a page change as one undo step and marks it unsaved', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    await engine.save();
    engine.setPage({ width: 640, height: 480, background: '#ffeeaa' }, 'Resize page');
    expect(engine.isDirty()).toBe(true);
    expect(engine.getHistory().undo).toEqual(['Resize page']);
    expect([engine.canvas.getWidth(), engine.canvas.getHeight(), engine.canvas.backgroundColor]).toEqual([640, 480, '#ffeeaa']);
    await engine.undo();
    expect([engine.canvas.getWidth(), engine.canvas.getHeight()]).toEqual([300, 200]);
    expect(engine.canvas.backgroundColor).toBeFalsy();
    await engine.redo();
    expect(engine.canvas.getWidth()).toBe(640);
  });

  it('2. notices canvas changes made directly inside a transaction', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    await engine.save();
    engine.transaction('Background', () => {
      engine.canvas.backgroundColor = 'teal';
      engine.canvas.setDimensions({ width: 400, height: 250 });
    });
    expect(engine.isDirty()).toBe(true);
    expect(engine.getHistory().undo).toEqual(['Background']);
  });

  it('3. marks typed text unsaved before editing ends, and keeps one undo step', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    const text = new IText('Hello');
    engine.canvas.add(text);
    await engine.save();
    engine.clearHistory();
    text.enterEditing();
    text.set('text', 'Hello world');
    engine.canvas.fire('text:changed', { target: text });
    expect(engine.isDirty()).toBe(true);
    text.set('text', 'Hello world!');
    engine.canvas.fire('text:changed', { target: text });
    text.exitEditing();
    await nextTick();
    expect(engine.getHistory().undo).toHaveLength(1);
  });

  it('4. keeps an edit made while a document loads, and refuses the load', async () => {
    const engine = createEngine();
    const edit = new Rect({ width: 9, height: 9 });
    const error = await codeOf(
      engine.loadDocument(documentOf(rects(400)), {
        onProgress: (progress) => {
          if (progress.stage === 'objects' && progress.done === 100) engine.canvas.add(edit);
        },
      }),
    );
    expect(error).toBe('LOAD_CONFLICT');
    expect(engine.canvas.getObjects()).toEqual([edit]);
  });

  it('4. replaces the edit when the caller says to discard unsaved changes', async () => {
    const engine = createEngine();
    await engine.loadDocument(documentOf(rects(400)), {
      discardUnsavedChanges: true,
      onProgress: (progress) => {
        if (progress.stage === 'objects' && progress.done === 100) engine.canvas.add(new Rect());
      },
    });
    expect(engine.canvas.getObjects()).toHaveLength(400);
  });

  it('5. drops an SVG import that finishes after another document was opened', async () => {
    const engine = createEngine();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><image href="/__test-assets__/slow.png?ms=300" width="10" height="10"/></svg>`;
    const importing = codeOf(engine.importSvg(svg));
    await nextTick(30);
    await engine.loadDocument(documentOf(rects(2), { id: 'other' }));
    expect(await importing).toBe('DOCUMENT_CHANGED');
    expect(engine.canvas.getObjects()).toHaveLength(2);
    expect(engine.getHistory().undo).toEqual([]);
  });

  it('5. counts document sessions', async () => {
    const engine = createEngine();
    const first = engine.getDocumentInfo().session ?? 0;
    await engine.loadDocument(documentOf(rects(1)));
    engine.newDocument();
    expect(engine.getDocumentInfo().session).toBe(first + 2);
  });

  it('6. keeps one recovery copy per session for the same document', async () => {
    const store = createMemoryRecovery();
    const first = createEngine({ recovery: { store } });
    const second = createEngine({ recovery: { store } });
    for (const [engine, color] of [
      [first, 'red'],
      [second, 'blue'],
    ] as const) {
      engine.newDocument({ id: 'shared' });
      engine.canvas.add(new Rect({ width: 5, height: 5, fill: color }));
      await nextTick();
      await engine.flushRecovery();
    }
    const copies = await first.getRecoverableDocuments();
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((copy) => copy.sessionId)).size).toBe(2);
    expect(copies.map((copy) => copy.document.objects[0]?.fill).sort()).toEqual(['blue', 'red']);
  });

  it('7. refuses a document too large to draw before making any canvas', async () => {
    const engine = createEngine();
    const created = vi.spyOn(document, 'createElement');
    const error = await codeOf(engine.loadDocument(documentOf([], { canvas: { width: 100_000, height: 100_000 } })));
    expect(error).toBe('UNSAFE_DOCUMENT');
    expect(created.mock.calls.filter(([name]) => name === 'canvas')).toEqual([]);
  });

  it('7. refuses an export too large to draw before making any canvas', async () => {
    const engine = createEngine();
    const created = vi.spyOn(document, 'createElement');
    const error = await engine.export({ format: 'png', scale: 1000 }).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('EXPORT_BLOCKED');
    expect(isDocumentEngineError(error) && error.problems.map((problem) => problem.code)).toEqual(['TOO_LARGE']);
    expect(created.mock.calls.filter(([name]) => name === 'canvas')).toEqual([]);
  });

  it('8. rolls a failed transaction back when asked', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    const keep = new Rect({ width: 5, height: 5, fill: 'green' });
    engine.canvas.add(keep);
    await engine.save();
    engine.clearHistory();
    const failure = new Error('step two failed');
    expect(() =>
      engine.transaction(
        'Two steps',
        () => {
          engine.canvas.add(new Rect({ width: 5, height: 5 }));
          keep.set('fill', 'red');
          throw failure;
        },
        { rollback: true },
      ),
    ).toThrow(failure);
    await nextTick();
    expect(engine.canvas.getObjects()).toHaveLength(1);
    expect(engine.canvas.getObjects()[0]!.fill).toBe('green');
    expect(engine.getHistory().undo).toEqual([]);
    expect(engine.isDirty()).toBe(false);
  });

  it('5. drops a paste that finishes after another document was opened', async () => {
    const engine = createEngine();
    const clipboard = createClipboard(engine);
    // An image that takes a while to load keeps the paste running across the load.
    clipboard.write({
      format: 'fabricjs-document-engine/objects',
      version: 1,
      objects: [{ type: 'Image', src: '/__test-assets__/slow.png?ms=400', width: 1, height: 1 }],
    });
    const pasting = codeOf(clipboard.paste());
    await engine.loadDocument(documentOf(rects(1), { id: 'other' }));
    expect(await pasting).toBe('DOCUMENT_CHANGED');
    expect(engine.canvas.getObjects()).toHaveLength(1);
    expect(engine.getHistory().undo).toEqual([]);
  });

  it('5. drops an undo that was still running when another document was opened', async () => {
    // An object that takes a while to rebuild keeps the undo running across the load.
    class SlowShape extends Rect {
      static override type = 'SlowShape';
      static override async fromObject(object: Record<string, unknown>): Promise<SlowShape> {
        await nextTick(300);
        return new SlowShape(object as never);
      }
    }
    const engine = createEngine({ customObjects: [{ fabricClass: SlowShape }] });
    engine.canvas.add(new SlowShape({ width: 5, height: 5 }));
    await nextTick();
    engine.canvas.remove(engine.canvas.getObjects()[0]!);
    await nextTick();
    const undoing = engine.undo();
    await nextTick(30);
    await engine.loadDocument(documentOf(rects(3), { id: 'other' }), { discardUnsavedChanges: true });
    expect(await undoing).toBe(false);
    expect(engine.canvas.getObjects()).toHaveLength(3);
  });

  it('6. shows which recovery copies belong to sessions that are still open', async () => {
    const store = createMemoryRecovery();
    const open = createEngine({ recovery: { store } });
    open.newDocument({ id: 'shared' });
    open.canvas.add(new Rect({ width: 5, height: 5 }));
    await nextTick();
    await open.flushRecovery();
    const other = createEngine({ recovery: { store } });
    const [copy] = await other.getRecoverableDocuments();
    if ('locks' in navigator) expect(copy?.active).toBe(true);
    open.destroy();
    await nextTick(50);
    const [after] = await other.getRecoverableDocuments();
    expect(after?.active).toBe(false);
  });

  it('6. restores the copy from a chosen session, and a save removes it', async () => {
    const store = createMemoryRecovery();
    const storage = createMemoryStorage();
    const first = createEngine({ storage, recovery: { store } });
    first.newDocument({ id: 'shared' });
    first.canvas.add(new Rect({ width: 5, height: 5, fill: 'red' }));
    await nextTick();
    await first.flushRecovery();
    const sessionId = (await first.getRecovery('shared'))!.sessionId;
    first.destroy();

    const second = createEngine({ storage, recovery: { store } });
    await second.restoreRecovery('shared', { sessionId });
    expect(second.canvas.getObjects()[0]?.fill).toBe('red');
    await second.save();
    expect(await second.getRecoverableDocuments()).toEqual([]);
  });

  it('7. refuses images larger than the decoded pixel limit', async () => {
    const engine = createEngine({ limits: { maxImagePixels: 0 } });
    const error = await engine
      .loadDocument(documentOf([{ type: 'Image', id: 'i', src: pixel, width: 1, height: 1 }]))
      .catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.missingAssets[0]?.failure?.reason).toBe('TOO_LARGE');
  });

  it('7. refuses documents longer than the limit, and pages resized past it', async () => {
    const engine = createEngine({ limits: { maxDocumentLength: 100 } });
    expect(await codeOf(engine.loadDocument(documentOf(rects(20))))).toBe('UNSAFE_DOCUMENT');
    expect(() => engine.setPage({ width: 50_000 })).toThrow(expect.objectContaining({ code: 'UNSAFE_DOCUMENT' }));
    expect(engine.canvas.getWidth()).toBe(300);
  });

  it('7. draws a huge PDF page at a lower resolution instead of failing', async () => {
    const engine = createEngine({}, { width: 300, height: 200 });
    engine.canvas.add(new Rect({ width: 50, height: 50, fill: 'teal' }));
    const { blob } = await exportPdf(engine, { mode: 'raster', dpi: 1200, limits: { maxCanvasPixels: 250_000 } });
    expect((await readPdf(blob)).pages).toHaveLength(1);
  });

  it('8. rolls back an async transaction before rejecting', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 5, height: 5, fill: 'green' }));
    await nextTick();
    engine.clearHistory();
    const error = await engine
      .transaction(
        'Async',
        async () => {
          engine.canvas.add(new Rect({ width: 5, height: 5 }));
          await nextTick();
          engine.setPage({ width: 500 });
          throw new Error('late failure');
        },
        { rollback: true },
      )
      .catch((reason: unknown) => reason);
    expect((error as Error).message).toBe('late failure');
    expect(engine.canvas.getObjects()).toHaveLength(1);
    expect(engine.canvas.getWidth()).toBe(300);
    expect(engine.getHistory().undo).toEqual([]);
  });

  it('8. keeps partial changes without rollback, as one undo step', async () => {
    const engine = createEngine();
    expect(() =>
      engine.transaction('Partial', () => {
        engine.canvas.add(new Rect({ width: 5, height: 5 }));
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(engine.canvas.getObjects()).toHaveLength(1);
    expect(engine.getHistory().undo).toEqual(['Partial']);
  });
});
