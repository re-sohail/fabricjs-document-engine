import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Rect, Textbox } from 'fabric';
import { createDocumentEngine } from '../src';
import type { DocumentEngine } from '../src';
import { createMemoryStorage } from '../src/storage';

const objectCount = 2000;
const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function durationOf(work: () => unknown): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose().catch(() => undefined)));
  document.body.innerHTML = '';
});

describe(`performance budgets with ${objectCount} objects on Fabric ${fabric.version}`, () => {
  it('stays well inside the published budgets', async () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element, { width: 1000, height: 800, renderOnAddRemove: false });
    openCanvases.push(canvas);
    const engine = createDocumentEngine({ canvas, storage: createMemoryStorage() });
    openEngines.push(engine);
    const objects = Array.from({ length: objectCount }, (_, index) =>
      index % 10 === 0
        ? new Textbox(`Label ${index}`, { left: index % 900, top: index % 700, width: 60 })
        : new Rect({ left: index % 900, top: index % 700, width: 10, height: 10 }),
    );
    canvas.add(...objects);
    await nextTick();

    const target = objects[objectCount / 2]!;
    const recordStep = await durationOf(async () => {
      target.set({ left: target.left + 3 });
      canvas.fire('object:modified', { target, action: 'drag' } as never);
      await nextTick();
    });
    const undo = await durationOf(() => engine.undo());
    const save = await durationOf(() => engine.save());
    const saved = engine.toDocument();
    const load = await durationOf(() => engine.loadDocument(saved));

    expect(recordStep).toBeLessThan(250);
    expect(undo).toBeLessThan(250);
    expect(save).toBeLessThan(250);
    expect(load).toBeLessThan(3000);
  }, 30_000);
});
