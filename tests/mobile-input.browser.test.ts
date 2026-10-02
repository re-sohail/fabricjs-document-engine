import { afterEach, describe, expect, it } from 'vitest';
import { Canvas, IText } from 'fabric';
import { attachMobileTextInput, findTextEdit } from '../src/text';
import type { MobileTextInput } from '../src/text';

const open: Canvas[] = [];
const adapters: MobileTextInput[] = [];

afterEach(async () => {
  adapters.splice(0).forEach((adapter) => adapter.detach());
  for (const canvas of open.splice(0)) await canvas.dispose();
});

function setup(withAdapter: boolean): { canvas: Canvas; text: IText; textarea: HTMLTextAreaElement } {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 400, height: 200 });
  open.push(canvas);
  if (withAdapter) adapters.push(attachMobileTextInput(canvas));
  const text = new IText('im here', { left: 10, top: 10, styles: { 0: { 3: { fontWeight: 'bold' }, 4: { fontWeight: 'bold' }, 5: { fontWeight: 'bold' }, 6: { fontWeight: 'bold' } } } });
  canvas.add(text);
  canvas.setActiveObject(text);
  text.enterEditing();
  text.setSelectionStart(7);
  text.setSelectionEnd(7);
  return { canvas, text, textarea: text.hiddenTextarea! };
}

function bold(text: IText): string {
  return [...text.text].filter((_, index) => text.styles[0]?.[index]?.fontWeight === 'bold').join('');
}

function keyboardEdit(textarea: HTMLTextAreaElement, value: string, caret: number, inputType: string): void {
  textarea.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Unidentified', bubbles: true } as KeyboardEventInit));
  textarea.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
  textarea.value = value;
  textarea.setSelectionRange(caret, caret);
  textarea.dispatchEvent(new InputEvent('input', { inputType, bubbles: true }));
}

describe('typing with phone keyboards (fabric.js #6588)', () => {
  it('reproduces: an autocorrect before the cursor moves styles onto the wrong letters', () => {
    const { text, textarea } = setup(false);
    keyboardEdit(textarea, "I'm here", 8, 'insertReplacementText');
    expect(text.text).toBe("I'm here");
    expect(bold(text)).not.toBe('here');
  });

  it('applies an autocorrect where it happened', () => {
    const { text, textarea } = setup(true);
    keyboardEdit(textarea, "I'm here", 8, 'insertReplacementText');
    expect(text.text).toBe("I'm here");
    expect(bold(text)).toBe('here');
    expect(text.selectionStart).toBe(8);
  });

  it('reproduces: a cursor swipe on the space bar is not seen, so the next letter lands at the old cursor', () => {
    const { text, textarea } = setup(false);
    textarea.setSelectionRange(2, 2);
    document.dispatchEvent(new Event('selectionchange'));
    expect(text.selectionStart).toBe(7);
  });

  it('follows the cursor when the keyboard moves it, then types there', () => {
    const { text, textarea } = setup(true);
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    document.dispatchEvent(new Event('selectionchange'));
    expect(text.selectionStart).toBe(2);
    keyboardEdit(textarea, 'im! here', 3, 'insertText');
    expect(text.text).toBe('im! here');
    expect(bold(text)).toBe('here');
  });

  it('handles a Gboard word being composed and replaced by a suggestion', () => {
    const { text, textarea } = setup(true);
    textarea.focus();
    textarea.setSelectionRange(0, 0);
    document.dispatchEvent(new Event('selectionchange'));
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    for (const [value, caret] of [
      ['o im here', 1],
      ['oh im here', 2],
    ] as const) {
      textarea.value = value;
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: value.slice(0, caret) }));
      textarea.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', isComposing: true }));
    }
    textarea.value = 'Oh, im here';
    textarea.setSelectionRange(3, 3);
    textarea.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText' }));
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'Oh,' }));
    expect(text.text).toBe('Oh, im here');
    expect(bold(text)).toBe('here');
  });

  it('deletes with the Android backspace (keyCode 229)', () => {
    const { text, textarea } = setup(true);
    textarea.focus();
    textarea.setSelectionRange(3, 3);
    document.dispatchEvent(new Event('selectionchange'));
    keyboardEdit(textarea, 'imhere', 2, 'deleteContentBackward');
    expect(text.text).toBe('imhere');
    expect(bold(text)).toBe('here');
    expect(text.selectionStart).toBe(2);
  });

  it('sets up the textarea for phone keyboards', () => {
    const { textarea } = setup(true);
    expect(textarea.getAttribute('inputmode')).toBe('text');
    expect(textarea.getAttribute('enterkeyhint')).toBe('enter');
    expect(textarea.getAttribute('autocapitalize')).toBe('sentences');
    expect(textarea.style.fontSize).toBe('16px');
  });

  it('reproduces: Fabric gives the textarea a 1px font, which makes iOS zoom', () => {
    const { textarea } = setup(false);
    expect(textarea.style.fontSize).toBe('1px');
    expect(textarea.getAttribute('inputmode')).toBeNull();
  });

  it('puts Fabric back on detach', () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element);
    open.push(canvas);
    const text = new IText('x');
    canvas.add(text);
    const adapter = attachMobileTextInput(canvas);
    expect(Object.prototype.hasOwnProperty.call(text, 'onInput')).toBe(true);
    adapter.detach();
    expect(Object.prototype.hasOwnProperty.call(text, 'onInput')).toBe(false);
  });
});

describe('findTextEdit', () => {
  const split = (value: string): string[] => [...value];
  it('reads the edit next to the cursor when letters repeat', () => {
    expect(findTextEdit(split('aa'), split('aaa'), 1)).toEqual({ from: 0, oldTo: 0, newTo: 1 });
    expect(findTextEdit(split('aa'), split('aaa'), 3)).toEqual({ from: 2, oldTo: 2, newTo: 3 });
  });

  it('reads replacements and deletions', () => {
    expect(findTextEdit(split('teh cat'), split('the cat'), 3)).toEqual({ from: 1, oldTo: 3, newTo: 3 });
    expect(findTextEdit(split('abc'), split('ac'), 1)).toEqual({ from: 1, oldTo: 2, newTo: 1 });
    expect(findTextEdit(split('same'), split('same'), 2)).toBeUndefined();
    expect(findTextEdit(split('im here'), split("I'm here"), 8)).toEqual({ from: 0, oldTo: 1, newTo: 2 });
    expect(findTextEdit(split('aaa'), split('aaaa'), 2)).toEqual({ from: 1, oldTo: 1, newTo: 2 });
  });
});
