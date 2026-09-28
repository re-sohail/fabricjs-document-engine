import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Circle, FabricImage, Group, IText, Rect, Textbox, Triangle } from 'fabric';
import type { FabricObject } from 'fabric';
import { createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, DocumentStorage, FabricDocument } from '../src';

const redPixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

class Sticker extends Rect {
  static override type = 'Sticker';
  declare label: string;

  constructor(options: ConstructorParameters<typeof Rect>[0] & { label?: string } = {}) {
    super(options);
  }
}

const sticker = { fabricClass: Sticker, properties: ['label'] };
const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createCanvas(): Canvas {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 400, height: 300 });
  openCanvases.push(canvas);
  return canvas;
}

function createEngine(canvas = createCanvas(), storage?: DocumentStorage): DocumentEngine {
  const engine = createDocumentEngine({ canvas, customObjects: [sticker], ...(storage ? { storage } : {}) });
  openEngines.push(engine);
  return engine;
}

function idOf(object: FabricObject): string | undefined {
  return (object as FabricObject & { id?: string }).id;
}

function describeTree(objects: FabricObject[]): Array<{ id?: string; type: string; x: number; y: number }> {
  const rows: Array<{ id?: string; type: string; x: number; y: number }> = [];
  const pending = [...objects].reverse();
  while (pending.length > 0) {
    const object = pending.pop()!;
    const center = object.getCenterPoint();
    rows.push({ id: idOf(object), type: object.constructor.name, x: Math.round(center.x), y: Math.round(center.y) });
    if (object instanceof Group) pending.push(...[...object.getObjects()].reverse());
  }
  return rows;
}

async function buildRealisticCanvas(canvas: Canvas): Promise<void> {
  const image = await FabricImage.fromURL(redPixel);
  image.set({ left: 300, top: 40, scaleX: 20, scaleY: 20 });
  const innerGroup = new Group([
    new Circle({ radius: 10, left: 0, top: 0, fill: 'blue' }),
    new Rect({ width: 20, height: 20, left: 30, top: 0, fill: 'green' }),
  ]);
  const outerGroup = new Group([innerGroup, new Triangle({ width: 30, height: 30, left: 0, top: 40 })], {
    left: 150,
    top: 150,
  });
  const clippedRect = new Rect({ width: 80, height: 60, left: 20, top: 200, fill: 'orange' });
  clippedRect.clipPath = new Circle({ radius: 25, originX: 'center', originY: 'center' });
  canvas.add(
    new Rect({ width: 50, height: 40, left: 10, top: 10, fill: 'red', angle: 15 }),
    new IText('Editable title', { left: 100, top: 20, fontSize: 20 }),
    new Textbox('A wrapping paragraph of text', { left: 100, top: 60, width: 120 }),
    image,
    outerGroup,
    clippedRect,
    new Sticker({ width: 30, height: 30, left: 330, top: 220, fill: 'purple', label: 'Chair' }),
  );
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`round trip on Fabric ${fabric.version}`, () => {
  it('reopens a realistic document as editable objects with the same identity', async () => {
    const firstEngine = createEngine();
    await buildRealisticCanvas(firstEngine.canvas as Canvas);
    firstEngine.updateMetadata({ title: 'Living room' });
    const before = describeTree(firstEngine.canvas.getObjects());
    const saved: FabricDocument = JSON.parse(JSON.stringify(firstEngine.toDocument()));

    expect(before.every((row) => typeof row.id === 'string')).toBe(true);
    expect(new Set(before.map((row) => row.id)).size).toBe(before.length);

    const secondEngine = createEngine();
    await secondEngine.loadDocument(saved);
    const after = describeTree(secondEngine.canvas.getObjects());

    expect(after).toEqual(before);
    expect(secondEngine.getDocumentInfo()).toMatchObject({ id: saved.id, metadata: { title: 'Living room' } });

    const objects = secondEngine.canvas.getObjects();
    expect(objects[1]).toBeInstanceOf(IText);
    expect(objects[2]).toBeInstanceOf(Textbox);
    expect(objects[3]).toBeInstanceOf(FabricImage);
    expect(objects[5]?.clipPath).toBeInstanceOf(Circle);
    const loadedSticker = objects[6];
    expect(loadedSticker).toBeInstanceOf(Sticker);
    expect((loadedSticker as Sticker).label).toBe('Chair');
    expect(objects.every((object) => object.selectable && object.evented)).toBe(true);
  });

  it('finds objects by id, including children of groups', async () => {
    const engine = createEngine();
    await buildRealisticCanvas(engine.canvas as Canvas);
    const group = engine.canvas.getObjects()[4] as Group;
    const nested = (group.getObjects()[0] as Group).getObjects()[1]!;
    expect(engine.getObjectById(idOf(nested)!)).toBe(nested);
  });

  it('gives new and later grouped objects an id', () => {
    const engine = createEngine();
    const first = new Rect({ width: 10, height: 10 });
    const second = new Rect({ width: 10, height: 10 });
    engine.canvas.add(first, second);
    const firstId = idOf(first);
    engine.canvas.remove(first, second);
    const group = new Group([first, second]);
    engine.canvas.add(group);
    expect(idOf(group)).toBeTypeOf('string');
    expect(idOf(first)).toBe(firstId);
    expect(engine.getObjectById(firstId!)).toBe(first);
  });

  it('keeps positions when the canvas omits default values', async () => {
    const engine = createEngine();
    engine.canvas.includeDefaultValues = false;
    engine.canvas.add(new Rect({ width: 40, height: 40, left: 60, top: 70 }));
    const saved = engine.toDocument();
    expect(saved.objects[0]?.originX).toBeDefined();
    expect(saved.objects[0]?.originY).toBeDefined();
    const before = engine.canvas.getObjects()[0]!.getCenterPoint();

    const other = createEngine();
    await other.loadDocument(saved);
    const after = other.canvas.getObjects()[0]!.getCenterPoint();
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
  });

  it('refuses unknown object types and leaves the canvas untouched', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    const document = engine.toDocument();
    document.objects.push({ type: 'Hologram' });

    const error = await engine.loadDocument(document).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('UNKNOWN_OBJECT_TYPE');
    expect(isDocumentEngineError(error) && error.unknownTypes).toEqual(['Hologram']);
    expect(engine.canvas.getObjects()).toHaveLength(1);
  });

  it('reports invalid documents with the path of the problem', async () => {
    const engine = createEngine();
    const error = await engine.loadDocument({ schemaVersion: 1 }).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('INVALID_DOCUMENT');
    expect(isDocumentEngineError(error) && error.issues.map((issue) => issue.path)).toContain('canvas');
  });

  it('turns a broken image into a load error without clearing the canvas', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    const document = engine.toDocument();
    document.objects.push({ type: 'Image', src: '/definitely-missing-image.png', width: 10, height: 10 });

    const error = await engine.loadDocument(document).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('MISSING_ASSETS');
    expect(engine.canvas.getObjects()).toHaveLength(1);
  });

  it('refuses to load a group that silently lost a child even when image checks are off', async () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element, { width: 100, height: 100 });
    openCanvases.push(canvas);
    const engine = createDocumentEngine({ canvas, assets: { checkImages: false } });
    openEngines.push(engine);
    engine.canvas.add(new Group([new Rect({ width: 10, height: 10 })]));
    const saved = engine.toDocument();
    saved.objects[0]!.objects!.push({ type: 'Image', src: '/missing-inside-group.png', width: 10, height: 10 });

    const error = await engine.loadDocument(saved).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('LOAD_FAILED');
    expect(engine.canvas.getObjects()).toHaveLength(1);
    expect((engine.canvas.getObjects()[0] as Group).getObjects()).toHaveLength(1);
  });

  it('lets the newest load win when loads overlap', async () => {
    const source = createEngine();
    await buildRealisticCanvas(source.canvas as Canvas);
    const slowDocument = source.toDocument();
    source.newDocument();
    source.canvas.add(new Circle({ radius: 5 }));
    const quickDocument = source.toDocument();

    const engine = createEngine();
    const olderLoad = engine.loadDocument(slowDocument).catch((reason: unknown) => reason);
    const newerLoad = engine.loadDocument(quickDocument);
    const [olderResult] = await Promise.all([olderLoad, newerLoad]);

    expect(isDocumentEngineError(olderResult) && olderResult.code).toBe('LOAD_ABORTED');
    expect(engine.getDocumentInfo().id).toBe(quickDocument.id);
    expect(engine.canvas.getObjects().map(idOf)).toEqual(quickDocument.objects.map((object) => object.id));
  });

  it('saves to and loads from a storage adapter', async () => {
    const records = new Map<string, FabricDocument>();
    const storage: DocumentStorage = {
      loadDocument: async (id) => structuredClone(records.get(id)),
      saveDocument: async (document) => {
        records.set(document.id, structuredClone(document));
      },
    };
    const engine = createEngine(createCanvas(), storage);
    engine.canvas.add(new Sticker({ width: 20, height: 20, label: 'Lamp' }));
    const saved = await engine.save();

    const reopened = createEngine(createCanvas(), storage);
    await reopened.load(saved.id);
    expect((reopened.canvas.getObjects()[0] as Sticker).label).toBe('Lamp');
    expect(idOf(reopened.canvas.getObjects()[0]!)).toBe(saved.objects[0]?.id);
  });

  it('explains when storage is missing', async () => {
    const engine = createEngine();
    const error = await engine.save().catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('STORAGE_MISSING');
  });
});
