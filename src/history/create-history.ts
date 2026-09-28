import type { FabricObject, StaticCanvas } from 'fabric';
import type { SerializedFabricObject } from '../document/document-format';
import { applyStateChange } from './apply-state';
import { createHistoryStack } from './history-stack';
import type { HistoryStep } from './history-stack';
import { createSnapshot, diffSnapshots } from './snapshot';
import type { StateChange } from './snapshot';

export interface HistoryOptions {
  limit?: number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
}

export interface HistoryController {
  commit(label: string): boolean;
  transaction<Result>(label: string, work: () => Result): Result;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  state(): HistoryState;
  labels(): { undo: string[]; redo: string[] };
  withoutRecording<Result>(work: () => Result): Result;
  reset(): void;
  destroy(): void;
}

interface HistoryControllerOptions extends HistoryOptions {
  canvas: StaticCanvas;
  serializeObjects: () => SerializedFabricObject[];
  onChange: (state: HistoryState) => void;
}

interface PendingChange {
  verb: string;
  noun: string;
}

interface ObjectEvent {
  target: FabricObject;
}

interface ModifiedEvent extends ObjectEvent {
  action?: string;
  transform?: { action?: string };
}

const verbsByAction: Record<string, string> = {
  drag: 'Move',
  rotate: 'Rotate',
  scale: 'Resize',
  scaleX: 'Resize',
  scaleY: 'Resize',
  resizing: 'Resize',
  skewX: 'Skew',
  skewY: 'Skew',
};

function nameOf(object: FabricObject): string {
  const type = (object.constructor as { type?: string }).type ?? object.type;
  return type.toLowerCase();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

export function describePendingChanges(changes: readonly PendingChange[]): string {
  const verbs = new Set(changes.map((change) => change.verb));
  if (verbs.size > 1) return 'Edit objects';
  const verb = changes[0]?.verb ?? 'Edit';
  return changes.length === 1 ? `${verb} ${changes[0]!.noun}` : `${verb} ${changes.length} objects`;
}

export function createHistory(options: HistoryControllerOptions): HistoryController {
  const { canvas, serializeObjects, onChange } = options;
  const stack = createHistoryStack(Math.max(1, options.limit ?? 100));
  let snapshot = createSnapshot(serializeObjects());
  let pendingChanges: PendingChange[] = [];
  let flushScheduled = false;
  let transactionDepth = 0;
  let pausedDepth = 0;
  let applying = false;
  let queue: Promise<unknown> = Promise.resolve();

  function state(): HistoryState {
    const undoLabels = stack.undoLabels();
    const redoLabels = stack.redoLabels();
    return {
      canUndo: undoLabels.length > 0,
      canRedo: redoLabels.length > 0,
      undoLabel: undoLabels[0],
      redoLabel: redoLabels[0],
    };
  }

  function commit(label: string): boolean {
    pendingChanges = [];
    const nextSnapshot = createSnapshot(serializeObjects());
    const difference = diffSnapshots(snapshot, nextSnapshot);
    snapshot = nextSnapshot;
    if (difference === null) return false;
    stack.record({ label, ...difference });
    onChange(state());
    return true;
  }

  function isRecording(): boolean {
    return !applying && pausedDepth === 0 && transactionDepth === 0;
  }

  function commitPendingChanges(): void {
    flushScheduled = false;
    if (pendingChanges.length === 0) return;
    if (isRecording()) commit(describePendingChanges(pendingChanges));
    pendingChanges = [];
  }

  function notice(verb: string, target: FabricObject): void {
    if (!isRecording()) return;
    pendingChanges.push({ verb, noun: nameOf(target) });
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(commitPendingChanges);
  }

  const handleAdded = ({ target }: ObjectEvent): void => notice('Add', target);
  const handleRemoved = ({ target }: ObjectEvent): void => notice('Delete', target);
  const handleModified = (event: ModifiedEvent): void => {
    const action = event.action ?? event.transform?.action ?? '';
    notice(verbsByAction[action] ?? 'Transform', event.target);
  };
  const handleTextEdited = ({ target }: ObjectEvent): void => notice('Edit', target);

  const listeners: Array<[string, (event: never) => void]> = [
    ['object:added', handleAdded],
    ['object:removed', handleRemoved],
    ['object:modified', handleModified],
    ['text:editing:exited', handleTextEdited],
  ];
  const eventTarget = canvas as unknown as {
    on(name: string, handler: (event: never) => void): unknown;
    off(name: string, handler: (event: never) => void): unknown;
  };
  listeners.forEach(([name, handler]) => eventTarget.on(name, handler));

  function transaction<Result>(label: string, work: () => Result): Result {
    if (transactionDepth === 0) commitPendingChanges();
    transactionDepth += 1;
    const finish = (): void => {
      transactionDepth -= 1;
      if (transactionDepth === 0) commit(label);
    };
    let result: Result;
    try {
      result = work();
    } catch (error) {
      finish();
      throw error;
    }
    if (!isPromiseLike(result)) {
      finish();
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        finish();
        return value;
      },
      (error: unknown) => {
        finish();
        throw error;
      },
    ) as Result;
  }

  function withoutRecording<Result>(work: () => Result): Result {
    pausedDepth += 1;
    let result: Result;
    try {
      result = work();
    } catch (error) {
      pausedDepth -= 1;
      throw error;
    }
    if (!isPromiseLike(result)) {
      pausedDepth -= 1;
      return result;
    }
    return Promise.resolve(result).finally(() => {
      pausedDepth -= 1;
    }) as Result;
  }

  function runInOrder<Result>(task: () => Promise<Result>): Promise<Result> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  function travel(
    takeStep: () => HistoryStep | undefined,
    pickChange: (step: HistoryStep) => StateChange,
    putBack: (step: HistoryStep) => void,
    moveTo: (step: HistoryStep) => void,
  ): Promise<boolean> {
    return runInOrder(async () => {
      if (transactionDepth > 0) return false;
      commitPendingChanges();
      const step = takeStep();
      if (step === undefined) return false;
      applying = true;
      try {
        await applyStateChange(canvas, pickChange(step));
      } catch (error) {
        putBack(step);
        throw error;
      } finally {
        applying = false;
      }
      snapshot = createSnapshot(serializeObjects());
      moveTo(step);
      onChange(state());
      return true;
    });
  }

  return {
    commit(label) {
      if (applying) return false;
      return commit(label);
    },
    transaction,
    undo: () =>
      travel(
        () => stack.takeUndo(),
        (step) => step.before,
        (step) => stack.returnUndo(step),
        (step) => stack.returnRedo(step),
      ),
    redo: () =>
      travel(
        () => stack.takeRedo(),
        (step) => step.after,
        (step) => stack.returnRedo(step),
        (step) => stack.returnUndo(step),
      ),
    state,
    labels: () => ({ undo: stack.undoLabels(), redo: stack.redoLabels() }),
    withoutRecording,
    reset() {
      pendingChanges = [];
      stack.clear();
      snapshot = createSnapshot(serializeObjects());
      onChange(state());
    },
    destroy() {
      listeners.forEach(([name, handler]) => eventTarget.off(name, handler));
      pendingChanges = [];
      stack.clear();
    },
  };
}
