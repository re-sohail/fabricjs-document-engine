import type { FabricObject, TSVGReviver } from 'fabric';

/**
 * Underlines, overlines and line-throughs of straight text as filled boxes.
 * Fabric writes them as CSS `text-decoration`, which browsers draw but
 * svg2pdf ignores, so in a PDF they would disappear. The boxes follow
 * Fabric's own canvas drawing, so the lines land where the canvas shows them
 * and the text itself stays real, selectable text.
 */

type Decoration = 'underline' | 'overline' | 'linethrough';

interface CharBox {
  left: number;
  width: number;
  kernedWidth: number;
}

interface StraightText {
  path?: unknown;
  width: number;
  fontSize: number;
  lineHeight: number;
  direction?: string;
  offsets: Record<Decoration, number>;
  _fontSizeFraction: number;
  _textLines: string[][];
  __charBounds: CharBox[][];
  underline?: boolean;
  overline?: boolean;
  linethrough?: boolean;
  styleHas(property: string, line?: number): boolean;
  getValueOfPropertyAt(line: number, char: number, property: string): unknown;
  getHeightOfLine(line: number): number;
  getHeightOfChar(line: number, char: number): number;
  getLineWidth(line: number): number;
  _getTopOffset(): number;
  _getLeftOffset(): number;
  _getLineLeftOffset(line: number): number;
  _getWidthOfCharSpacing(): number;
  _toSVG(): string[];
  _createBaseSVGMarkup(markup: string[], options: { reviver?: TSVGReviver; noStyle?: boolean; withShadow?: boolean }): string;
}

const DECORATIONS: Decoration[] = ['underline', 'overline', 'linethrough'];

function num(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 10_000) / 10_000) : '0';
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function isText(object: FabricObject): object is FabricObject & StraightText {
  const candidate = object as unknown as Partial<StraightText>;
  return Array.isArray(candidate._textLines) && typeof candidate.getValueOfPropertyAt === 'function' && !candidate.path;
}

export function hasStraightDecorations(object: FabricObject): boolean {
  if (!isText(object)) return false;
  return DECORATIONS.some((type) => object[type] || object.styleHas(type));
}

function rect(x: number, y: number, width: number, height: number, color: unknown): string {
  if (typeof color !== 'string' || width <= 0 || height <= 0) return '';
  return `\t\t<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" fill="${escapeAttribute(color)}" />\n`;
}

/** The same boxes as Fabric's `_renderTextDecoration` for text that is not on a path. */
function decorationRects(text: StraightText, type: Decoration): string {
  if (!text[type] && !text.styleHas(type)) return '';
  let markup = '';
  let topOffset = text._getTopOffset();
  const leftOffset = text._getLeftOffset();
  const charSpacing = text._getWidthOfCharSpacing();
  const aligner = type === 'linethrough' ? 0.5 : type === 'overline' ? 1 : 0;
  const offsetY = text.offsets[type];
  const at = (line: number, char: number, property: string): unknown => text.getValueOfPropertyAt(line, char, property);
  const colorAt = (line: number, char: number): unknown => at(line, char, 'textDecorationColor') || at(line, char, 'fill');
  const thicknessAt = (line: number, char: number): number => Number(at(line, char, 'textDecorationThickness') ?? 66.667);

  for (let lineIndex = 0; lineIndex < text._textLines.length; lineIndex += 1) {
    const heightOfLine = text.getHeightOfLine(lineIndex);
    if (!text[type] && !text.styleHas(type, lineIndex)) {
      topOffset += heightOfLine;
      continue;
    }
    // Fabric measures characters when it draws them.
    if (!text.__charBounds[lineIndex]) text.getLineWidth(lineIndex);
    const line = text._textLines[lineIndex]!;
    const maxHeight = heightOfLine / text.lineHeight;
    const lineLeftOffset = text._getLineLeftOffset(lineIndex);
    const top = topOffset + maxHeight * (1 - text._fontSizeFraction);
    let boxStart = 0;
    let boxWidth = 0;
    let lastDecoration = at(lineIndex, 0, type);
    let lastFill = at(lineIndex, 0, 'fill');
    let lastColor = colorAt(lineIndex, 0);
    let lastThickness = thicknessAt(lineIndex, 0);
    let size = text.getHeightOfChar(lineIndex, 0);
    let dy = Number(at(lineIndex, 0, 'deltaY') ?? 0);
    let currentDecoration = lastDecoration;
    let currentColor = lastColor;
    let currentThickness = lastThickness;
    const startOf = (start: number, width: number): number => {
      const drawStart = leftOffset + lineLeftOffset + start;
      return text.direction === 'rtl' ? text.width - drawStart - width : drawStart;
    };
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const box = text.__charBounds[lineIndex]![charIndex]!;
      currentDecoration = at(lineIndex, charIndex, type);
      const currentFill = at(lineIndex, charIndex, 'fill');
      currentColor = colorAt(lineIndex, charIndex);
      currentThickness = thicknessAt(lineIndex, charIndex);
      const currentSize = text.getHeightOfChar(lineIndex, charIndex);
      const currentDy = Number(at(lineIndex, charIndex, 'deltaY') ?? 0);
      const changed =
        currentDecoration !== lastDecoration ||
        currentFill !== lastFill ||
        currentColor !== lastColor ||
        currentSize !== size ||
        currentThickness !== lastThickness ||
        currentDy !== dy;
      if (changed && boxWidth > 0) {
        const thickness = (text.fontSize * lastThickness) / 1000;
        if (lastDecoration && lastColor && lastThickness) {
          markup += rect(startOf(boxStart, boxWidth), top + offsetY * size + dy - aligner * thickness, boxWidth, thickness, lastColor);
        }
        boxStart = box.left;
        boxWidth = box.width;
        lastDecoration = currentDecoration;
        lastColor = currentColor;
        lastThickness = currentThickness;
        lastFill = currentFill;
        size = currentSize;
        dy = currentDy;
      } else {
        boxWidth += box.kernedWidth;
      }
    }
    const thickness = (text.fontSize * currentThickness) / 1000;
    if (currentDecoration && currentColor && currentThickness) {
      markup += rect(startOf(boxStart, boxWidth), top + offsetY * size + dy - aligner * thickness, boxWidth - charSpacing, thickness, currentColor);
    }
    topOffset += heightOfLine;
  }
  return markup;
}

/** SVG for straight text with its decorations as boxes instead of CSS. */
export function decoratedTextToSVG(object: FabricObject, reviver?: TSVGReviver): string {
  const text = object as unknown as StraightText;
  const inner = text
    ._toSVG()
    .join('')
    .replace(/\stext-decoration="[^"]*"/g, '')
    .replace(/text-decoration:[^;"]*;?\s*/g, '');
  const markup = [
    decorationRects(text, 'underline'),
    inner,
    decorationRects(text, 'overline'),
    decorationRects(text, 'linethrough'),
  ];
  return text._createBaseSVGMarkup(markup, { reviver, noStyle: true, withShadow: true });
}
