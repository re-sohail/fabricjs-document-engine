import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Circle, Group, Rect, Textbox } from 'fabric';
import { createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, DocumentEngineOptions, DocumentStorage, FabricDocument } from '../src';

class Sticker extends Rect {
  static override type = 'Sticker';
  declare label: string;
  declare tags: string[];

  constructor(options: ConstructorParameters<typeof Rect>[0] & { label?: string; tags?: string[] } = {}) {
    super(options);
  }
}

class Callout extends Textbox {
  static override type = 'Callout';
  declare tone: string;

  constructor(text: string, options: ConstructorParameters<typeof Textbox>[1] & { tone?: string } = {}) {
    super(text, options);
  }
}

const customObjects = [
  { fabricClass: Sticker, properties: ['label', 'tags'] },
  { fabricClass: Callout, properties: ['tone'] },
];

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(options: Omit<DocumentEngineOptions, 'canvas'> = {}): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 300, height: 200 });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas, customObjects, ...options });
  openEngines.push(engine);
  return engine;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function idsOf(engine: DocumentEngine): Array<string | undefined> {
  return engine.canvas.getObjects().map((object) => (object as typeof object & { id?: string }).id);
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose().catch(() => undefined)));
  document.body.innerHTML = '';
});

describe(`cancellation on Fabric ${fabric.version}`, () => {
  it('stops a running load when the engine is destroyed and leaves the canvas alone', async () => {
    const source = createEngine();
    source.canvas.add(new Rect({ width: 10, height: 10 }));
    const document = source.toDocument();
    const slowImage = new Promise<string>((resolve) => setTimeout(() => resolve('/slow.png'), 50));

    const engine = createEngine({ assets: { resolveUrl: () => slowImage } });
    document.objects.push({ type: 'Image', src: 'asset://slow', width: 4, height: 4 });
    const loading = engine.loadDocument(document).catch((reason: unknown) => reason);
    engine.destroy();
    const result = await loading;
    expect(isDocumentEngineError(result) && result.code).toBe('LOAD_ABORTED');
    expect(engine.canvas.getObjects()).toHaveLength(0);
  });

  it('cancels a save that is waiting on storage when the engine is destroyed', async () => {
    const storage: DocumentStorage = {
      loadDocument: async () => undefined,
      saveDocument: (_document, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    };
    const engine = createEngine({ storage });
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    const saving = engine.save().catch((reason: unknown) => reason);
    await nextTick();
    engine.destroy();
    const result = await saving;
    expect(isDocumentEngineError(result) && result.code).toBe('SAVE_CANCELLED');
  });

  it('refuses work after destroy with a clear error', async () => {
    const engine = createEngine();
    engine.destroy();
    expect(() => engine.toDocument()).toThrow(expect.objectContaining({ code: 'ENGINE_DESTROYED' }));
    await expect(engine.save()).rejects.toMatchObject({ code: 'ENGINE_DESTROYED' });
    await expect(engine.export({ format: 'png' })).rejects.toMatchObject({ code: 'ENGINE_DESTROYED' });
    await expect(engine.undo()).rejects.toMatchObject({ code: 'ENGINE_DESTROYED' });
  });
});

describe(`custom objects on Fabric ${fabric.version}`, () => {
  it('keeps custom objects inside groups and clip paths through save, load, undo and redo', async () => {
    const engine = createEngine();
    const sticker = new Sticker({ width: 20, height: 20, label: 'Chair', tags: ['wood', 'blue'] });
    const callout = new Callout('Note', { width: 80, tone: 'warning' });
    const clipped = new Rect({ width: 50, height: 50 });
    clipped.clipPath = new Sticker({ width: 30, height: 30, label: 'Mask', originX: 'center', originY: 'center' });
    engine.canvas.add(new Group([sticker, callout]), clipped);
    await nextTick();

    const reopened = createEngine();
    await reopened.loadDocument(JSON.parse(JSON.stringify(engine.toDocument())) as FabricDocument);
    const [group, reopenedClipped] = reopened.canvas.getObjects() as [Group, Rect];
    const [reopenedSticker, reopenedCallout] = group.getObjects() as [Sticker, Callout];
    expect(reopenedSticker).toBeInstanceOf(Sticker);
    expect(reopenedSticker.tags).toEqual(['wood', 'blue']);
    expect(reopenedCallout).toBeInstanceOf(Callout);
    expect(reopenedCallout.tone).toBe('warning');
    expect((reopenedClipped.clipPath as Sticker).label).toBe('Mask');

    reopened.transaction('Rename', () => reopenedSticker.set('label', 'Sofa'));
    await reopened.undo();
    const afterUndo = (reopened.canvas.getObjects()[0] as Group).getObjects()[0] as Sticker;
    expect(afterUndo).toBeInstanceOf(Sticker);
    expect(afterUndo.label).toBe('Chair');
    await reopened.redo();
    expect(((reopened.canvas.getObjects()[0] as Group).getObjects()[0] as Sticker).label).toBe('Sofa');
  });

  it('exports custom objects', async () => {
    const engine = createEngine();
    engine.canvas.add(new Callout('Exported note', { width: 120, tone: 'info' }), new Sticker({ width: 10, height: 10 }));
    const png = await engine.export({ format: 'png' });
    const svg = await (await engine.export({ format: 'svg' })).blob.text();
    expect(png.blob.size).toBeGreaterThan(0);
    expect(svg).toContain('Exported');
  });

  it('loads once the missing class is registered', async () => {
    const source = createEngine();
    source.canvas.add(new Sticker({ width: 10, height: 10, label: 'Lamp' }));
    const document = source.toDocument();

    const element = window.document.createElement('canvas');
    window.document.body.append(element);
    const canvas = new Canvas(element);
    openCanvases.push(canvas);
    const bare = createDocumentEngine({ canvas });
    openEngines.push(bare);
    const renamed = { ...document, objects: document.objects.map((object) => ({ ...object, type: 'LateSticker' })) };
    await expect(bare.loadDocument(renamed)).rejects.toMatchObject({ code: 'UNKNOWN_OBJECT_TYPE', unknownTypes: ['LateSticker'] });

    class LateSticker extends Sticker {
      static override type = 'LateSticker';
    }
    bare.registerObject({ fabricClass: LateSticker, properties: ['label'] });
    await bare.loadDocument(renamed);
    expect((bare.canvas.getObjects()[0] as Sticker).label).toBe('Lamp');
  });
});

describe(`imported content safety on Fabric ${fabric.version}`, () => {
  it('cannot swap an object prototype through a saved document', async () => {
    const engine = createEngine();
    const hostile = JSON.parse(
      '{"version":"6.0.0","objects":[{"type":"Rect","width":10,"height":10,"__proto__":{"polluted":true,"toObject":null}}]}',
    );
    await engine.importFabricJson(hostile);
    const [loaded] = engine.canvas.getObjects();
    expect(loaded).toBeInstanceOf(Rect);
    expect((loaded as unknown as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(() => engine.toDocument()).not.toThrow();
  });

  it('refuses script addresses before anything is loaded', async () => {
    const engine = createEngine();
    engine.canvas.add(new Circle({ radius: 5 }));
    const error = await engine
      .importFabricJson({ objects: [{ type: 'Image', src: 'javascript:alert(document.cookie)' }] })
      .catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('UNSAFE_DOCUMENT');
    expect(engine.canvas.getObjects()).toHaveLength(1);
  });

  it('checks the address that will really be fetched, after resolveUrl', async () => {
    const pixel = document.createElement('canvas');
    pixel.width = 2;
    pixel.height = 2;
    const safe = createEngine({ assets: { resolveUrl: (url) => (url === 'asset://logo' ? pixel.toDataURL() : url) } });
    await safe.importFabricJson({ objects: [{ type: 'Image', src: 'asset://logo' }] });
    expect(safe.canvas.getObjects()).toHaveLength(1);

    const tricked = createEngine({ assets: { resolveUrl: () => 'javascript:alert(1)' } });
    await expect(tricked.importFabricJson({ objects: [{ type: 'Image', src: 'asset://logo' }] })).rejects.toMatchObject({
      code: 'UNSAFE_DOCUMENT',
    });
  });

  it('applies the object limit from the options', async () => {
    const engine = createEngine({ limits: { maxObjects: 3 } });
    const objects = Array.from({ length: 4 }, () => ({ type: 'Rect', width: 1, height: 1 }));
    await expect(engine.importFabricJson({ objects })).rejects.toMatchObject({ code: 'UNSAFE_DOCUMENT' });
  });

  it('escapes text when exporting SVG', async () => {
    const engine = createEngine();
    engine.canvas.add(new Textbox('<script>alert(1)</script> & "quotes"', { width: 280 }));
    const svg = await (await engine.export({ format: 'svg' })).blob.text();
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

describe(`memory limits on Fabric ${fabric.version}`, () => {
  it('keeps undo history within its byte budget', async () => {
    const engine = createEngine({ history: { maxBytes: 200_000 } });
    const bigText = 'x'.repeat(20_000);
    for (let index = 0; index < 20; index += 1) {
      engine.canvas.add(new Textbox(`${bigText}${index}`, { width: 50 }));
      await nextTick();
    }
    const kept = engine.getHistory().undo.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(20);
    await engine.undo();
    expect(idsOf(engine)).toHaveLength(19);
  });
});
