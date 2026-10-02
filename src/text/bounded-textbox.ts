import { Textbox } from 'fabric';
import type { TextStyleDeclaration } from 'fabric';
import { shapeLine, shapeWord } from './shaping';

export type BreakWords = 'anywhere' | 'never';
export type TextOverflow = 'visible' | 'clip' | 'ellipsis';
export type TextFit = 'none' | 'shrink';

export interface BoundedTextboxProps {
  breakWords: BreakWords;
  maxHeight: number | undefined;
  overflow: TextOverflow;
  fit: TextFit;
  minFontSize: number;
  shaping: boolean;
}

const BOUNDED_PROPERTIES = ['breakWords', 'maxHeight', 'overflow', 'fit', 'minFontSize', 'shaping'] as const;

const ELLIPSIS = '…';

let clipCounter = 0;

interface GraphemeData {
  wordsData: Array<Array<{ word: string[]; width: number }>>;
  largestWordWidth: number;
}

interface OverflowLayout {
  visibleLines: number;
  clipped: boolean;
  visibleHeight: number;
  ellipsis?: { line: number; cut: number; x: number; baseline: number; style: TextStyleDeclaration };
}

interface TextInternals {
  initialized?: boolean;
  dynamicMinWidth: number;
  isWrapping: boolean;
  _fontSizeFraction: number;
  __charBounds: Array<Array<{ left: number; width: number; kernedWidth: number }>>;
  _textLines: string[][];
  _getWidthOfCharSpacing(): number;
  _measureWord(word: string[], lineIndex: number, charOffset?: number): number;
  _getGraphemeBox(grapheme: string, lineIndex: number, charIndex: number, previous?: string, skipLeft?: boolean): { kernedWidth: number };
  _measureChar(grapheme: string, style: TextStyleDeclaration, previous?: string, previousStyle?: TextStyleDeclaration): { width: number };
  _getLeftOffset(): number;
  _getTopOffset(): number;
  _getLineLeftOffset(lineIndex: number): number;
  _getFontDeclaration(style?: TextStyleDeclaration): string;
  _getStyleDeclaration(lineIndex: number, charIndex: number): TextStyleDeclaration;
  getGraphemeDataForRender(lines: string[]): GraphemeData;
}

function internals(text: BoundedTextbox): TextInternals {
  return text as unknown as TextInternals;
}

export class BoundedTextbox extends Textbox {
  static override type = 'BoundedTextbox';

  static override textLayoutProperties: string[] = [...Textbox.textLayoutProperties, ...BOUNDED_PROPERTIES];

  static override cacheProperties: string[] = [...Textbox.cacheProperties, ...BOUNDED_PROPERTIES];

  static boundedDefaults: BoundedTextboxProps = {
    breakWords: 'anywhere',
    maxHeight: undefined,
    overflow: 'visible',
    fit: 'none',
    minFontSize: 6,
    shaping: false,
  };

  static override getDefaults(): Record<string, unknown> {
    return { ...super.getDefaults(), ...BoundedTextbox.boundedDefaults };
  }

  declare breakWords: BreakWords;
  declare maxHeight: number | undefined;
  declare overflow: TextOverflow;
  declare fit: TextFit;
  declare minFontSize: number;
  declare shaping: boolean;

  declare fitScale: number;
  private declare baseFontSize: number;
  private declare midWordBreaks: Set<number>;
  private declare lineBase: number;
  private declare overflowCache: OverflowLayout | null | undefined;

  constructor(text: string, options: Partial<BoundedTextboxProps> & ConstructorParameters<typeof Textbox>[1] = {}) {
    super(text, { ...BoundedTextbox.boundedDefaults, ...options });
  }

  getBaseFontSize(): number {
    return this.baseFontSize;
  }

  override initDimensions(): void {
    const self = internals(this);
    if (!self.initialized) return;
    this.midWordBreaks ??= new Set();
    this.overflowCache = undefined;
    this.fitScale = 1;
    super.initDimensions();
    if (this.fit === 'shrink' && this.maxHeight !== undefined && this.calcTextHeight() > this.maxHeight) this.shrinkToFit();
    if (this.maxHeight !== undefined && this.overflow !== 'visible') this.height = Math.min(this.height, this.maxHeight);
  }

  private shrinkToFit(): void {
    const base = this.baseFontSize;
    const maxHeight = this.maxHeight!;
    let low = Math.max(1, Math.ceil(Math.min(this.minFontSize, base) * 2));
    let high = Math.floor(base * 2) - 1;
    let best = low;
    const layOut = (halfPoints: number): number => {
      this.fitScale = halfPoints / 2 / base;
      Textbox.prototype.initDimensions.call(this);
      return this.calcTextHeight();
    };
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (layOut(middle) <= maxHeight) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (this.fitScale !== best / 2 / base) layOut(best);
  }

  override getValueOfPropertyAt<T extends keyof TextStyleDeclaration>(lineIndex: number, charIndex: number, property: T): this[T] {
    const value = super.getValueOfPropertyAt(lineIndex, charIndex, property);
    if (property === 'fontSize' && this.fitScale !== 1 && this.hasOwnFontSize(lineIndex, charIndex)) {
      return ((value as number) * this.fitScale) as this[T];
    }
    return value;
  }

  override getCompleteStyleDeclaration(lineIndex: number, charIndex: number): ReturnType<Textbox['getCompleteStyleDeclaration']> {
    const style = super.getCompleteStyleDeclaration(lineIndex, charIndex);
    if (this.fitScale !== 1 && this.hasOwnFontSize(lineIndex, charIndex)) style.fontSize *= this.fitScale;
    return style;
  }

  private hasOwnFontSize(lineIndex: number, charIndex: number): boolean {
    return internals(this)._getStyleDeclaration(lineIndex, charIndex)?.fontSize !== undefined;
  }

  override _wrapText(lines: string[], desiredWidth: number): string[][] {
    const self = internals(this);
    this.midWordBreaks = new Set();
    self.isWrapping = true;
    const data = self.getGraphemeDataForRender(lines);
    const wrapped: string[][] = [];
    for (let index = 0; index < data.wordsData.length; index += 1) {
      this.lineBase = wrapped.length;
      wrapped.push(...this._wrapLine(index, desiredWidth, data as never));
    }
    self.isWrapping = false;
    return wrapped;
  }

  override _wrapLine(lineIndex: number, desiredWidth: number, data: never, reservedSpace = 0): string[][] {
    if (this.breakWords === 'never' || this.splitByGrapheme) return super._wrapLine(lineIndex, desiredWidth, data, reservedSpace);
    const self = internals(this);
    const { wordsData } = data as GraphemeData;
    const additionalSpace = self._getWidthOfCharSpacing();
    const available = desiredWidth - reservedSpace;
    const lines: string[][] = [];
    let line: string[] = [];
    let lineWidth = 0;
    let offset = 0;
    let infixWidth = 0;
    let lineJustStarted = true;
    let widestGrapheme = 0;
    const words = wordsData[lineIndex] ?? [];
    for (const { word, width: wordWidth } of words) {
      const wordStart = offset;
      offset += word.length;
      if (wordWidth - additionalSpace > available && word.length > 1) {
        if (!lineJustStarted) lines.push(line);
        line = [];
        lineWidth = 0;
        let previous: string | undefined;
        for (let index = 0; index < word.length; index += 1) {
          const grapheme = word[index]!;
          const graphemeWidth = self._getGraphemeBox(grapheme, lineIndex, wordStart + index, previous, true).kernedWidth;
          widestGrapheme = Math.max(widestGrapheme, graphemeWidth - additionalSpace);
          if (line.length > 0 && lineWidth + graphemeWidth - additionalSpace > available) {
            this.midWordBreaks.add(this.lineBase + lines.length);
            lines.push(line);
            line = [];
            lineWidth = 0;
          }
          line.push(grapheme);
          lineWidth += graphemeWidth;
          previous = grapheme;
        }
      } else {
        if (word.length === 1) widestGrapheme = Math.max(widestGrapheme, wordWidth - additionalSpace);
        lineWidth += infixWidth + wordWidth - additionalSpace;
        if (lineWidth > available && !lineJustStarted) {
          lines.push(line);
          line = [];
          lineWidth = wordWidth;
          lineJustStarted = true;
        } else {
          lineWidth += additionalSpace;
        }
        if (!lineJustStarted) line.push(' ');
        line = line.concat(word);
      }
      infixWidth = self._measureWord([' '], lineIndex, offset);
      offset += 1;
      lineJustStarted = false;
    }
    if (words.length > 0) lines.push(line);
    self.dynamicMinWidth = Math.max(self.dynamicMinWidth, widestGrapheme);
    return lines;
  }

  override _measureLine(lineIndex: number): { width: number; numOfSpaces: number } {
    const measured = super._measureLine(lineIndex);
    return this.shaping ? shapeLine(this, lineIndex, measured) : measured;
  }

  override _measureWord(word: string[], lineIndex: number, charOffset = 0): number {
    const width = super._measureWord(word, lineIndex, charOffset);
    return this.shaping ? shapeWord(this, word, lineIndex, charOffset, width) : width;
  }

  override missingNewlineOffset(lineIndex: number, skipWrapping?: boolean): 0 | 1 {
    if (!skipWrapping && this.midWordBreaks?.has(lineIndex)) return 0;
    return super.missingNewlineOffset(lineIndex, skipWrapping);
  }

  private overflowLayout(): OverflowLayout | null {
    if (this.overflowCache !== undefined) return this.overflowCache;
    const maxHeight = this.maxHeight;
    if (maxHeight === undefined || this.overflow === 'visible') return (this.overflowCache = null);
    const self = internals(this);
    const lineCount = self._textLines.length;
    let visibleLines = 0;
    let top = 0;
    for (let index = 0; index < lineCount; index += 1) {
      const lineHeight = this.getHeightOfLine(index);
      if (top + lineHeight / this.lineHeight > maxHeight + 0.5) break;
      visibleLines = index + 1;
      top += lineHeight;
    }
    const clipped = visibleLines < lineCount;
    const layout: OverflowLayout = { visibleLines, clipped, visibleHeight: top };
    if (clipped && visibleLines > 0 && this.overflow === 'ellipsis' && !this.isEditing && this.direction !== 'rtl') {
      layout.ellipsis = this.placeEllipsis(visibleLines - 1, top - this.getHeightOfLine(visibleLines - 1));
    }
    return (this.overflowCache = layout);
  }

  private placeEllipsis(line: number, lineTop: number): OverflowLayout['ellipsis'] {
    const self = internals(this);
    this.getLineWidth(line);
    const bounds = self.__charBounds[line] ?? [];
    const graphemes = self._textLines[line] ?? [];
    const lineLeft = self._getLineLeftOffset(line);
    const styleAt = (index: number): TextStyleDeclaration =>
      this.getCompleteStyleDeclaration(line, Math.max(0, Math.min(index, graphemes.length - 1))) as TextStyleDeclaration;
    const ellipsisWidth = self._measureChar(ELLIPSIS, styleAt(graphemes.length - 1)).width;
    let low = 0;
    let high = graphemes.length;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineLeft + (bounds[middle]?.left ?? 0) + ellipsisWidth <= this.width) low = middle;
      else high = middle - 1;
    }
    let cut = low;
    while (cut > 0 && /\s/.test(graphemes[cut - 1]!)) cut -= 1;
    const lineHeight = this.getHeightOfLine(line) / this.lineHeight;
    return {
      line,
      cut,
      x: self._getLeftOffset() + lineLeft + (bounds[cut]?.left ?? 0),
      baseline: self._getTopOffset() + lineTop + lineHeight * (1 - self._fontSizeFraction),
      style: styleAt(cut - 1),
    };
  }

  private clipRects(layout: OverflowLayout): Array<[number, number, number, number]> {
    const self = internals(this);
    const left = self._getLeftOffset();
    const top = self._getTopOffset();
    const wide = this.width + this.fontSize * 2;
    const x = left - this.fontSize;
    if (!layout.ellipsis) {
      const bottom = this.overflow === 'clip' || this.isEditing ? this.maxHeight! : layout.visibleHeight;
      return [[x, top - this.fontSize, wide, bottom + this.fontSize]];
    }
    const { line, x: cutX } = layout.ellipsis;
    const lineTop = layout.visibleHeight - this.getHeightOfLine(line);
    const rects: Array<[number, number, number, number]> = [];
    if (lineTop > 0) rects.push([x, top - this.fontSize, wide, lineTop + this.fontSize]);
    rects.push([x, top + lineTop, cutX - x, this.getHeightOfLine(line)]);
    return rects;
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    const layout = this.overflowLayout();
    if (!layout || (!layout.clipped && this.overflow !== 'clip')) {
      super._render(ctx);
      return;
    }
    ctx.save();
    ctx.beginPath();
    for (const [x, y, width, height] of this.clipRects(layout)) ctx.rect(x, y, width, height);
    ctx.clip();
    super._render(ctx);
    ctx.restore();
    const ellipsis = layout.ellipsis;
    if (!ellipsis) return;
    ctx.save();
    ctx.font = internals(this)._getFontDeclaration(ellipsis.style);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = typeof ellipsis.style.fill === 'string' ? ellipsis.style.fill : typeof this.fill === 'string' ? this.fill : '#000';
    ctx.fillText(ELLIPSIS, ellipsis.x, ellipsis.baseline - (ellipsis.style.deltaY ?? 0));
    ctx.restore();
  }

  override _toSVG(): string[] {
    const markup = super._toSVG();
    const layout = this.overflowLayout();
    if (!layout || (!layout.clipped && this.overflow !== 'clip')) return markup;
    clipCounter += 1;
    const id = `fde-bounded-text-${clipCounter}`;
    const rects = this.clipRects(layout)
      .map(([x, y, width, height]) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" />`)
      .join('');
    const result = [`<clipPath id="${id}">${rects}</clipPath>\n<g clip-path="url(#${id})">\n`, ...markup, '</g>\n'];
    const ellipsis = layout.ellipsis;
    if (ellipsis) {
      const style = ellipsis.style;
      const fill = typeof style.fill === 'string' ? style.fill : typeof this.fill === 'string' ? this.fill : '#000';
      const family = String(style.fontFamily ?? this.fontFamily).replace(/"/g, "'");
      result.push(
        `<text xml:space="preserve" x="${ellipsis.x}" y="${ellipsis.baseline - (style.deltaY ?? 0)}" ` +
          `font-family="${family}" font-size="${style.fontSize}" font-style="${style.fontStyle ?? 'normal'}" ` +
          `font-weight="${style.fontWeight ?? 'normal'}" fill="${fill}">${ELLIPSIS}</text>\n`,
      );
    }
    return result;
  }

  override toObject(propertiesToInclude: PropertyKey[] = []): any {
    const object = super.toObject([...BOUNDED_PROPERTIES, ...propertiesToInclude] as never[]) as unknown as Record<string, unknown>;
    if ('fontSize' in object) object.fontSize = this.baseFontSize;
    return object;
  }
}

Object.defineProperty(BoundedTextbox.prototype, 'fontSize', {
  configurable: true,
  enumerable: true,
  get(this: { baseFontSize: number; fitScale?: number }) {
    return this.baseFontSize * (this.fitScale ?? 1);
  },
  set(this: { baseFontSize: number }, value: number) {
    this.baseFontSize = value;
  },
});
