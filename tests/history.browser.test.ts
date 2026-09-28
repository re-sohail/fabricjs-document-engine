import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Circle, FabricImage, Group, IText, Rect } from 'fabric';
import type { FabricObject } from 'fabric';
import { bindKeyboardShortcuts, createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, HistoryOptions } from '../src';

class Sticker extends Rect {
  static override type = 'Sticker';
  declare label: string;

  constructor(options: ConstructorParameters<typeof Rect>[0] & { label?: string } = {}) {
    super(options);
  }
}

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(history?: HistoryOptions): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 400, height: 300 });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({
    canvas,
    customObjects: [{ fabricClass: Sticker, properties: ['label'] }],
    ...(history ? { history } : {}),
  });
  openEngines.push(engine);
  return engine;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function idOf(object: FabricObject | undefined): string | undefined {
  return (object as (FabricObject & { id?: string }) | undefined)?.id;
}

function idsOn(engine: DocumentEngine): Array<string | undefined> {
  return engine.canvas.getObjects().map(idOf);
}

function objectsOf(engine: DocumentEngine): FabricObject[] {
  return engine.canvas.getObjects();
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`history on Fabric ${fabric.version}`, () => {
  it('starts with nothing to undo', () => {
    const engine = createEngine();
    expect(engine.canUndo()).toBe(false);
    expect(engine.canRedo()).toBe(false);
  });

  it('undoes and redoes adding an object while keeping its id', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    const id = idOf(objectsOf(engine)[0]);
    expect(engine.getHistory().undo).toEqual(['Add rect']);

    await engine.undo();
    expect(objectsOf(engine)).toHaveLength(0);
    expect(engine.canRedo()).toBe(true);

    await engine.redo();
    expect(idsOn(engine)).toEqual([id]);
    expect(engine.getObjectById(id!)).toBe(objectsOf(engine)[0]);
  });

  it('treats deleting several objects in one call as one step', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 10, height: 10 }), new Circle({ radius: 5 }), new Rect({ width: 5, height: 5 }));
    await nextTick();
    const idsBefore = idsOn(engine);
    engine.canvas.remove(...objectsOf(engine).slice(0, 2));
    await nextTick();
    expect(engine.getHistory().undo[0]).toBe('Delete 2 objects');

    await engine.undo();
    expect(idsOn(engine)).toEqual(idsBefore);
  });

  it('records a pointer transform when Fabric reports object:modified', async () => {
    const engine = createEngine();
    const rect = new Rect({ width: 10, height: 10, left: 20, top: 20 });
    engine.canvas.add(rect);
    await nextTick();
    rect.set({ left: 120, top: 80 });
    engine.canvas.fire('object:modified', { target: rect, action: 'drag' } as never);
    await nextTick();
    expect(engine.getHistory().undo[0]).toBe('Move rect');

    await engine.undo();
    expect(objectsOf(engine)[0]!.left).toBe(20);
    await engine.redo();
    expect(objectsOf(engine)[0]!.left).toBe(120);
  });

  it('turns a transaction of style and order changes into one undo step', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 10, height: 10, fill: 'red' }), new Rect({ width: 10, height: 10, fill: 'blue' }));
    await nextTick();
    const [first, second] = objectsOf(engine);
    const orderBefore = idsOn(engine);

    engine.transaction('Restyle and reorder', () => {
      first!.set('fill', 'green');
      second!.set('fill', 'yellow');
      engine.canvas.moveObjectTo(second!, 0);
    });
    expect(engine.getHistory().undo[0]).toBe('Restyle and reorder');
    const orderAfter = idsOn(engine);

    await engine.undo();
    expect(idsOn(engine)).toEqual(orderBefore);
    expect(objectsOf(engine).map((object) => object.fill)).toEqual(['red', 'blue']);

    await engine.redo();
    expect(idsOn(engine)).toEqual(orderAfter);
    expect(objectsOf(engine).map((object) => object.fill)).toEqual(['yellow', 'green']);
  });

  it('merges nested transactions into the outermost one', async () => {
    const engine = createEngine();
    engine.transaction('Outer', () => {
      engine.canvas.add(new Rect({ width: 10, height: 10 }));
      engine.transaction('Inner', () => engine.canvas.add(new Circle({ radius: 4 })));
    });
    await nextTick();
    expect(engine.getHistory().undo).toEqual(['Outer']);
    await engine.undo();
    expect(objectsOf(engine)).toHaveLength(0);
  });

  it('waits for async transactions before recording', async () => {
    const engine = createEngine();
    await engine.transaction('Add later', async () => {
      await nextTick();
      engine.canvas.add(new Rect({ width: 10, height: 10 }));
    });
    expect(engine.getHistory().undo).toEqual(['Add later']);
  });

  it('undoes grouping and ungrouping with the original ids', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 10, height: 10, left: 10 }), new Circle({ radius: 5, left: 60 }));
    await nextTick();
    const originalIds = idsOn(engine);

    engine.transaction('Group objects', () => {
      const members = objectsOf(engine);
      engine.canvas.remove(...members);
      engine.canvas.add(new Group(members));
    });
    expect(objectsOf(engine)).toHaveLength(1);

    await engine.undo();
    expect(idsOn(engine)).toEqual(originalIds);

    await engine.redo();
    const group = objectsOf(engine)[0] as Group;
    expect(group).toBeInstanceOf(Group);
    expect(group.getObjects().map(idOf)).toEqual(originalIds);

    engine.transaction('Ungroup', () => {
      const members = group.removeAll();
      engine.canvas.remove(group);
      engine.canvas.add(...members);
    });
    await engine.undo();
    expect(objectsOf(engine)[0]).toBeInstanceOf(Group);
  });

  it('keeps custom objects and text as their own classes after undo', async () => {
    const engine = createEngine();
    engine.canvas.add(new Sticker({ width: 10, height: 10, label: 'Chair' }), new IText('Hello'));
    await nextTick();
    engine.transaction('Change', () => {
      objectsOf(engine).forEach((object) => object.set('opacity', 0.5));
    });
    await engine.undo();
    expect(objectsOf(engine)[0]).toBeInstanceOf(Sticker);
    expect((objectsOf(engine)[0] as Sticker).label).toBe('Chair');
    expect(objectsOf(engine)[1]).toBeInstanceOf(IText);
    expect(objectsOf(engine).map((object) => object.opacity)).toEqual([1, 1]);
  });

  it('ignores commits where nothing changed', () => {
    const engine = createEngine();
    expect(engine.commit('Nothing')).toBe(false);
    expect(engine.canUndo()).toBe(false);
  });

  it('respects the history limit', async () => {
    const engine = createEngine({ limit: 2 });
    for (let index = 0; index < 4; index += 1) {
      engine.canvas.add(new Rect({ width: 10, height: 10 }));
      await nextTick();
    }
    expect(engine.getHistory().undo).toHaveLength(2);
  });

  it('clears redo after a new change', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    await engine.undo();
    engine.canvas.add(new Circle({ radius: 3 }));
    await nextTick();
    expect(engine.canRedo()).toBe(false);
  });

  it('runs overlapping undo calls one after another', async () => {
    const engine = createEngine();
    for (let index = 0; index < 3; index += 1) {
      engine.canvas.add(new Rect({ width: 10, height: 10 }));
      await nextTick();
    }
    await Promise.all([engine.undo(), engine.undo(), engine.undo()]);
    expect(objectsOf(engine)).toHaveLength(0);
    expect(engine.getHistory().redo).toHaveLength(3);
  });

  it('starts a fresh history after loading a document', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    const saved = engine.toDocument();
    await engine.loadDocument(saved);
    await nextTick();
    expect(engine.canUndo()).toBe(false);
  });

  it('emits history:change with labels', async () => {
    const engine = createEngine();
    const listener = vi.fn();
    engine.on('history:change', listener);
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    expect(listener).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false, undoLabel: 'Add rect', redoLabel: undefined });
  });

  it('keeps the step and reports an error when undo cannot rebuild an object', async () => {
    const engine = createEngine();
    const missingPicture = new Image();
    missingPicture.src = '/missing-picture.png';
    engine.canvas.add(new FabricImage(missingPicture, { width: 10, height: 10 }));
    await nextTick();
    engine.canvas.remove(objectsOf(engine)[0]!);
    await nextTick();

    const errors = vi.fn();
    engine.on('history:error', errors);
    const error = await engine.undo().catch((reason: unknown) => reason);

    expect(isDocumentEngineError(error) && error.code).toBe('HISTORY_FAILED');
    expect(errors).toHaveBeenCalledOnce();
    expect(engine.getHistory().undo[0]).toBe('Delete image');
    expect(objectsOf(engine)).toHaveLength(0);
  });

  it('binds keyboard shortcuts and ignores typing in inputs', async () => {
    const engine = createEngine();
    const undo = vi.spyOn(engine, 'undo');
    const redo = vi.spyOn(engine, 'redo');
    const unbind = bindKeyboardShortcuts(engine);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', metaKey: true, shiftKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    unbind();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));

    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(2);
  });
});
