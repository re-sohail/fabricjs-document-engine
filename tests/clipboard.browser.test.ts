import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { ActiveSelection, Canvas, Circle, Group, Rect } from 'fabric';
import type { FabricObject } from 'fabric';
import { CLIPBOARD_FORMAT, createClipboard, createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, DocumentEngineOptions } from '../src';

class Sticker extends Rect {
  static override type = 'Sticker';
  declare label: string;

  constructor(options: ConstructorParameters<typeof Rect>[0] & { label?: string } = {}) {
    super(options);
  }
}

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(options: Omit<DocumentEngineOptions, 'canvas'> = {}): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 400, height: 300 });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({
    canvas,
    customObjects: [{ fabricClass: Sticker, properties: ['label'] }],
    ...options,
  });
  openEngines.push(engine);
  return engine;
}

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function idOf(object: FabricObject | undefined): string | undefined {
  return (object as unknown as { id?: string } | undefined)?.id;
}

function allIds(engine: DocumentEngine): string[] {
  const ids: string[] = [];
  const visit = (object: FabricObject): void => {
    ids.push(idOf(object)!);
    if (object instanceof Group) object.getObjects().forEach(visit);
  };
  engine.canvas.getObjects().forEach(visit);
  return ids;
}

function boundsOf(object: FabricObject): { left: number; top: number; width: number; height: number } {
  const { left, top, width, height } = object.getBoundingRect();
  return { left, top, width, height };
}

// Fabric writes numbers with 4 decimal places when it serializes, so a copy
// matches its original to a few thousandths of a pixel, as a saved document does.
function expectCloseBounds(actual: ReturnType<typeof boundsOf>, expected: ReturnType<typeof boundsOf>, shift = 0): void {
  expect(actual.left).toBeCloseTo(expected.left + shift, 2);
  expect(actual.top).toBeCloseTo(expected.top + shift, 2);
  expect(actual.width).toBeCloseTo(expected.width, 2);
  expect(actual.height).toBeCloseTo(expected.height, 2);
}

function nestedGroup(): Group {
  const inner = new Group(
    [
      new Rect({ left: 10, top: 10, width: 20, height: 10, fill: 'red', angle: 15 }),
      new Circle({ left: 40, top: 5, radius: 6, fill: 'blue', scaleX: 1.5 }),
    ],
    { angle: -20, scaleX: 1.2 },
  );
  return new Group([inner, new Rect({ left: 0, top: 60, width: 30, height: 8, fill: 'green', skewX: 10 })], {
    left: 120,
    top: 80,
    angle: 30,
    scaleX: 0.8,
    scaleY: 1.4,
    flipX: true,
  });
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`clipboard on Fabric ${fabric.version}`, () => {
  it('pastes a copy next to the original with a new id, as one undo step', async () => {
    const engine = createEngine();
    const rect = new Rect({ left: 20, top: 30, width: 10, height: 10 });
    engine.canvas.add(rect);
    await nextTick();
    const clipboard = createClipboard(engine);

    expect(clipboard.copy([rect])).toBe(1);
    const [pasted] = await clipboard.paste();
    expect(pasted).toBeDefined();
    expect(idOf(pasted)).not.toBe(idOf(rect));
    expectCloseBounds(boundsOf(pasted!), boundsOf(rect), 10);
    expect(engine.getHistory().undo[0]).toBe('Paste');

    await engine.undo();
    expect(engine.canvas.getObjects()).toHaveLength(1);
    expect(idOf(engine.canvas.getObjects()[0])).toBe(idOf(rect));
  });

  it('moves each paste a little further and never reuses an id', async () => {
    const engine = createEngine();
    const rect = new Rect({ left: 20, top: 30, width: 10, height: 10 });
    engine.canvas.add(rect);
    const clipboard = createClipboard(engine, { offset: 7 });
    clipboard.copy([rect]);
    const lefts: number[] = [];
    for (let paste = 0; paste < 4; paste += 1) lefts.push(boundsOf((await clipboard.paste())[0]!).left);
    expect(lefts.map((left) => Math.round(left - boundsOf(rect).left))).toEqual([7, 14, 21, 28]);
    const ids = allIds(engine);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the exact shape of nested, rotated, scaled, skewed and flipped groups', async () => {
    const engine = createEngine();
    const group = nestedGroup();
    engine.canvas.add(group);
    const clipboard = createClipboard(engine);
    clipboard.copy([group]);
    const [pasted] = await clipboard.paste({ offset: 0 });
    const original = group.getObjects();
    const copy = (pasted as Group).getObjects();

    expectCloseBounds(boundsOf(pasted!), boundsOf(group));
    const pairs: Array<[FabricObject, FabricObject]> = [];
    const collect = (first: FabricObject, second: FabricObject): void => {
      pairs.push([first, second]);
      if (first instanceof Group && second instanceof Group) {
        first.getObjects().forEach((child, index) => collect(child, second.getObjects()[index]!));
      }
    };
    original.forEach((child, index) => collect(child, copy[index]!));
    expect(pairs).toHaveLength(4);
    for (const [first, second] of pairs) {
      const expected = first.calcTransformMatrix();
      second.calcTransformMatrix().forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 3));
      expect(idOf(second)).not.toBe(idOf(first));
    }
    const ids = allIds(engine);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('copies objects from a moved, scaled and rotated selection where they appear', async () => {
    const engine = createEngine();
    const first = new Rect({ left: 40, top: 40, width: 30, height: 20, angle: 10 });
    const second = new Circle({ left: 120, top: 60, radius: 15 });
    engine.canvas.add(first, second);
    const selection = new ActiveSelection([first, second], { canvas: engine.canvas as Canvas });
    (engine.canvas as Canvas).setActiveObject(selection);
    selection.set({ left: selection.left + 25, top: selection.top - 10, angle: 20, scaleX: 1.5 });
    selection.setCoords();
    // Compare the full transform: Fabric measures the bounding box of a skewed
    // object on its own differently from the same object inside a selection.
    const expected = [first.calcTransformMatrix(), second.calcTransformMatrix()];

    const clipboard = createClipboard(engine);
    expect(clipboard.copy()).toBe(2);
    const pasted = await clipboard.paste({ offset: 0 });
    expect(pasted).toHaveLength(2);
    pasted.forEach((object, index) =>
      object.calcTransformMatrix().forEach((value, cell) => expect(value).toBeCloseTo(expected[index]![cell]!, 3)),
    );
  });

  it('keeps custom properties and gives clip paths no copied id', async () => {
    const engine = createEngine();
    const sticker = new Sticker({ width: 10, height: 10, label: 'Sale' });
    const clipped = new Rect({ width: 40, height: 40 });
    clipped.clipPath = new Circle({ radius: 10 });
    (clipped.clipPath as unknown as { id: string }).id = 'clip-original';
    engine.canvas.add(sticker, clipped);
    const clipboard = createClipboard(engine);
    clipboard.copy([sticker, clipped]);
    const [pastedSticker, pastedClipped] = await clipboard.paste();

    expect(pastedSticker).toBeInstanceOf(Sticker);
    expect((pastedSticker as Sticker).label).toBe('Sale');
    expect(pastedClipped!.clipPath).toBeDefined();
    expect(idOf(pastedClipped!.clipPath as FabricObject | undefined)).toBeUndefined();
  });

  it('pastes in stacking order and selects what it pasted', async () => {
    const engine = createEngine();
    const bottom = new Rect({ width: 5, height: 5, fill: 'red' });
    const top = new Rect({ width: 5, height: 5, fill: 'blue' });
    engine.canvas.add(bottom, top);
    const clipboard = createClipboard(engine);
    clipboard.copy([top, bottom]);
    const pasted = await clipboard.paste();
    expect(pasted.map((object) => object.fill)).toEqual(['red', 'blue']);
    expect((engine.canvas as Canvas).getActiveObjects()).toEqual(pasted);
  });

  it('cuts as one undo step and pastes the first copy in place', async () => {
    const engine = createEngine();
    const rect = new Rect({ left: 50, top: 50, width: 10, height: 10 });
    const keep = new Rect({ width: 5, height: 5 });
    engine.canvas.add(rect, keep);
    await nextTick();
    const before = boundsOf(rect);
    const clipboard = createClipboard(engine);

    expect(clipboard.cut([rect])).toBe(1);
    expect(engine.canvas.getObjects()).toEqual([keep]);
    expect(engine.getHistory().undo[0]).toBe('Cut');
    const [first] = await clipboard.paste();
    expectCloseBounds(boundsOf(first!), before);
    const [second] = await clipboard.paste();
    expectCloseBounds(boundsOf(second!), before, 10);

    await engine.undo();
    await engine.undo();
    await engine.undo();
    expect(allIds(engine)).toEqual([idOf(rect), idOf(keep)]);
  });

  it('pastes into another document without touching the first', async () => {
    const source = createEngine();
    const target = createEngine();
    const sticker = new Sticker({ width: 10, height: 10, label: 'Moved' });
    source.canvas.add(sticker);
    await nextTick();
    const sourceHistory = source.getHistory();
    const clipboard = createClipboard(source);
    clipboard.copy([sticker]);

    const [pasted] = await clipboard.paste({ target });
    expect(target.canvas.getObjects()).toEqual([pasted]);
    expect(target.getHistory().undo).toEqual(['Paste']);
    expect(source.getHistory()).toEqual(sourceHistory);
    expect(target.toDocument().objects[0]).toMatchObject({ type: 'Sticker', label: 'Moved', id: idOf(pasted) });
  });

  it('copies nothing when nothing is chosen', async () => {
    const engine = createEngine();
    const clipboard = createClipboard(engine);
    expect(clipboard.copy()).toBe(0);
    expect(clipboard.cut()).toBe(0);
    expect(clipboard.hasContent()).toBe(false);
    expect(await clipboard.paste()).toEqual([]);
    expect(engine.getHistory().undo).toEqual([]);
  });

  it('reads and writes plain JSON, for example from another tab', async () => {
    const source = createEngine();
    const rect = new Rect({ width: 10, height: 10, fill: 'orange' });
    source.canvas.add(rect);
    const first = createClipboard(source);
    first.copy([rect]);
    const content = JSON.parse(JSON.stringify(first.read()));
    expect(content.format).toBe(CLIPBOARD_FORMAT);

    const target = createEngine();
    const second = createClipboard(target);
    second.write(content);
    const [pasted] = await second.paste();
    expect(pasted!.fill).toBe('orange');
  });

  it('refuses clipboard content that is not valid or not safe', () => {
    const clipboard = createClipboard(createEngine());
    const codeOf = (content: unknown): unknown => {
      try {
        clipboard.write(content);
        return undefined;
      } catch (error) {
        return isDocumentEngineError(error) ? error.code : error;
      }
    };
    expect(codeOf('text')).toBe('INVALID_DOCUMENT');
    expect(codeOf({ format: 'other', version: 1, objects: [] })).toBe('INVALID_DOCUMENT');
    expect(codeOf({ format: CLIPBOARD_FORMAT, version: 2, objects: [] })).toBe('INVALID_DOCUMENT');
    expect(codeOf({ format: CLIPBOARD_FORMAT, version: 1, objects: [{ left: 1 }] })).toBe('INVALID_DOCUMENT');
    expect(
      codeOf({ format: CLIPBOARD_FORMAT, version: 1, objects: [{ type: 'Image', src: 'javascript:alert(1)' }] }),
    ).toBe('UNSAFE_DOCUMENT');
    expect(clipboard.hasContent()).toBe(false);
  });

  it('drops prototype keys from written content', async () => {
    const engine = createEngine();
    const clipboard = createClipboard(engine);
    clipboard.write(
      JSON.parse(`{"format":"${CLIPBOARD_FORMAT}","version":1,"objects":[{"type":"Rect","width":4,"height":4,"__proto__":{"polluted":true}}]}`),
    );
    await clipboard.paste();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(JSON.stringify(clipboard.read())).not.toContain('polluted');
  });

  it('refuses to paste object types that are not registered', async () => {
    const clipboard = createClipboard(createEngine());
    clipboard.write({ format: CLIPBOARD_FORMAT, version: 1, objects: [{ type: 'NotRegisteredAnywhere' }] });
    const error = await clipboard.paste().catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('UNKNOWN_OBJECT_TYPE');
    expect(isDocumentEngineError(error) && error.unknownTypes).toEqual(['NotRegisteredAnywhere']);
  });
});
