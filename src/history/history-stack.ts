import type { SnapshotDifference } from './snapshot';

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
  clear(): void;
}

export function createHistoryStack(limit: number): HistoryStack {
  const undoSteps: HistoryStep[] = [];
  const redoSteps: HistoryStep[] = [];

  function pushWithinLimit(steps: HistoryStep[], step: HistoryStep): void {
    steps.push(step);
    if (steps.length > limit) steps.shift();
  }

  return {
    record(step) {
      pushWithinLimit(undoSteps, step);
      redoSteps.length = 0;
    },
    takeUndo: () => undoSteps.pop(),
    takeRedo: () => redoSteps.pop(),
    returnUndo: (step) => pushWithinLimit(undoSteps, step),
    returnRedo: (step) => pushWithinLimit(redoSteps, step),
    undoLabels: () => undoSteps.map((step) => step.label).reverse(),
    redoLabels: () => redoSteps.map((step) => step.label).reverse(),
    clear() {
      undoSteps.length = 0;
      redoSteps.length = 0;
    },
  };
}
