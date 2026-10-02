import { IText, Textbox, util } from 'fabric';
import type { TextStyleDeclaration } from 'fabric';

export type AnyText = object;

interface CharBox {
  left: number;
  width: number;
  kernedWidth: number;
}

interface TextInternals {
  path?: unknown;
  charSpacing: number;
  textAlign: string;
  CACHE_FONT_SIZE: number;
  isWrapping?: boolean;
  __charBounds: CharBox[][];
  _textLines: string[][];
  _setTextStyles(ctx: CanvasRenderingContext2D, style: TextStyleDeclaration, forMeasuring?: boolean): void;
  getCompleteStyleDeclaration(lineIndex: number, charIndex: number): TextStyleDeclaration & { fontSize: number };
}

const CACHE_LIMIT = 4096;
const widths = new Map<string, number>();
let measuringContext: CanvasRenderingContext2D | undefined;

function context(): CanvasRenderingContext2D {
  measuringContext ??= util.createCanvasElement().getContext('2d')!;
  return measuringContext;
}

function measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  if (text === '') return 0;
  const key = `${font}\u0000${text}`;
  const known = widths.get(key);
  if (known !== undefined) {
    widths.delete(key);
    widths.set(key, known);
    return known;
  }
  const width = ctx.measureText(text).width;
  widths.set(key, width);
  if (widths.size > CACHE_LIMIT) widths.delete(widths.keys().next().value!);
  return width;
}

export function drawsJoinedRuns(text: AnyText): boolean {
  const self = text as unknown as TextInternals;
  return !self.path && self.charSpacing === 0 && !self.textAlign.includes('justify');
}

const isSpace = (grapheme: string): boolean => /\s/.test(grapheme);

function runLefts(ctx: CanvasRenderingContext2D, font: string, graphemes: readonly string[], start: number, end: number, scale: number): number[] {
  const lefts = new Array<number>(end - start + 1);
  let segmentStart = start;
  let segmentLeft = 0;
  for (let index = start; index < end; index += 1) {
    if (index > start && isSpace(graphemes[index]!) !== isSpace(graphemes[index - 1]!)) {
      segmentStart = index;
      segmentLeft = measure(ctx, font, graphemes.slice(start, index).join(''));
    }
    lefts[index - start] = (segmentLeft + measure(ctx, font, graphemes.slice(segmentStart, index).join(''))) * scale;
  }
  lefts[end - start] = measure(ctx, font, graphemes.slice(start, end).join('')) * scale;
  return lefts;
}

function styleRuns(text: AnyText, lineIndex: number, length: number): Array<[number, number, TextStyleDeclaration & { fontSize: number }]> {
  const self = text as unknown as TextInternals;
  const runs: Array<[number, number, TextStyleDeclaration & { fontSize: number }]> = [];
  let start = 0;
  let style = self.getCompleteStyleDeclaration(lineIndex, 0);
  for (let index = 1; index <= length; index += 1) {
    const next = index < length ? self.getCompleteStyleDeclaration(lineIndex, index) : undefined;
    if (!next || util.hasStyleChanged(style, next, false)) {
      runs.push([start, index, style]);
      start = index;
      if (next) style = next;
    }
  }
  return runs;
}

export function shapeLine(text: AnyText, lineIndex: number, measured: { width: number; numOfSpaces: number }): { width: number; numOfSpaces: number } {
  if (!drawsJoinedRuns(text)) return measured;
  const self = text as unknown as TextInternals;
  const graphemes = self._textLines[lineIndex] ?? [];
  const bounds = self.__charBounds[lineIndex];
  if (!bounds || graphemes.length === 0) return measured;
  const ctx = context();
  let runLeft = 0;
  for (const [start, end, style] of styleRuns(text, lineIndex, graphemes.length)) {
    self._setTextStyles(ctx, style, true);
    const lefts = runLefts(ctx, ctx.font, graphemes, start, end, style.fontSize / self.CACHE_FONT_SIZE);
    for (let index = start; index < end; index += 1) {
      const box = bounds[index]!;
      box.left = runLeft + lefts[index - start]!;
      box.width = box.kernedWidth = lefts[index - start + 1]! - lefts[index - start]!;
    }
    runLeft += lefts[end - start]!;
  }
  const last = bounds[graphemes.length];
  if (last) last.left = runLeft;
  return { width: runLeft, numOfSpaces: measured.numOfSpaces };
}

export function shapeWord(text: AnyText, word: readonly string[], lineIndex: number, charOffset: number, fallback: number): number {
  if (!drawsJoinedRuns(text) || word.length === 0) return fallback;
  const self = text as unknown as TextInternals;
  const ctx = context();
  let width = 0;
  let start = 0;
  let style = self.getCompleteStyleDeclaration(lineIndex, charOffset);
  for (let index = 1; index <= word.length; index += 1) {
    const next = index < word.length ? self.getCompleteStyleDeclaration(lineIndex, charOffset + index) : undefined;
    if (!next || util.hasStyleChanged(style, next, false)) {
      self._setTextStyles(ctx, style, true);
      width += (measure(ctx, ctx.font, word.slice(start, index).join('')) * style.fontSize) / self.CACHE_FONT_SIZE;
      start = index;
      if (next) style = next;
    }
  }
  return width;
}

export class ShapedIText extends IText {
  static override type = 'ShapedIText';

  override _measureLine(lineIndex: number): { width: number; numOfSpaces: number } {
    return shapeLine(this, lineIndex, super._measureLine(lineIndex));
  }
}

export class ShapedTextbox extends Textbox {
  static override type = 'ShapedTextbox';

  override _measureLine(lineIndex: number): { width: number; numOfSpaces: number } {
    return shapeLine(this, lineIndex, super._measureLine(lineIndex));
  }

  override _measureWord(word: string[], lineIndex: number, charOffset = 0): number {
    return shapeWord(this, word, lineIndex, charOffset, super._measureWord(word, lineIndex, charOffset));
  }
}
