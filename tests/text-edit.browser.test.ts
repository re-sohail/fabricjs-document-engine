import { afterEach, describe, expect, it } from 'vitest';
import { Canvas, IText, Textbox } from 'fabric';
import { createDocumentEngine, createTextCommands, replaceTextRange, setTextRangeStyle, shiftStyleRuns } from '../src';
import type { DocumentEngine } from '../src';

const open: Array<{ canvas: Canvas; engine?: DocumentEngine }> = [];

function setup(): { canvas: Canvas; engine: DocumentEngine } {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 400, height: 300 });
  const engine = createDocumentEngine({ canvas });
  open.push({ canvas, engine });
  return { canvas, engine };
}

afterEach(async () => {
  for (const { canvas, engine } of open.splice(0)) {
    engine?.destroy();
    await canvas.dispose();
  }
});

function boldLetters(text: IText): string {
  const lines = text.text.split('\n');
  let result = '';
  lines.forEach((line, lineIndex) => {
    [...line].forEach((letter, charIndex) => {
      if (text.styles[lineIndex]?.[charIndex]?.fontWeight === 'bold') result += letter;
    });
  });
  return result;
}

function boldWorld(): IText {
  return new IText('hello world', { styles: { 0: { 6: { fontWeight: 'bold' }, 7: { fontWeight: 'bold' }, 8: { fontWeight: 'bold' }, 9: { fontWeight: 'bold' }, 10: { fontWeight: 'bold' } } } });
}

describe('text edits keep styles on their letters (fabric.js #6133)', () => {
  it('reproduces: setting text leaves styles at their old index', () => {
    const text = boldWorld();
    text.set('text', 'oh, hello world');
    expect(boldLetters(text)).not.toBe('world');
  });

  it('reproduces: insertChars fires no text:changed and leaves the textarea behind', () => {
    const { canvas } = setup();
    const text = boldWorld();
    canvas.add(text);
    text.enterEditing();
    let changes = 0;
    canvas.on('text:changed', () => (changes += 1));
    text.insertChars('oh, ', undefined, 0);
    expect(changes).toBe(0);
    expect(text.hiddenTextarea!.value).not.toBe(text.text);
    text.exitEditing();
  });

  it('inserts, deletes and replaces with styles shifted', () => {
    const text = boldWorld();
    replaceTextRange(text, 0, 0, 'oh, ');
    expect(text.text).toBe('oh, hello world');
    expect(boldLetters(text)).toBe('world');
    replaceTextRange(text, 4, 10, '');
    expect(text.text).toBe('oh, world');
    expect(boldLetters(text)).toBe('world');
    replaceTextRange(text, 4, 6, 'WO');
    expect(text.text).toBe('oh, WOrld');
    expect(boldLetters(text)).toBe('rld');
    replaceTextRange(text, 4, 6, 'wo', { fontWeight: 'bold' });
    expect(boldLetters(text)).toBe('world');
  });

  it('grows a styled word when typing inside or at its end', () => {
    const text = boldWorld();
    replaceTextRange(text, 11, 11, 's');
    expect(boldLetters(text)).toBe('worlds');
    replaceTextRange(text, 8, 8, 'R');
    expect(boldLetters(text)).toBe('woRrlds');
  });

  it('handles new lines and styles on later lines', () => {
    const text = new IText('ab\ncd', { styles: { 1: { 0: { fill: 'red' }, 1: { fill: 'red' } } } });
    replaceTextRange(text, 1, 1, 'x\ny');
    expect(text.text).toBe('ax\nyb\ncd');
    expect(text.styles[2]?.[0]?.fill).toBe('red');
    expect(text.styles[2]?.[1]?.fill).toBe('red');
    replaceTextRange(text, 0, 6, '');
    expect(text.text).toBe('cd');
    expect(text.styles[0]?.[0]?.fill).toBe('red');
  });

  it('counts emoji and joined letters as one grapheme', () => {
    const text = new IText('👍🏽ok', { styles: { 0: { 1: { fill: 'red' } } } });
    replaceTextRange(text, 0, 1, '');
    expect(text.text).toBe('ok');
    expect(text.styles[0]?.[0]?.fill).toBe('red');
  });

  it('keeps Textbox styles right across soft wraps', () => {
    const text = new Textbox('one two three four five six', { width: 60, styles: { 0: { 22: { fill: 'red' } } } });
    replaceTextRange(text, 0, 0, 'zero ');
    expect(text.text[27]).toBe('e');
    expect(text.styles[0]?.[27]?.fill).toBe('red');
    expect(text.textLines.length).toBeGreaterThan(1);
  });

  it('merges a style into a range', () => {
    const text = boldWorld();
    setTextRangeStyle(text, 4, 8, { fill: 'red' });
    expect(text.styles[0]?.[4]).toEqual({ fill: 'red' });
    expect(text.styles[0]?.[7]).toEqual({ fontWeight: 'bold', fill: 'red' });
    expect(text.styles[0]?.[9]).toEqual({ fontWeight: 'bold' });
  });

  it('keeps the textarea, cursor and events in step while editing', () => {
    const { canvas } = setup();
    const text = boldWorld();
    canvas.add(text);
    text.enterEditing();
    text.selectionStart = text.selectionEnd = 11;
    let changes = 0;
    canvas.on('text:changed', () => (changes += 1));
    replaceTextRange(text, 0, 0, 'oh, ');
    expect(changes).toBe(1);
    expect(text.hiddenTextarea!.value).toBe('oh, hello world');
    expect(text.selectionStart).toBe(15);
    text.exitEditing();
  });

  it('records one undo step per command and marks the document unsaved', async () => {
    const { canvas, engine } = setup();
    const text = boldWorld();
    canvas.add(text);
    await Promise.resolve();
    const commands = createTextCommands(engine);
    const before = engine.getHistory().undo.length;
    commands.insertText(text, 0, 'oh, ');
    expect(engine.getHistory().undo.length).toBe(before + 1);
    expect(engine.getHistory().undo[0]).toBe('Insert text');
    expect(engine.isDirty()).toBe(true);
    await engine.undo();
    const restored = engine.canvas.getObjects()[0] as IText;
    expect(restored.text).toBe('hello world');
    expect(boldLetters(restored)).toBe('world');
  });
});

describe('shiftStyleRuns', () => {
  const bold = { fontWeight: 'bold' } as const;
  it('moves runs after the edit and cuts runs across it', () => {
    expect(shiftStyleRuns([{ start: 5, end: 10, style: bold }], 0, 2, 0)).toEqual([{ start: 3, end: 8, style: bold }]);
    expect(shiftStyleRuns([{ start: 2, end: 8, style: bold }], 4, 6, 0)).toEqual([
      { start: 2, end: 4, style: bold },
      { start: 4, end: 6, style: bold },
    ]);
    expect(shiftStyleRuns([{ start: 2, end: 4, style: bold }], 0, 10, 1)).toEqual([]);
  });

  it('places an inserted style between runs in order', () => {
    const red = { fill: 'red' };
    expect(shiftStyleRuns([{ start: 0, end: 2, style: bold }, { start: 4, end: 6, style: bold }], 3, 3, 2, red)).toEqual([
      { start: 0, end: 2, style: bold },
      { start: 3, end: 5, style: red },
      { start: 6, end: 8, style: bold },
    ]);
  });
});
