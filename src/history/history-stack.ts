import type { SnapshotDifference, StateChange } from './snapshot';

export interface HistoryStep extends SnapshotDifference {
  label: string;
}

export interface HistoryStack {
  record(step: HistoryStep): void;
  takeUndo(): HistoryStep | undefined;
  takeRedo(): HistoryStep | undefined;
  returnUndo(step: HistoryStep): void;
  returnRedo(step: HistoryStep): void;
  undoLabels(): string[];
  redoLabels(): string[];
  usedBytes(): number;
  clear(): void;
}

export interface HistoryLimits {
  steps: number;
  bytes: number;
}

function bytesOfChange(change: StateChange): number {
  let bytes = (change.order?.length ?? 0) * 8;
  for (const [id, json] of change.objects) bytes += (id.length + (json?.length ?? 0)) * 2;
  return bytes;
}

export function estimateStepBytes(step: HistoryStep): number {
  return bytesOfChange(step.before) + bytesOfChange(step.after) + step.label.length * 2;
}

export function createHistoryStack(limits: HistoryLimits): HistoryStack {
  const undoSteps: HistoryStep[] = [];
  const redoSteps: HistoryStep[] = [];
  const sizes = new WeakMap<HistoryStep, number>();
  let totalBytes = 0;

  function sizeOf(step: HistoryStep): number {
    let size = sizes.get(step);
    if (size === undefined) {
      size = estimateStepBytes(step);
      sizes.set(step, size);
    }
    return size;
  }

  function forget(step: HistoryStep | undefined): void {
    if (step) totalBytes -= sizeOf(step);
  }

  function stayWithinLimits(): void {
    while (undoSteps.length > limits.steps) forget(undoSteps.shift());
    while (redoSteps.length > limits.steps) forget(redoSteps.shift());
    while (totalBytes > limits.bytes && undoSteps.length + redoSteps.length > 1) {
      forget(undoSteps.length > 0 ? undoSteps.shift() : redoSteps.shift());
    }
  }

  function add(steps: HistoryStep[], step: HistoryStep): void {
    steps.push(step);
    totalBytes += sizeOf(step);
    stayWithinLimits();
  }

  function take(steps: HistoryStep[]): HistoryStep | undefined {
    const step = steps.pop();
    forget(step);
    return step;
  }

  return {
    record(step) {
      redoSteps.forEach(forget);
      redoSteps.length = 0;
      add(undoSteps, step);
    },
    takeUndo: () => take(undoSteps),
    takeRedo: () => take(redoSteps),
    returnUndo: (step) => add(undoSteps, step),
    returnRedo: (step) => add(redoSteps, step),
    undoLabels: () => undoSteps.map((step) => step.label).reverse(),
    redoLabels: () => redoSteps.map((step) => step.label).reverse(),
    usedBytes: () => totalBytes,
    clear() {
      undoSteps.length = 0;
      redoSteps.length = 0;
      totalBytes = 0;
    },
  };
}
