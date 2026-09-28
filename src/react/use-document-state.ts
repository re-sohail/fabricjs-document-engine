import { useMemo, useSyncExternalStore } from 'react';
import type { DocumentEngine } from '../engine/create-document-engine';
import { createDocumentStateStore } from '../state/document-state-store';
import type { DocumentState } from '../state/document-state-store';

const subscribeToNothing = (): (() => void) => () => undefined;
const nothing = (): null => null;

export function useDocumentState(engine: DocumentEngine | null | undefined): DocumentState | null {
  const store = useMemo(() => (engine ? createDocumentStateStore(engine) : null), [engine]);
  return useSyncExternalStore<DocumentState | null>(
    store ? store.subscribe : subscribeToNothing,
    store ? store.getSnapshot : nothing,
    nothing,
  );
}
