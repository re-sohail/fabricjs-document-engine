import { IText } from 'fabric';
import type { Canvas, FabricObject, TOriginX } from 'fabric';
import { replaceTextRange } from '../commands/text-edit';

export interface MobileTextInputOptions {
  inputMode?: string;
  enterKeyHint?: string;
  autocapitalize?: string;
  autocorrect?: boolean;
  spellcheck?: boolean;
}

export interface MobileTextInput {
  detach(): void;
}

type EditableText = IText & { _text: string[] };

interface EditingState {
  fromPaste?: boolean;
  inCompositionMode?: boolean;
}

const composing = (text: IText): boolean => Boolean((text as unknown as EditingState).inCompositionMode);

export function findTextEdit(
  previous: readonly string[],
  next: readonly string[],
  cursor: number,
): { from: number; oldTo: number; newTo: number } | undefined {
  const shorter = Math.min(previous.length, next.length);
  let sharedStart = 0;
  while (sharedStart < shorter && previous[sharedStart] === next[sharedStart]) sharedStart += 1;
  let sharedEnd = 0;
  while (sharedEnd < shorter && previous[previous.length - 1 - sharedEnd] === next[next.length - 1 - sharedEnd]) sharedEnd += 1;
  let from = sharedStart;
  let end = sharedEnd;
  if (sharedStart + sharedEnd > shorter) {
    const grown = next.length - shorter;
    from = Math.min(Math.max(cursor - grown, shorter - sharedEnd), sharedStart);
    end = shorter - from;
  }
  const oldTo = previous.length - end;
  const newTo = next.length - end;
  if (from === oldTo && from === newTo) return undefined;
  return { from, oldTo, newTo };
}

function anchorOf(text: EditableText): TOriginX {
  if (!text.textAlign.startsWith('justify')) return text.textAlign.replace('justify-', '') as TOriginX;
  return text.direction === 'rtl' ? 'right' : 'left';
}

function applyFromTextarea(this: EditableText, event?: Event): void {
  const textarea = this.hiddenTextarea;
  if (!textarea) return;
  if ((this as unknown as EditingState).fromPaste) {
    IText.prototype.onInput.call(this as never, event as never);
    return;
  }
  event?.stopPropagation();
  if (!this.isEditing) return;
  const { value } = textarea;
  const next = this.graphemeSplit(value);
  const selection = this.fromStringToGraphemeSelection(textarea.selectionStart, textarea.selectionEnd, value);
  const edit = findTextEdit(this._text, next, selection.selectionEnd);
  if (edit) {
    const anchored = typeof this.getPositionByOrigin === 'function';
    const anchor = anchorOf(this);
    const position = anchored ? this.getPositionByOrigin(anchor, 'top') : undefined;
    replaceTextRange(this, edit.from, edit.oldTo, next.slice(edit.from, edit.newTo).join(''));
    if (position) this.setPositionByOrigin(position, anchor, 'top');
    this.setCoords();
  }
  this.selectionStart = selection.selectionStart;
  this.selectionEnd = selection.selectionEnd;
  (this as unknown as { cursorOffsetCache: object }).cursorOffsetCache = {};
  if (!composing(this)) this.updateTextareaPosition();
  this.canvas?.requestRenderAll();
}

const OWN_HANDLERS = ['onInput'] as const;

function isText(object: FabricObject | undefined): object is EditableText {
  return object instanceof IText;
}

export function attachMobileTextInput(canvas: Canvas, options: MobileTextInputOptions = {}): MobileTextInput {
  const patched = new Set<EditableText>();
  const attributes: Record<string, string> = {
    inputmode: options.inputMode ?? 'text',
    enterkeyhint: options.enterKeyHint ?? 'enter',
    autocapitalize: options.autocapitalize ?? 'sentences',
    autocorrect: options.autocorrect === false ? 'off' : 'on',
    spellcheck: String(options.spellcheck ?? false),
  };

  const patch = (object: FabricObject): void => {
    if (!isText(object) || patched.has(object)) return;
    (object as unknown as Record<string, unknown>).onInput = applyFromTextarea;
    patched.add(object);
  };
  const unpatch = (object: EditableText): void => {
    for (const name of OWN_HANDLERS) delete (object as unknown as Record<string, unknown>)[name];
  };
  canvas.getObjects().forEach(patch);

  const editing = (): EditableText | undefined => {
    const active = canvas.getActiveObject();
    return isText(active) && active.isEditing ? active : undefined;
  };

  const onAdded = ({ target }: { target: FabricObject }): void => patch(target);
  const onEditingEntered = ({ target }: { target: FabricObject }): void => {
    if (!isText(target)) return;
    patch(target);
    const textarea = target.hiddenTextarea;
    if (!textarea) return;
    for (const [name, value] of Object.entries(attributes)) textarea.setAttribute(name, value);
    textarea.style.fontSize = '16px';
  };

  const onSelectionChange = (): void => {
    const text = editing();
    const textarea = text?.hiddenTextarea;
    if (!text || !textarea || textarea.ownerDocument.activeElement !== textarea || composing(text)) return;
    const selection = text.fromStringToGraphemeSelection(textarea.selectionStart, textarea.selectionEnd, textarea.value);
    if (selection.selectionStart === text.selectionStart && selection.selectionEnd === text.selectionEnd) return;
    text.selectionStart = selection.selectionStart;
    text.selectionEnd = selection.selectionEnd;
    (text as unknown as { cursorOffsetCache: object }).cursorOffsetCache = {};
    text.updateTextareaPosition();
    canvas.clearContext(canvas.contextTop);
    text.renderCursorOrSelection();
  };

  const onTouchEnd = (): void => {
    const textarea = editing()?.hiddenTextarea;
    if (textarea && textarea.ownerDocument.activeElement !== textarea) textarea.focus({ preventScroll: true });
  };

  let frame = 0;
  const onViewportChange = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const text = editing();
      if (!text) return;
      canvas.calcOffset();
      text.updateTextareaPosition();
    });
  };

  const element = canvas.upperCanvasEl;
  const ownerDocument = element.ownerDocument;
  const viewport = ownerDocument.defaultView?.visualViewport;
  canvas.on('object:added', onAdded as never);
  canvas.on('text:editing:entered', onEditingEntered as never);
  ownerDocument.addEventListener('selectionchange', onSelectionChange);
  element.addEventListener('touchend', onTouchEnd, { passive: true });
  viewport?.addEventListener('resize', onViewportChange);
  viewport?.addEventListener('scroll', onViewportChange);

  const active = editing();
  if (active) onEditingEntered({ target: active });

  return {
    detach() {
      canvas.off('object:added', onAdded as never);
      canvas.off('text:editing:entered', onEditingEntered as never);
      ownerDocument.removeEventListener('selectionchange', onSelectionChange);
      element.removeEventListener('touchend', onTouchEnd);
      viewport?.removeEventListener('resize', onViewportChange);
      viewport?.removeEventListener('scroll', onViewportChange);
      if (frame) cancelAnimationFrame(frame);
      patched.forEach(unpatch);
      patched.clear();
    },
  };
}
