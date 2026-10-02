import type { FabricObject, StaticCanvas } from 'fabric';
import { walkObjects } from '../../fabric/walk-objects';
import { DEFAULT_MAX_CANVAS_PIXELS, DEFAULT_MAX_CANVAS_SIDE } from '../../security/content-limits';
import type { ContentLimits } from '../../security/content-limits';

/*
 * One object drawn as a picture, placed where it sits on the canvas, for
 * effects an SVG or PDF reader cannot draw from vectors.
 */

/**
 * The largest multiplier that keeps a `width × height` area within the
 * canvas limits. A picture over the browser's limit would fail, so a large
 * page is drawn at a lower resolution instead: O(1) arithmetic.
 */
export function safeMultiplier(multiplier: number, width: number, height: number, limits: ContentLimits | undefined): number {
  const maxPixels = limits?.maxCanvasPixels ?? DEFAULT_MAX_CANVAS_PIXELS;
  const maxSide = limits?.maxCanvasSide ?? DEFAULT_MAX_CANVAS_SIDE;
  const byArea = Math.sqrt(maxPixels / Math.max(1, width * height));
  const bySide = maxSide / Math.max(1, width, height);
  return Math.min(multiplier, byArea, bySide);
}
function shadowPadding(object: FabricObject): number {
  let padding = 0;
  walkObjects([object], (child) => {
    const shadow = child.shadow;
    if (shadow) padding = Math.max(padding, shadow.blur + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)));
  });
  return padding + 2;
}

function usesBlendMode(object: FabricObject): boolean {
  let blends = false;
  walkObjects([object], (child) => {
    if (child.globalCompositeOperation && child.globalCompositeOperation !== 'source-over') blends = true;
  });
  return blends;
}

/**
 * An object as a picture placed where it sits on the canvas. Usually the
 * object alone, so the vectors underneath show through. An object with a
 * blend mode mixes with what lies below it, so its picture includes
 * everything below it within its bounds, which covers those vectors exactly.
 */
export function rasterMarkup(canvas: StaticCanvas, object: FabricObject, multiplier: number, limits?: ContentLimits): string {
  object.setCoords();
  const bounds = object.getBoundingRect();
  const padding = shadowPadding(object);
  const left = Math.max(0, Math.floor(bounds.left - padding));
  const top = Math.max(0, Math.floor(bounds.top - padding));
  const right = Math.min(canvas.getWidth(), Math.ceil(bounds.left + bounds.width + padding));
  const bottom = Math.min(canvas.getHeight(), Math.ceil(bounds.top + bounds.height + padding));
  if (right <= left || bottom <= top) return '';
  const blends = usesBlendMode(object);
  const stack = canvas.getObjects();
  const position = stack.indexOf(object);
  const saved = {
    backgroundColor: canvas.backgroundColor,
    backgroundImage: canvas.backgroundImage,
    overlayColor: canvas.overlayColor,
    overlayImage: canvas.overlayImage,
  };
  if (!blends) {
    canvas.backgroundColor = '';
    canvas.backgroundImage = undefined;
  }
  canvas.overlayColor = '';
  canvas.overlayImage = undefined;
  let element: HTMLCanvasElement;
  try {
    const filter = (candidate: unknown): boolean =>
      blends ? stack.indexOf(candidate as FabricObject) <= position : candidate === object;
    const safe = safeMultiplier(multiplier, right - left, bottom - top, limits);
    element = canvas.toCanvasElement(safe, { left, top, width: right - left, height: bottom - top, filter });
  } finally {
    Object.assign(canvas, saved);
  }
  const url = element.toDataURL('image/png');
  element.width = 0;
  element.height = 0;
  return `<image x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" preserveAspectRatio="none" xlink:href="${url}" />\n`;
}

