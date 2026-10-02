import type { IText, Textbox, TextStyleDeclaration } from 'fabric';

export type EditableTextObject = IText | Textbox;
import type { DocumentEngine } from '../engine/create-document-engine';

export interface StyleRun {
  start: number;
  end: number;
  style: TextStyleDeclaration;
}

export type InsertedStyle = TextStyleDeclaration | null | undefined;

type EditableText = IText & {
  _text: string[];
  hiddenTextarea?: HTMLTextAreaElement | null;
  inCompositionMode?: boolean;
  _updateTextarea?: () => void;
};

function sameStyle(a: TextStyleDeclaration, b: TextStyleDeclaration): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]);
}

function hasStyle(style: TextStyleDeclaration | null | undefined): style is TextStyleDeclaration {
  return style !== undefined && style !== null && Object.keys(style).length > 0;
}

export function readStyleRuns(graphemes: readonly string[], styles: IText['styles']): StyleRun[] {
  const runs: StyleRun[] = [];
  let line = 0;
  let char = 0;
  for (let index = 0; index < graphemes.length; index += 1) {
    if (graphemes[index] === '\n') {
      line += 1;
      char = 0;
      continue;
    }
    const style = styles?.[line]?.[char] as TextStyleDeclaration | undefined;
    char += 1;
    if (!hasStyle(style)) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === index && sameStyle(last.style, style)) last.end = index + 1;
    else runs.push({ start: index, end: index + 1, style });
  }
  return runs;
}

export function writeStyleRuns(graphemes: readonly string[], runs: readonly StyleRun[]): IText['styles'] {
  const styles: IText['styles'] = {};
  let line = 0;
  let char = 0;
  let next = 0;
  for (let index = 0; index < graphemes.length; index += 1) {
    if (graphemes[index] === '\n') {
      line += 1;
      char = 0;
      continue;
    }
    while (next < runs.length && runs[next]!.end <= index) next += 1;
    const run = runs[next];
    if (run && run.start <= index) (styles[line] ??= {})[char] = { ...run.style };
    char += 1;
  }
  return styles;
}

export function shiftStyleRuns(
  runs: readonly StyleRun[],
  start: number,
  end: number,
  insertedLength: number,
  style?: InsertedStyle,
): StyleRun[] {
  const delta = insertedLength - (end - start);
  const shifted: StyleRun[] = [];
  let inherited: StyleRun | undefined;
  for (const run of runs) {
    if (run.end <= start) {
      const copy = { ...run };
      if (copy.end === start) inherited = copy;
      shifted.push(copy);
    } else if (run.start >= end) {
      shifted.push({ start: run.start + delta, end: run.end + delta, style: run.style });
    } else {
      if (run.start < start) {
        inherited = { start: run.start, end: start, style: run.style };
        shifted.push(inherited);
      }
      if (run.end > end) shifted.push({ start: end + delta, end: run.end + delta, style: run.style });
    }
  }
  if (insertedLength === 0) return shifted;
  if (style === undefined) {
    if (inherited) {
      inherited.end += insertedLength;
    }
    return shifted;
  }
  if (!hasStyle(style)) return shifted;
  const inserted: StyleRun = { start, end: start + insertedLength, style };
  const at = shifted.findIndex((run) => run.start >= start);
  if (at === -1) shifted.push(inserted);
  else shifted.splice(at, 0, inserted);
  return shifted;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function moveIndex(index: number, start: number, end: number, insertedLength: number): number {
  if (index <= start) return index;
  if (index >= end) return index + insertedLength - (end - start);
  return start + insertedLength;
}

export function replaceTextRange(target: EditableTextObject, start: number, end: number, insert: string, style?: InsertedStyle): void {
  const text = target as EditableText;
  const graphemes = text._text ?? text.graphemeSplit(text.text);
  const from = clamp(Math.floor(start), 0, graphemes.length);
  const to = clamp(Math.floor(end), from, graphemes.length);
  const inserted = insert ? text.graphemeSplit(insert) : [];
  const runs = shiftStyleRuns(readStyleRuns(graphemes, text.styles), from, to, inserted.length, style);
  const next = [...graphemes.slice(0, from), ...inserted, ...graphemes.slice(to)];
  const selectionStart = moveIndex(text.selectionStart ?? 0, from, to, inserted.length);
  const selectionEnd = moveIndex(text.selectionEnd ?? 0, from, to, inserted.length);
  applyTextAndStyles(text, next, runs);
  text.selectionStart = selectionStart;
  text.selectionEnd = Math.max(selectionStart, selectionEnd);
  announceTextChange(text);
}

export function setTextRangeStyle(target: EditableTextObject, start: number, end: number, style: TextStyleDeclaration): void {
  const text = target as EditableText;
  const graphemes = text._text ?? text.graphemeSplit(text.text);
  const from = clamp(Math.floor(start), 0, graphemes.length);
  const to = clamp(Math.floor(end), from, graphemes.length);
  if (from === to) return;
  const runs = readStyleRuns(graphemes, text.styles);
  const result: StyleRun[] = [];
  let cursor = from;
  for (const run of runs) {
    if (run.end <= from || run.start >= to) {
      if (run.start >= to && cursor < to) {
        result.push({ start: cursor, end: to, style: { ...style } });
        cursor = to;
      }
      result.push(run);
      continue;
    }
    if (run.start < from) result.push({ start: run.start, end: from, style: run.style });
    const overlapStart = Math.max(run.start, from);
    if (cursor < overlapStart) result.push({ start: cursor, end: overlapStart, style: { ...style } });
    const overlapEnd = Math.min(run.end, to);
    result.push({ start: overlapStart, end: overlapEnd, style: { ...run.style, ...style } });
    cursor = overlapEnd;
    if (run.end > to) result.push({ start: to, end: run.end, style: run.style });
  }
  if (cursor < to) result.push({ start: cursor, end: to, style: { ...style } });
  applyTextAndStyles(text, graphemes, result);
  announceTextChange(text);
}

function applyTextAndStyles(text: EditableText, graphemes: readonly string[], runs: readonly StyleRun[]): void {
  const value = graphemes.join('');
  text.styles = writeStyleRuns(graphemes, runs);
  if (text.text !== value) text.set('text', value);
  else text.initDimensions();
  text.set('dirty', true);
  text.setCoords();
}

function announceTextChange(text: EditableText): void {
  if (text.isEditing && text.hiddenTextarea && !text.inCompositionMode) {
    text.hiddenTextarea.value = text.text;
    text._updateTextarea?.();
  }
  text.fire('changed' as never);
  text.canvas?.fire('text:changed' as never, { target: text } as never);
  text.canvas?.requestRenderAll();
}

export interface TextCommands {
  insertText(target: EditableTextObject, index: number, text: string, style?: InsertedStyle): void;
  deleteText(target: EditableTextObject, start: number, end: number): void;
  replaceText(target: EditableTextObject, start: number, end: number, text: string, style?: InsertedStyle): void;
  setTextStyle(target: EditableTextObject, start: number, end: number, style: TextStyleDeclaration): void;
}

export function createTextCommands(engine: DocumentEngine): TextCommands {
  return {
    insertText(target, index, text, style) {
      if (!text) return;
      engine.transaction('Insert text', () => replaceTextRange(target, index, index, text, style));
    },
    deleteText(target, start, end) {
      if (end <= start) return;
      engine.transaction('Delete text', () => replaceTextRange(target, start, end, ''));
    },
    replaceText(target, start, end, text, style) {
      engine.transaction('Replace text', () => replaceTextRange(target, start, end, text, style));
    },
    setTextStyle(target, start, end, style) {
      if (end <= start) return;
      engine.transaction('Style text', () => setTextRangeStyle(target, start, end, style));
    },
  };
}
