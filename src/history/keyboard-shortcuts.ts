export interface UndoRedoTarget {
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
}

export interface KeyboardShortcutOptions {
  target?: EventTarget;
}

function isTypingInto(element: EventTarget | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

function chooseAction(event: KeyboardEvent): 'undo' | 'redo' | null {
  const commandPressed = event.metaKey || event.ctrlKey;
  if (!commandPressed || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.shiftKey) return 'redo';
  return null;
}

export function bindKeyboardShortcuts(engine: UndoRedoTarget, options: KeyboardShortcutOptions = {}): () => void {
  const target = options.target ?? globalThis.window;

  const handleKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.defaultPrevented || isTypingInto(keyboardEvent.target)) return;
    const action = chooseAction(keyboardEvent);
    if (action === null) return;
    keyboardEvent.preventDefault();
    engine[action]().catch(() => undefined);
  };

  target.addEventListener('keydown', handleKeyDown);
  return () => target.removeEventListener('keydown', handleKeyDown);
}
