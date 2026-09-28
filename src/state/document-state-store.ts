import type { AssetWarning } from '../assets/asset-pipeline';
import type { DocumentEngine } from '../engine/create-document-engine';
import type { DocumentEngineError } from '../engine/errors';
import type { SaveStatus } from '../save/save-controller';

export interface DocumentState {
  documentId: string;
  isLoading: boolean;
  loadError: DocumentEngineError | undefined;
  saveStatus: SaveStatus;
  isDirty: boolean;
  isSaving: boolean;
  revision: number;
  lastSavedAt: string | undefined;
  saveError: DocumentEngineError | undefined;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
  assetWarnings: AssetWarning[];
}

export interface DocumentStateStore {
  getSnapshot(): DocumentState;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

function initialState(engine: DocumentEngine): DocumentState {
  const saveState = engine.getSaveState();
  const history = engine.getHistory();
  return {
    documentId: engine.getDocumentInfo().id,
    isLoading: false,
    loadError: undefined,
    saveStatus: saveState.status,
    isDirty: saveState.isDirty,
    isSaving: saveState.isSaving,
    revision: saveState.revision,
    lastSavedAt: saveState.lastSavedAt,
    saveError: saveState.error,
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
    undoLabel: history.undo[0],
    redoLabel: history.redo[0],
    assetWarnings: [],
  };
}

function withLiveEngineValues(engine: DocumentEngine, previous: DocumentState): DocumentState {
  return { ...previous, ...initialState(engine), isLoading: previous.isLoading, loadError: previous.loadError, assetWarnings: previous.assetWarnings };
}

function isSameState(first: DocumentState, second: DocumentState): boolean {
  return (Object.keys(first) as Array<keyof DocumentState>).every((key) => first[key] === second[key]);
}

export function createDocumentStateStore(engine: DocumentEngine): DocumentStateStore {
  let state = initialState(engine);
  const listeners = new Set<() => void>();
  let detachFromEngine: (() => void) | undefined;

  function update(changes: Partial<DocumentState>): void {
    const next = { ...state, ...changes };
    if (isSameState(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function attachToEngine(): () => void {
    const unsubscribers = [
      engine.on('load:start', () => update({ isLoading: true, loadError: undefined })),
      engine.on('load:success', ({ warnings }) => update({ isLoading: false, assetWarnings: warnings })),
      engine.on('load:error', ({ error }) => {
        if (error.code !== 'LOAD_ABORTED') update({ isLoading: false, loadError: error });
      }),
      engine.on('document:change', ({ documentId }) => update({ documentId, loadError: undefined })),
      engine.on('assets:warning', ({ warnings }) => update({ assetWarnings: warnings })),
      engine.on('save:status', (saveState) =>
        update({
          saveStatus: saveState.status,
          isDirty: saveState.isDirty,
          isSaving: saveState.isSaving,
          revision: saveState.revision,
          lastSavedAt: saveState.lastSavedAt,
          saveError: saveState.error,
        }),
      ),
      engine.on('history:change', (history) =>
        update({
          canUndo: history.canUndo,
          canRedo: history.canRedo,
          undoLabel: history.undoLabel,
          redoLabel: history.redoLabel,
        }),
      ),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }

  function refreshWhileDetached(): void {
    if (detachFromEngine) return;
    const fresh = withLiveEngineValues(engine, state);
    if (!isSameState(state, fresh)) state = fresh;
  }

  return {
    getSnapshot() {
      refreshWhileDetached();
      return state;
    },
    subscribe(listener) {
      refreshWhileDetached();
      listeners.add(listener);
      detachFromEngine ??= attachToEngine();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        detachFromEngine?.();
        detachFromEngine = undefined;
      };
    },
    destroy() {
      listeners.clear();
      detachFromEngine?.();
      detachFromEngine = undefined;
    },
  };
}
