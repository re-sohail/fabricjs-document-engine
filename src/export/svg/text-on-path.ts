import { Color, util } from 'fabric';
import type { FabricObject, Path, StaticCanvas, TSVGReviver } from 'fabric';
import { walkObjects } from '../../fabric/walk-objects';
import { withSvgOverrides } from './overrides';

/**
 * SVG for text that follows a path (fabric.js #6958).
 *
 * Fabric writes text on a path as one rotated <tspan> per character. That
 * output ignores `pathAlign`, moves `deltaY` along the wrong axis, draws
 * text backgrounds and underlines as straight boxes, and places the guide
 * path in the wrong spot. This module writes the same drawing Fabric makes
 * on the canvas instead: every character is its own <text> in the rotated
 * frame Fabric computed, with its background and decorations drawn in that
 * frame too. Every SVG reader (browsers, Illustrator, Inkscape, svg2pdf)
 * understands plain transformed <text>, unlike <textPath>.
 */

interface CharBox {
  width: number;
  kernedWidth: number;
  renderLeft?: number;
  renderTop?: number;
  angle?: number;
}

interface Filler {
  id: string | number;
  toSVG(object: FabricObject): string;
  type?: string;
}

interface CharStyle {
  fill?: unknown;
  stroke?: unknown;
  strokeWidth?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fontStyle?: string;
  deltaY?: number;
  textBackgroundColor?: string;
  underline?: boolean;
  overline?: boolean;
  linethrough?: boolean;
  textDecorationColor?: string;
  textDecorationThickness?: number;
}

/** The parts of Fabric's text classes this module reads. Most are internal to Fabric. */
interface PathText {
  path: (Path & { segmentsInfo?: unknown; pathOffset: { x: number; y: number } }) | undefined;
  pathAlign?: string;
  direction?: string;
  paintFirst?: string;
  fontSize: number;
  backgroundColor?: string;
  strokeUniform?: boolean;
  strokeDashArray?: number[] | null;
  strokeLineCap?: string;
  strokeLineJoin?: string;
  strokeMiterLimit?: number;
  opacity: number;
  visible: boolean;
  offsets: { underline: number; linethrough: number; overline: number };
  _fontSizeFraction: number;
  _textLines: string[][];
  __charBounds: CharBox[][];
  setPathInfo(): void;
  initDimensions(): void;
  getCompleteStyleDeclaration(line: number, char: number): CharStyle;
  getHeightOfLineImpl(line: number): number;
  getHeightOfChar(line: number, char: number): number;
  getLineWidth(line: number): number;
  _getFontDeclaration(style?: CharStyle): string;
  _getNonTransformedDimensions(): { x: number; y: number };
  _createBaseSVGMarkup(markup: string[], options: { reviver?: TSVGReviver; noStyle?: boolean; withShadow?: boolean }): string;
  toSVG(reviver?: TSVGReviver): string;
}

export function isTextOnPath(object: FabricObject): boolean {
  const candidate = object as unknown as Partial<PathText>;
  return Boolean(candidate.path) && Array.isArray(candidate._textLines) && typeof candidate.getCompleteStyleDeclaration === 'function';
}

const DIGITS = 4;

function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(DIGITS);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') || '0' : fixed;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** CSS values that could break out of a style attribute are dropped, as Fabric 7 does. */
function safeToken(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (text.length === 0 || /[;<>{}\\]|url\(|expression\(|javascript:|data:/i.test(text)) return undefined;
  return text;
}

function isFiller(value: unknown): value is Filler {
  return typeof value === 'object' && value !== null && typeof (value as Filler).toSVG === 'function';
}

/** `fill: rgb(...); fill-opacity: a` for a color, `url(#SVGID_id)` for a gradient or pattern. */
function paint(property: 'fill' | 'stroke', value: unknown): string {
  if (isFiller(value)) return `${property}: url(#SVGID_${value.id}); `;
  const token = typeof value === 'string' ? safeToken(value) : undefined;
  if (token === undefined || token === 'none' || token === 'transparent') return `${property}: none; `;
  const color = new Color(token);
  const alpha = color.getAlpha();
  const rgb = color.toRgb();
  return alpha === 1 ? `${property}: ${rgb}; ` : `${property}: ${rgb}; ${property}-opacity: ${num(alpha)}; `;
}

function strokeDetails(text: PathText, strokeWidth: number): string {
  let style = `stroke-width: ${num(strokeWidth)}; `;
  if (text.strokeDashArray && text.strokeDashArray.length > 0) style += `stroke-dasharray: ${text.strokeDashArray.map(num).join(' ')}; `;
  const cap = safeToken(text.strokeLineCap);
  const join = safeToken(text.strokeLineJoin);
  if (cap) style += `stroke-linecap: ${cap}; `;
  if (join) style += `stroke-linejoin: ${join}; `;
  if (text.strokeMiterLimit !== undefined) style += `stroke-miterlimit: ${num(text.strokeMiterLimit)}; `;
  return style;
}

function fontStyle(style: CharStyle): string {
  const family = safeToken(String(style.fontFamily ?? '').replace(/"/g, "'"));
  const weight = safeToken(style.fontWeight);
  const slant = safeToken(style.fontStyle);
  let css = '';
  if (family) css += `font-family: ${family}; `;
  css += `font-size: ${num(style.fontSize ?? 0)}px; `;
  if (weight) css += `font-weight: ${weight}; `;
  if (slant) css += `font-style: ${slant}; `;
  return css;
}

function frame(box: CharBox): string {
  const angle = box.angle ?? 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return `matrix(${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(box.renderLeft ?? 0)} ${num(box.renderTop ?? 0)})`;
}

let measuringContext: CanvasRenderingContext2D | null | undefined;

function measuring(): CanvasRenderingContext2D | null {
  if (measuringContext === undefined) {
    measuringContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  return measuringContext;
}

const baselineShifts = new Map<string, number>();

/**
 * How far below the path the alphabetic baseline sits when Fabric draws with
 * `pathAlign` (the canvas `textBaseline`). SVG has no portable way to say
 * this, so the shift is measured and written as a plain offset.
 */
function baselineShift(font: string, pathAlign: string | undefined): number {
  const baseline = pathAlign === 'center' ? 'middle' : pathAlign === 'ascender' ? 'top' : pathAlign === 'descender' ? 'bottom' : undefined;
  if (baseline === undefined) return 0;
  const key = `${baseline}|${font}`;
  const known = baselineShifts.get(key);
  if (known !== undefined) return known;
  const context = measuring();
  let shift = 0;
  if (context) {
    context.font = font;
    context.textBaseline = baseline;
    // The distance from the `textBaseline` line to the alphabetic baseline;
    // the alphabetic baseline lies below a top or middle line.
    shift = -context.measureText('M').alphabeticBaseline;
    if (!Number.isFinite(shift)) shift = 0;
  }
  baselineShifts.set(key, shift);
  return shift;
}

function guidePath(text: PathText): string {
  const path = text.path;
  if (!path || !path.visible || path.opacity === 0) return '';
  const pathData = util.joinPath(path.path, DIGITS);
  const strokeWidth = path.strokeWidth ?? 1;
  let style = paint('fill', path.fill);
  if (path.fillRule === 'evenodd') style += 'fill-rule: evenodd; ';
  style += paint('stroke', path.stroke);
  if (path.stroke) style += strokeDetails(path as unknown as PathText, strokeWidth);
  return `\t\t<path d="${escapeXml(pathData)}" transform="translate(${num(-path.pathOffset.x)} ${num(-path.pathOffset.y)})" style="${style}" />\n`;
}

function fillerDefinitions(text: PathText & FabricObject): string {
  const seen = new Set<string | number>();
  // Gradients set on the object are written by Fabric's own wrapper.
  if (isFiller(text.fill)) seen.add(text.fill.id);
  if (isFiller(text.stroke)) seen.add(text.stroke.id);
  const path = text.path;
  let markup = '';
  const add = (value: unknown, owner: FabricObject): void => {
    if (!isFiller(value) || seen.has(value.id)) return;
    seen.add(value.id);
    markup += value.toSVG(owner);
  };
  if (path && path.visible && path.opacity !== 0) {
    add(path.fill, path);
    add(path.stroke, path);
  }
  text._textLines.forEach((line, lineIndex) =>
    line.forEach((_, charIndex) => {
      const style = text.getCompleteStyleDeclaration(lineIndex, charIndex);
      add(style.fill, text);
      add(style.stroke, text);
    }),
  );
  return markup;
}

type Decoration = 'underline' | 'overline' | 'linethrough';

function decorationRects(text: PathText, type: Decoration): string {
  const aligner = type === 'linethrough' ? 0.5 : type === 'overline' ? 1 : 0;
  let markup = '';
  text._textLines.forEach((line, lineIndex) => {
    line.forEach((_, charIndex) => {
      const style = text.getCompleteStyleDeclaration(lineIndex, charIndex);
      if (!style[type] || !style.fill) return;
      const box = text.__charBounds[lineIndex]![charIndex]!;
      const thickness = (text.fontSize * (style.textDecorationThickness ?? 66.667)) / 1000;
      const size = text.getHeightOfChar(lineIndex, charIndex);
      const top = text.offsets[type] * size + (style.deltaY ?? 0) - aligner * thickness;
      const color = style.textDecorationColor || style.fill;
      markup +=
        `\t\t<rect transform="${frame(box)}" x="${num(-box.kernedWidth / 2)}" y="${num(top)}" ` +
        `width="${num(box.kernedWidth)}" height="${num(thickness)}" style="${paint('fill', color)}" />\n`;
    });
  });
  return markup;
}

function textBackgrounds(text: PathText): string {
  let markup = '';
  text._textLines.forEach((line, lineIndex) => {
    const height = text.getHeightOfLineImpl(lineIndex);
    line.forEach((_, charIndex) => {
      const color = text.getCompleteStyleDeclaration(lineIndex, charIndex).textBackgroundColor;
      if (!color) return;
      const box = text.__charBounds[lineIndex]![charIndex]!;
      markup +=
        `\t\t<rect transform="${frame(box)}" x="${num(-box.width / 2)}" y="${num(-height * (1 - text._fontSizeFraction))}" ` +
        `width="${num(box.width)}" height="${num(height)}" style="${paint('fill', color)}" />\n`;
    });
  });
  return markup;
}

/** One pass of characters: Fabric fills every character, then strokes every character (or the reverse). */
function glyphs(text: PathText, pass: 'fill' | 'stroke'): string {
  const rtl = text.direction === 'rtl';
  const nonScaling = text.strokeUniform ? ' vector-effect="non-scaling-stroke"' : '';
  let markup = '';
  text._textLines.forEach((line, lineIndex) => {
    line.forEach((grapheme, charIndex) => {
      if (grapheme.trim().length === 0) return;
      const style = text.getCompleteStyleDeclaration(lineIndex, charIndex);
      const strokeWidth = style.strokeWidth ?? 0;
      if (pass === 'fill' && !style.fill) return;
      if (pass === 'stroke' && (!style.stroke || strokeWidth === 0)) return;
      const box = text.__charBounds[lineIndex]![charIndex]!;
      const font = text._getFontDeclaration(style);
      const y = baselineShift(font, text.pathAlign) + (style.deltaY ?? 0);
      const paintStyle =
        pass === 'fill' ? `${paint('fill', style.fill)}stroke: none; ` : `fill: none; ${paint('stroke', style.stroke)}${strokeDetails(text, strokeWidth)}`;
      // Fabric draws right-to-left characters with their right edge at the start point.
      const anchor = rtl ? ' text-anchor="end"' : '';
      markup +=
        `\t\t<text xml:space="preserve" transform="${frame(box)}" x="${num(-box.width / 2)}" y="${num(y)}"${anchor}${nonScaling} ` +
        `style="${fontStyle(style)}${paintStyle}white-space: pre;">${escapeXml(grapheme)}</text>\n`;
    });
  });
  return markup;
}

function objectStyle(text: PathText): string {
  const parts: string[] = [];
  if (text.opacity !== 1) parts.push(`opacity: ${num(text.opacity)};`);
  if (!text.visible) parts.push('visibility: hidden;');
  return parts.length > 0 ? ` style="${parts.join(' ')}"` : '';
}

function boxBackground(text: PathText): string {
  const color = text.backgroundColor;
  if (!color) return '';
  const { x, y } = text._getNonTransformedDimensions();
  return `\t\t<rect x="${num(-x / 2)}" y="${num(-y / 2)}" width="${num(x)}" height="${num(y)}" style="${paint('fill', color)}" />\n`;
}

/**
 * Makes sure every character has its place on the path. Fabric measures
 * characters when it first draws them, and not at all when `path` was
 * assigned directly instead of through `set` or the constructor.
 */
function layOut(text: PathText): void {
  const measured = (): boolean =>
    text._textLines.every((line, index) => line.length === 0 || text.__charBounds?.[index]?.[0]?.renderLeft !== undefined);
  if (!(text.path as { segmentsInfo?: unknown } | undefined)?.segmentsInfo) {
    text.setPathInfo();
    text.initDimensions();
  }
  text._textLines.forEach((_, index) => {
    if (text.__charBounds?.[index]?.[0]?.renderLeft === undefined) text.getLineWidth(index);
  });
  if (!measured()) {
    text.setPathInfo();
    text.initDimensions();
    text._textLines.forEach((_, index) => text.getLineWidth(index));
  }
}

/** The SVG for one text on a path, in the same order Fabric draws it on the canvas. */
export function textOnPathToSVG(object: FabricObject, reviver?: TSVGReviver): string {
  const text = object as unknown as PathText & FabricObject;
  layOut(text);
  const strokeFirst = text.paintFirst === 'stroke';
  const body = [
    fillerDefinitions(text),
    `\t<g${objectStyle(text)}>\n`,
    boxBackground(text),
    guidePath(text),
    textBackgrounds(text),
    decorationRects(text, 'underline'),
    strokeFirst ? glyphs(text, 'stroke') : glyphs(text, 'fill'),
    strokeFirst ? glyphs(text, 'fill') : glyphs(text, 'stroke'),
    decorationRects(text, 'overline'),
    decorationRects(text, 'linethrough'),
    '\t</g>\n',
  ];
  return text._createBaseSVGMarkup(body, { reviver, noStyle: true, withShadow: true });
}

/**
 * Runs `work` while every text on a path on the canvas, including text in
 * groups, writes the SVG from this module. Everything else keeps Fabric's
 * SVG. Returns how many objects were handled.
 */
export function withTextOnPathSVG<Result>(canvas: StaticCanvas, work: () => Result): { result: Result; count: number } {
  return withSvgOverrides(
    canvas,
    (object) => (isTextOnPath(object) ? (reviver?: TSVGReviver) => textOnPathToSVG(object, reviver) : undefined),
    work,
  );
}

export function findTextOnPath(canvas: StaticCanvas): FabricObject[] {
  const found: FabricObject[] = [];
  walkObjects(canvas.getObjects(), (object) => {
    if (isTextOnPath(object)) found.push(object);
  });
  return found;
}

