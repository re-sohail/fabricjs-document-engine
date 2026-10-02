import { IText, util } from 'fabric';
import type { TextStyleDeclaration, TPointerEvent } from 'fabric';
import { Orientation, orientationOf } from './vertical-orientation';

export type TextOrientation = 'mixed' | 'upright';
export type CombineUpright = 'none' | 'digits2';

export interface VerticalTextProps {
  textOrientation: TextOrientation;
  combineUpright: CombineUpright;
}

const VERTICAL_PROPERTIES = ['textOrientation', 'combineUpright'] as const;

const UPRIGHT = 0;
const ROTATED = 1;
const SHIFTED = 2;
const COMBINED = 3;
const COMBINED_REST = 4;

type Box = { left: number; width: number; kernedWidth: number; height: number; deltaY: number };

interface TextInternals {
  __charBounds: Box[][];
  _textLines: string[][];
  _fontSizeFraction: number;
  _currentCursorOpacity: number;
  charSpacing: number;
  _getWidthOfCharSpacing(): number;
  _getFontDeclaration(style?: TextStyleDeclaration): string;
}

const VERTICAL_KEYS: Record<number, string> = {
  9: 'exitEditing',
  27: 'exitEditing',
  33: 'moveCursorLeft',
  34: 'moveCursorRight',
  35: 'moveCursorRight',
  36: 'moveCursorLeft',
  37: 'moveCursorDown',
  38: 'moveCursorLeft',
  39: 'moveCursorUp',
  40: 'moveCursorRight',
};

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const isDigit = (grapheme: string | undefined): boolean => grapheme !== undefined && /^[0-9]$/.test(grapheme);

function paint(value: unknown, ctx: CanvasRenderingContext2D): string | CanvasGradient | CanvasPattern {
  if (typeof value === 'string') return value;
  const live = (value as { toLive?: (context: CanvasRenderingContext2D) => CanvasGradient | CanvasPattern | null } | null)?.toLive?.(ctx);
  return live ?? '#000';
}

export class VerticalText extends IText {
  static override type = 'VerticalText';

  static override textLayoutProperties: string[] = [...IText.textLayoutProperties, ...VERTICAL_PROPERTIES];

  static override cacheProperties: string[] = [...IText.cacheProperties, ...VERTICAL_PROPERTIES];

  static verticalDefaults: VerticalTextProps & { keysMap: Record<number, string>; keysMapRtl: Record<number, string> } = {
    textOrientation: 'mixed',
    combineUpright: 'none',
    keysMap: VERTICAL_KEYS,
    keysMapRtl: VERTICAL_KEYS,
  };

  static override getDefaults(): Record<string, unknown> {
    return { ...super.getDefaults(), ...VerticalText.verticalDefaults };
  }

  declare textOrientation: TextOrientation;
  declare combineUpright: CombineUpright;
  private declare glyphKinds: Uint8Array[];

  constructor(text: string, options: Partial<VerticalTextProps> & ConstructorParameters<typeof IText>[1] = {}) {
    super(text, { ...VerticalText.verticalDefaults, ...options } as never);
  }

  private self(): TextInternals {
    return this as unknown as TextInternals;
  }

  private kindsOf(lineIndex: number): Uint8Array {
    const line = this.self()._textLines[lineIndex] ?? [];
    const kinds = new Uint8Array(line.length);
    for (let index = 0; index < line.length; index += 1) {
      if (this.textOrientation === 'upright') {
        kinds[index] = UPRIGHT;
        continue;
      }
      const orientation = orientationOf(line[index]!);
      kinds[index] = orientation === Orientation.Upright ? UPRIGHT : orientation === Orientation.UprightShifted ? SHIFTED : ROTATED;
    }
    if (this.combineUpright === 'digits2') {
      for (let index = 0; index < line.length; ) {
        if (!isDigit(line[index])) {
          index += 1;
          continue;
        }
        let end = index;
        while (isDigit(line[end])) end += 1;
        if (end - index <= 2) {
          kinds[index] = COMBINED;
          for (let rest = index + 1; rest < end; rest += 1) kinds[rest] = COMBINED_REST;
        }
        index = end;
      }
    }
    return kinds;
  }

  private kindAt(lineIndex: number, charIndex: number): number {
    return this.glyphKinds?.[lineIndex]?.[charIndex] ?? ROTATED;
  }

  override _measureLine(lineIndex: number): { width: number; numOfSpaces: number } {
    this.glyphKinds ??= [];
    this.glyphKinds[lineIndex] = this.kindsOf(lineIndex);
    return super._measureLine(lineIndex);
  }

  override _getGraphemeBox(grapheme: string, lineIndex: number, charIndex: number, previous?: string, skipLeft?: boolean): Box {
    const kind = this.kindAt(lineIndex, charIndex);
    const previousTurns = charIndex > 0 && this.kindAt(lineIndex, charIndex - 1) === ROTATED;
    const box = super._getGraphemeBox(grapheme, lineIndex, charIndex, kind === ROTATED && previousTurns ? previous : undefined, true) as Box;
    if (kind !== ROTATED) {
      const spacing = this.self().charSpacing !== 0 ? this.self()._getWidthOfCharSpacing() : 0;
      box.width = box.kernedWidth = kind === COMBINED_REST ? 0 : box.height + spacing;
    }
    if (!skipLeft && charIndex > 0) {
      const before = this.self().__charBounds[lineIndex]![charIndex - 1]!;
      box.left = before.left + before.width + box.kernedWidth - box.width;
    }
    return box;
  }

  override initDimensions(): void {
    super.initDimensions();
    const along = this.height;
    this.height = this.width;
    this.width = along;
  }

  override _getLineLeftOffset(lineIndex: number): number {
    const free = this.height - this.getLineWidth(lineIndex);
    if (this.textAlign.includes('center')) return free / 2;
    if (this.textAlign.endsWith('right')) return free;
    return 0;
  }

  private column(lineIndex: number): { right: number; em: number; thickness: number; top: number } {
    let right = this.width / 2;
    for (let index = 0; index < lineIndex; index += 1) right -= this.getHeightOfLine(index);
    const thickness = this.getHeightOfLine(lineIndex);
    return { right, em: thickness / this.lineHeight, thickness, top: -this.height / 2 + this._getLineLeftOffset(lineIndex) };
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    const self = this.self();
    const fraction = self._fontSizeFraction;
    ctx.save();
    for (let line = 0; line < self._textLines.length; line += 1) {
      const graphemes = self._textLines[line]!;
      const bounds = self.__charBounds[line] ?? [];
      const { right, em, top } = this.column(line);
      const center = right - em / 2;
      let index = 0;
      while (index < graphemes.length) {
        const kind = this.kindAt(line, index);
        const style = this.getCompleteStyleDeclaration(line, index) as TextStyleDeclaration & { fontSize: number };
        const y = top + bounds[index]!.left;
        let end = index + 1;
        if (kind === ROTATED) {
          while (end < graphemes.length && this.kindAt(line, end) === ROTATED && !util.hasStyleChanged(style, this.getCompleteStyleDeclaration(line, end), false)) end += 1;
        } else if (kind === COMBINED) {
          while (end < graphemes.length && this.kindAt(line, end) === COMBINED_REST) end += 1;
        }
        const text = graphemes.slice(index, end).join('');
        const advance = top + bounds[end - 1]!.left + bounds[end - 1]!.width - y;
        this.drawBackgroundAndLines(ctx, style, right, em, y, advance);
        if (text.trim() !== '') {
          ctx.font = self._getFontDeclaration(style);
          ctx.fillStyle = paint(style.fill, ctx);
          ctx.textBaseline = 'alphabetic';
          const baseline = (0.5 - fraction) * style.fontSize;
          ctx.save();
          if (kind === ROTATED) {
            ctx.textAlign = 'left';
            ctx.translate(center, y);
            ctx.rotate(Math.PI / 2);
            this.drawGlyphs(ctx, style, text, 0, baseline);
          } else {
            ctx.textAlign = 'center';
            let x = center;
            let glyphY = y + style.fontSize / 2 + baseline;
            if (kind === SHIFTED) {
              x += style.fontSize / 2;
              glyphY -= style.fontSize / 2;
            }
            if (kind === COMBINED) {
              const width = ctx.measureText(text).width;
              const squeeze = Math.min(1, (style.fontSize * 0.95) / width);
              ctx.translate(x, glyphY);
              ctx.scale(squeeze, 1);
              x = 0;
              glyphY = 0;
            }
            this.drawGlyphs(ctx, style, text, x, glyphY);
          }
          ctx.restore();
        }
        index = end;
      }
    }
    ctx.restore();
  }

  private drawGlyphs(ctx: CanvasRenderingContext2D, style: TextStyleDeclaration, text: string, x: number, y: number): void {
    ctx.fillText(text, x, y);
    if (style.stroke && style.strokeWidth) {
      ctx.strokeStyle = paint(style.stroke, ctx);
      ctx.lineWidth = style.strokeWidth;
      ctx.strokeText(text, x, y);
    }
  }

  private drawBackgroundAndLines(ctx: CanvasRenderingContext2D, style: TextStyleDeclaration & { fontSize: number }, right: number, em: number, y: number, advance: number): void {
    if (style.textBackgroundColor) {
      ctx.fillStyle = paint(style.textBackgroundColor, ctx);
      ctx.fillRect(right - em, y, em, advance);
    }
    const thickness = style.fontSize / 15;
    ctx.fillStyle = paint(style.textDecorationColor || style.fill, ctx);
    if (style.underline) ctx.fillRect(right - thickness, y, thickness, advance);
    if (style.overline) ctx.fillRect(right - em, y, thickness, advance);
    if (style.linethrough) ctx.fillRect(right - em / 2 - thickness / 2, y, thickness, advance);
  }

  private cursorPoint(index: number): { x: number; y: number; width: number; line: number; char: number } {
    const { lineIndex, charIndex } = this.get2DCursorLocation(index);
    const { right, em, top } = this.column(lineIndex);
    const bounds = this.self().__charBounds[lineIndex] ?? [];
    return { x: right - em, y: top + (bounds[charIndex]?.left ?? 0), width: em, line: lineIndex, char: charIndex };
  }

  override _getCursorBoundaries(index: number = this.selectionStart): ReturnType<IText['_getCursorBoundaries']> {
    const point = this.cursorPoint(index);
    const charHeight = this.getValueOfPropertyAt(point.line, Math.max(0, point.char - 1), 'fontSize') * this.lineHeight;
    return { left: point.x, top: point.y - charHeight, leftOffset: 0, topOffset: 0 };
  }

  override _renderCursor(ctx: CanvasRenderingContext2D, _boundaries: unknown, selectionStart: number): void {
    const point = this.cursorPoint(selectionStart);
    const scale = this.getObjectScaling().y * (this.canvas?.getZoom() ?? 1);
    const thickness = this.cursorWidth / scale;
    ctx.fillStyle = this.cursorColor || (this.getValueOfPropertyAt(point.line, Math.max(0, point.char - 1), 'fill') as string);
    ctx.globalAlpha = this.self()._currentCursorOpacity;
    ctx.fillRect(point.x, point.y - thickness / 2, point.width, thickness);
  }

  override _renderSelection(ctx: CanvasRenderingContext2D, selection: { selectionStart: number; selectionEnd: number }): void {
    const start = this.get2DCursorLocation(selection.selectionStart);
    const end = this.get2DCursorLocation(selection.selectionEnd);
    const charBounds = this.self().__charBounds;
    const composing = Boolean((this as unknown as { inCompositionMode?: boolean }).inCompositionMode);
    ctx.fillStyle = composing ? this.cursorColor || '#000' : this.selectionColor;
    for (let line = start.lineIndex; line <= end.lineIndex; line += 1) {
      const { right, em, thickness, top } = this.column(line);
      const from = line === start.lineIndex ? (charBounds[line]?.[start.charIndex]?.left ?? 0) : 0;
      const to = line === end.lineIndex ? (charBounds[line]?.[end.charIndex]?.left ?? 0) : this.getLineWidth(line) || em / 4;
      if (composing) ctx.fillRect(right - 1, top + from, 1, to - from);
      else ctx.fillRect(right - (line === end.lineIndex ? em : thickness), top + from, line === end.lineIndex ? em : thickness, to - from);
    }
  }

  override getSelectionStartFromPointer(event: TPointerEvent): number {
    const point = this.canvas!.getScenePoint(event).transform(util.invertTransform(this.calcTransformMatrix()));
    const lines = this.self()._textLines;
    let fromRight = this.width / 2 - point.x;
    let line = 0;
    while (line < lines.length - 1 && fromRight > this.getHeightOfLine(line)) {
      fromRight -= this.getHeightOfLine(line);
      line += 1;
    }
    const bounds = this.self().__charBounds[line] ?? [];
    const length = lines[line]!.length;
    const y = point.y - this.column(line).top;
    let low = 0;
    let high = length;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      const box = bounds[middle - 1]!;
      if (box.left + box.width / 2 <= y) low = middle;
      else high = middle - 1;
    }
    let index = low;
    for (let previous = 0; previous < line; previous += 1) index += lines[previous]!.length + 1;
    return Math.min(index, (this as unknown as { _text: string[] })._text.length);
  }

  override _toSVG(): string[] {
    const self = this.self();
    const fraction = self._fontSizeFraction;
    const parts: string[] = [];
    const number = (value: number): string => String(Math.round(value * 1000) / 1000);
    for (let line = 0; line < self._textLines.length; line += 1) {
      const graphemes = self._textLines[line]!;
      const bounds = self.__charBounds[line] ?? [];
      const { right, em, top } = this.column(line);
      const center = right - em / 2;
      let index = 0;
      while (index < graphemes.length) {
        const kind = this.kindAt(line, index);
        const style = this.getCompleteStyleDeclaration(line, index) as TextStyleDeclaration & { fontSize: number };
        const y = top + bounds[index]!.left;
        let end = index + 1;
        if (kind === ROTATED) {
          while (end < graphemes.length && this.kindAt(line, end) === ROTATED && !util.hasStyleChanged(style, this.getCompleteStyleDeclaration(line, end), false)) end += 1;
        } else if (kind === COMBINED) {
          while (end < graphemes.length && this.kindAt(line, end) === COMBINED_REST) end += 1;
        }
        const text = graphemes.slice(index, end).join('');
        const advance = top + bounds[end - 1]!.left + bounds[end - 1]!.width - y;
        const fill = typeof style.fill === 'string' ? style.fill : '#000';
        if (typeof style.textBackgroundColor === 'string' && style.textBackgroundColor) {
          parts.push(`<rect x="${number(right - em)}" y="${number(y)}" width="${number(em)}" height="${number(advance)}" fill="${escapeXml(style.textBackgroundColor)}" />\n`);
        }
        const thickness = style.fontSize / 15;
        const lineColor = typeof (style.textDecorationColor || style.fill) === 'string' ? ((style.textDecorationColor || style.fill) as string) : '#000';
        for (const [on, x] of [
          [style.underline, right - thickness],
          [style.overline, right - em],
          [style.linethrough, right - em / 2 - thickness / 2],
        ] as const) {
          if (on) parts.push(`<rect x="${number(x)}" y="${number(y)}" width="${number(thickness)}" height="${number(advance)}" fill="${escapeXml(lineColor)}" />\n`);
        }
        if (text.trim() !== '') {
          const family = String(style.fontFamily ?? this.fontFamily);
          const quoted = /^['"]|,/.test(family) ? family : `'${family}'`;
          const stroke = style.stroke && style.strokeWidth && typeof style.stroke === 'string' ? ` stroke="${escapeXml(style.stroke)}" stroke-width="${style.strokeWidth}"` : '';
          const font = `font-family="${escapeXml(quoted)}" font-size="${number(style.fontSize)}" font-style="${style.fontStyle ?? 'normal'}" font-weight="${style.fontWeight ?? 'normal'}" fill="${escapeXml(fill)}"${stroke}`;
          const baseline = (0.5 - fraction) * style.fontSize;
          if (kind === ROTATED) {
            parts.push(`<text xml:space="preserve" transform="translate(${number(center)} ${number(y)}) rotate(90)" x="0" y="${number(baseline)}" ${font}>${escapeXml(text)}</text>\n`);
          } else {
            let x = center;
            let glyphY = y + style.fontSize / 2 + baseline;
            if (kind === SHIFTED) {
              x += style.fontSize / 2;
              glyphY -= style.fontSize / 2;
            }
            let transform = '';
            if (kind === COMBINED) {
              const context = util.createCanvasElement().getContext('2d')!;
              context.font = self._getFontDeclaration(style);
              const squeeze = Math.min(1, (style.fontSize * 0.95) / context.measureText(text).width);
              transform = ` transform="translate(${number(x)} ${number(glyphY)}) scale(${number(squeeze)} 1)"`;
              x = 0;
              glyphY = 0;
            }
            parts.push(`<text xml:space="preserve"${transform} x="${number(x)}" y="${number(glyphY)}" text-anchor="middle" ${font}>${escapeXml(text)}</text>\n`);
          }
        }
        index = end;
      }
    }
    return ['<g>\n', ...parts, '</g>\n'];
  }

  override toObject(propertiesToInclude: PropertyKey[] = []): any {
    return super.toObject([...VERTICAL_PROPERTIES, ...propertiesToInclude] as never[]);
  }
}
