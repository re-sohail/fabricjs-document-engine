import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Rect, Textbox } from 'fabric';
import { createDocumentEngine } from '../src';
import type { DocumentEngine } from '../src';
import { createMemoryStorage } from '../src/storage';
import { budget, checkBudgets } from './support/budgets';

const objectCount = 2000;
// Shared CI runners stall now and then, so each step is timed several times and
// the median is checked. The budgets themselves stay the same.
const samples = 5;
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

// Undo asks Fabric to redraw on the next frame. Wait for it outside the timed
// part, so Fabric's own rendering is not counted as engine time.
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose().catch(() => undefined)));
  document.body.innerHTML = '';
});

describe(`performance budgets with ${objectCount} objects on Fabric ${fabric.version}`, () => {
  it.runIf(checkBudgets)('stays well inside the published budgets', async () => {
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

    const times = { recordStep: [] as number[], undo: [] as number[], save: [] as number[] };
    for (let sample = 0; sample < samples; sample += 1) {
      // Undo and redo rebuild objects, so look the target up again each time.
      const target = engine.getObjectById(engine.toDocument().objects[objectCount / 2]!.id as string)!;
      times.recordStep.push(
        await durationOf(async () => {
          target.set({ left: target.left + 3 });
          canvas.fire('object:modified', { target, action: 'drag' } as never);
          await nextTick();
        }),
      );
      times.undo.push(await durationOf(() => engine.undo()));
      await nextFrame();
      times.save.push(await durationOf(() => engine.save()));
    }
    const saved = engine.toDocument();
    const load = await durationOf(() => engine.loadDocument(saved));

    expect(median(times.recordStep)).toBeLessThan(budget(250));
    expect(median(times.undo)).toBeLessThan(budget(250));
    expect(median(times.save)).toBeLessThan(budget(250));
    expect(load).toBeLessThan(budget(3000));
  }, 30_000);
});
