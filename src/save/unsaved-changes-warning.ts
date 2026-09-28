export interface UnsavedChangesSource {
  isDirty(): boolean;
}

export function bindUnsavedChangesWarning(engine: UnsavedChangesSource, target: EventTarget = globalThis.window): () => void {
  const handleBeforeUnload = (event: Event): void => {
    if (!engine.isDirty()) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = '';
  };
  target.addEventListener('beforeunload', handleBeforeUnload);
  return () => target.removeEventListener('beforeunload', handleBeforeUnload);
}
