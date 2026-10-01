import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { ActiveSelection, Canvas, Rect } from 'fabric';
import type { FabricObject } from 'fabric';
import {
  bringForward,
  bringToFront,
  createDocumentEngine,
  getLayers,
  moveToIndex,
  sendBackward,
  sendToBack,
} from '../src';
import type { DocumentEngine, LayerOptions } from '../src';

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 300, height: 200 });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas });
  openEngines.push(engine);
  return engine;
}

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** An engine with objects named a, b, c... from bottom to top, and no history yet. */
async function stackOf(names: string): Promise<{ engine: DocumentEngine; byName: Record<string, FabricObject> }> {
  const engine = createEngine();
  const byName: Record<string, FabricObject> = {};
  for (const name of names) {
    const object = new Rect({ width: 5, height: 5 });
    (object as unknown as { name: string }).name = name;
    byName[name] = object;
    engine.canvas.add(object);
  }
  await nextTick();
  engine.clearHistory();
  return { engine, byName };
}

function order(engine: DocumentEngine): string {
  return engine.canvas
    .getObjects()
    .map((object) => (object as unknown as { name: string }).name)
    .join('');
}

const pinBackground: LayerOptions = {
  pinned: (object) => (object as unknown as { name: string }).name === 'a',
};

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`layer commands on Fabric ${fabric.version}`, () => {
  it('brings objects to the front and sends them to the back', async () => {
    const { engine, byName } = await stackOf('abcde');
    expect(bringToFront(engine, [byName.b!])).toBe(true);
    expect(order(engine)).toBe('acdeb');
    expect(sendToBack(engine, [byName.e!])).toBe(true);
    expect(order(engine)).toBe('eacdb');
  });

  it('keeps the relative order of several objects', async () => {
    const { engine, byName } = await stackOf('abcde');
    bringToFront(engine, [byName.d!, byName.a!]);
    expect(order(engine)).toBe('bcead');
    sendToBack(engine, [byName.e!, byName.c!]);
    expect(order(engine)).toBe('cebad');
  });

  it('moves one step at a time, and neighbours move as a block', async () => {
    const { engine, byName } = await stackOf('abcde');
    bringForward(engine, [byName.b!, byName.c!]);
    expect(order(engine)).toBe('adbce');
    sendBackward(engine, [byName.b!, byName.c!]);
    expect(order(engine)).toBe('abcde');
    bringForward(engine, [byName.a!, byName.c!]);
    expect(order(engine)).toBe('badce');
  });

  it('moves objects to an index as a block', async () => {
    const { engine, byName } = await stackOf('abcde');
    moveToIndex(engine, [byName.e!, byName.a!], 1);
    expect(order(engine)).toBe('baecd');
    moveToIndex(engine, [byName.b!], 99);
    expect(order(engine)).toBe('aecdb');
    moveToIndex(engine, [byName.d!], -5);
    expect(order(engine)).toBe('daecb');
  });

  it('records each command as one undo step and undoes it', async () => {
    const { engine, byName } = await stackOf('abcd');
    bringToFront(engine, [byName.a!, byName.b!]);
    expect(engine.getHistory().undo).toEqual(['Bring to front (2 objects)']);
    sendBackward(engine, [byName.d!]);
    expect(engine.getHistory().undo).toEqual(['Send backward', 'Bring to front (2 objects)']);
    await engine.undo();
    expect(order(engine)).toBe('cdab');
    await engine.undo();
    expect(order(engine)).toBe('abcd');
    await engine.redo();
    expect(order(engine)).toBe('cdab');
  });

  it('does nothing and records nothing when the order would not change', async () => {
    const { engine, byName } = await stackOf('abc');
    expect(bringToFront(engine, [byName.c!])).toBe(false);
    expect(sendToBack(engine, [byName.a!])).toBe(false);
    expect(bringForward(engine, [byName.c!])).toBe(false);
    expect(sendBackward(engine, [byName.a!])).toBe(false);
    expect(bringToFront(engine, [])).toBe(false);
    expect(bringToFront(engine, [new Rect()])).toBe(false);
    expect(engine.getHistory().undo).toEqual([]);
  });

  it('never moves a pinned background, and nothing passes under it', async () => {
    const { engine, byName } = await stackOf('abcd');
    expect(sendToBack(engine, [byName.d!], pinBackground)).toBe(true);
    expect(order(engine)).toBe('adbc');
    expect(sendBackward(engine, [byName.d!], pinBackground)).toBe(false);
    expect(bringToFront(engine, [byName.a!], pinBackground)).toBe(false);
    moveToIndex(engine, [byName.c!], 0, pinBackground);
    expect(order(engine)).toBe('acdb');
  });

  it('keeps a pinned top frame on top', async () => {
    const { engine, byName } = await stackOf('abcf');
    const pinFrame: LayerOptions = { pinned: (object) => object === byName.f };
    bringToFront(engine, [byName.a!], pinFrame);
    expect(order(engine)).toBe('bcaf');
    bringForward(engine, [byName.a!], pinFrame);
    expect(order(engine)).toBe('bcaf');
  });

  it('uses the current selection when no objects are given', async () => {
    const { engine, byName } = await stackOf('abcd');
    const canvas = engine.canvas as Canvas;
    canvas.setActiveObject(new ActiveSelection([byName.a!, byName.b!], { canvas }));
    bringToFront(engine);
    expect(order(engine)).toBe('cdab');
  });

  it('lists layers from top to bottom for a layers panel', async () => {
    const { engine, byName } = await stackOf('abc');
    byName.b!.set({ visible: false, selectable: false });
    const layers = getLayers(engine);
    expect(layers.map((layer) => layer.name)).toEqual(['c', 'b', 'a']);
    expect(layers.map((layer) => layer.index)).toEqual([2, 1, 0]);
    expect(layers[1]).toMatchObject({ type: 'rect', visible: false, locked: true });
    expect(layers.every((layer) => typeof layer.id === 'string')).toBe(true);
  });

  it('saves the new order', async () => {
    const { engine, byName } = await stackOf('abc');
    bringToFront(engine, [byName.a!]);
    expect(engine.toDocument().objects.map((object) => object.name)).toEqual(['b', 'c', 'a']);
    expect(engine.isDirty()).toBe(true);
  });
});
