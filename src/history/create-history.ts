import type { FabricObject, StaticCanvas } from 'fabric';
import type { SerializedFabricObject } from '../document/document-format';
import { applyStateChange } from './apply-state';
import { createHistoryStack } from './history-stack';
import type { HistoryStep } from './history-stack';
import { createSnapshot, diffSnapshots } from './snapshot';
import type { StateChange } from './snapshot';

export interface HistoryOptions {
  limit?: number;
  maxBytes?: number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
}

export interface TransactionOptions {
  /**
   * When `work` throws or rejects, put the canvas back as it was before the
   * transaction, record no undo step and leave the document's unsaved state
   * alone. Applies to the outermost transaction.
   */
  rollback?: boolean;
}

export interface HistoryController {
  commit(label: string): boolean;
  transaction<Result>(label: string, work: () => Result, options?: TransactionOptions): Result;
  /** Resolves once a rollback, undo or redo already started has finished. */
  settled(): Promise<void>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  state(): HistoryState;
  labels(): { undo: string[]; redo: string[] };
  withoutRecording<Result>(work: () => Result): Result;
  reset(): void;
  /** Records changes still waiting for the end of the current task. */
  flush(): void;
  destroy(): void;
}

export interface SerializedState {
  objects: SerializedFabricObject[];
  /** The page: size, background, overlay and mask. */
  page: unknown;
}

interface HistoryControllerOptions extends HistoryOptions {
  canvas: StaticCanvas;
  serializeState: () => SerializedState;
  onChange: (state: HistoryState) => void;
  onContentChange: () => void;
  /** Called on every keystroke while text is edited, before the step is recorded. */
  onLiveChange?: () => void;
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
  const { canvas, serializeState, onChange, onContentChange, onLiveChange } = options;
  const takeSnapshot = (): ReturnType<typeof createSnapshot> => {
    const { objects, page } = serializeState();
    return createSnapshot(objects, page);
  };
  const stack = createHistoryStack({
    steps: Math.max(1, options.limit ?? 100),
    bytes: Math.max(0, options.maxBytes ?? 64 * 1024 * 1024),
  });
  let snapshot = takeSnapshot();
  let pendingChanges: PendingChange[] = [];
  let flushScheduled = false;
  let transactionDepth = 0;
  let pausedDepth = 0;
  let applying = false;
  let queue: Promise<unknown> = Promise.resolve();
  // Goes up on every reset (a new document), so a step that was being
  // rebuilt for the old document is dropped instead of applied to the new one.
  let epoch = 0;

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
    const nextSnapshot = takeSnapshot();
    const difference = diffSnapshots(snapshot, nextSnapshot);
    snapshot = nextSnapshot;
    if (difference === null) return false;
    stack.record({ label, ...difference });
    onContentChange();
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
  // Each keystroke counts as unsaved work at once; the undo step is still
  // recorded once, when editing ends.
  const handleTextChanged = (): void => {
    if (!applying && pausedDepth === 0) onLiveChange?.();
  };

  const listeners: Array<[string, (event: never) => void]> = [
    ['object:added', handleAdded],
    ['object:removed', handleRemoved],
    ['object:modified', handleModified],
    ['text:editing:exited', handleTextEdited],
    ['text:changed', handleTextChanged],
  ];
  const eventTarget = canvas as unknown as {
    on(name: string, handler: (event: never) => void): unknown;
    off(name: string, handler: (event: never) => void): unknown;
  };
  listeners.forEach(([name, handler]) => eventTarget.on(name, handler));

  /**
   * Puts the canvas back to the last recorded snapshot. The snapshot is the
   * state before the transaction, so the difference to undo is exactly what
   * the transaction changed: one serialization, then only the changed
   * objects are rebuilt.
   */
  function rollBack(): Promise<void> {
    const difference = diffSnapshots(snapshot, takeSnapshot());
    pendingChanges = [];
    if (difference === null) return Promise.resolve();
    applying = true;
    return runInOrder(async () => {
      try {
        await applyStateChange(canvas, difference.before);
      } finally {
        applying = false;
      }
    });
  }

  function transaction<Result>(label: string, work: () => Result, transactionOptions: TransactionOptions = {}): Result {
    if (transactionDepth === 0) commitPendingChanges();
    const outermost = transactionDepth === 0;
    transactionDepth += 1;
    const finish = (): void => {
      transactionDepth -= 1;
      if (transactionDepth === 0) commit(label);
    };
    const fail = (): Promise<void> | undefined => {
      transactionDepth -= 1;
      if (transactionDepth > 0) return undefined;
      if (outermost && transactionOptions.rollback) return rollBack();
      commit(label);
      return undefined;
    };
    let result: Result;
    try {
      result = work();
    } catch (error) {
      void fail()?.catch(() => undefined);
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
      async (error: unknown) => {
        await fail();
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
      const startedIn = epoch;
      applying = true;
      let applied: boolean;
      try {
        applied = await applyStateChange(canvas, pickChange(step), () => epoch !== startedIn);
      } catch (error) {
        if (epoch === startedIn) putBack(step);
        throw error;
      } finally {
        applying = false;
      }
      if (!applied) return false;
      snapshot = takeSnapshot();
      moveTo(step);
      onContentChange();
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
    settled: () => queue.then(() => undefined),
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
    flush: commitPendingChanges,
    reset() {
      pendingChanges = [];
      stack.clear();
      epoch += 1;
      snapshot = takeSnapshot();
      onChange(state());
    },
    destroy() {
      listeners.forEach(([name, handler]) => eventTarget.off(name, handler));
      pendingChanges = [];
      stack.clear();
    },
  };
}
