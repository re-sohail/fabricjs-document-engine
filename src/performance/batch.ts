import type { StaticCanvas } from 'fabric';

const depths = new WeakMap<StaticCanvas, { depth: number; renderOnAddRemove: boolean }>();

export function batchCanvasUpdates<Result>(canvas: StaticCanvas, work: () => Result): Result {
  const state = depths.get(canvas) ?? { depth: 0, renderOnAddRemove: canvas.renderOnAddRemove };
  if (state.depth === 0) state.renderOnAddRemove = canvas.renderOnAddRemove;
  state.depth += 1;
  depths.set(canvas, state);
  canvas.renderOnAddRemove = false;
  const finish = (): void => {
    state.depth -= 1;
    if (state.depth > 0) return;
    depths.delete(canvas);
    canvas.renderOnAddRemove = state.renderOnAddRemove;
    canvas.requestRenderAll();
  };
  let result: Result;
  try {
    result = work();
  } catch (error) {
    finish();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(finish) as Result;
  }
  finish();
  return result;
}
