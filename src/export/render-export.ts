import type { StaticCanvas, TMat2D } from 'fabric';
import type { ExportBackground, ExportFormat, ExportRect, NormalizedSvgOptions } from './export-options';
import type { FabricObject, TSVGReviver } from 'fabric';
import { readObjectId } from '../fabric/object-ids';
import type { ContentLimits } from '../security/content-limits';
import { hasNestedClipPath, ownClipPathIsInverted, writeWithInvertedMask } from './svg/clip-masks';
import { withSvgOverrides } from './svg/overrides';
import { rasterMarkup } from './svg/raster-object';
import { decoratedTextToSVG, hasStraightDecorations } from './svg/text-decorations';
import { isTextOnPath, textOnPathToSVG } from './svg/text-on-path';

const identity: TMat2D = [1, 0, 0, 1, 0, 0];

export const mimeTypes: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  json: 'application/json',
};

function chooseBackground(background: ExportBackground, format: ExportFormat, current: unknown): unknown {
  if (background === 'transparent') return format === 'jpeg' ? 'white' : '';
  if (background !== 'keep') return background;
  const hasBackground = current !== undefined && current !== null && current !== '';
  return format === 'jpeg' && !hasBackground ? 'white' : current;
}

export function withExportView<Result>(
  canvas: StaticCanvas,
  background: ExportBackground,
  format: ExportFormat,
  work: () => Result,
): Result {
  const savedTransform = [...canvas.viewportTransform] as TMat2D;
  const savedBackground = canvas.backgroundColor;
  canvas.setViewportTransform(identity);
  canvas.backgroundColor = chooseBackground(background, format, savedBackground) as typeof savedBackground;
  try {
    return work();
  } finally {
    canvas.backgroundColor = savedBackground;
    canvas.setViewportTransform(savedTransform);
    canvas.requestRenderAll();
  }
}

export function renderRaster(
  canvas: StaticCanvas,
  area: ExportRect,
  format: 'png' | 'jpeg' | 'webp',
  scale: number,
  quality: number,
): Promise<Blob> {
  const rendered = canvas.toCanvasElement(scale, area);
  // Browsers keep a canvas's pixels until it is resized or collected, so
  // free the temporary one as soon as it is encoded.
  const release = (): void => {
    rendered.width = 0;
    rendered.height = 0;
  };
  return new Promise<Blob>((resolve, reject) => {
    rendered.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`The browser could not encode ${format}`))),
      mimeTypes[format],
      quality,
    );
  }).finally(release);
}

/**
 * Fabric 6 and 7 write `rotate="..."style="..."` with no space for the
 * spaces in text on a path, which is not valid XML: browsers, Illustrator and
 * Inkscape refuse to open the file. Put the missing space back.
 */
export function repairFabricSvg(svg: string): string {
  return svg.replace(/(rotate="[^"]*")(style=)/g, '$1 $2');
}

export interface RenderedSvg {
  svg: string;
  /** Objects drawn as pictures because SVG cannot show them from vectors. */
  rasterizedObjectIds: string[];
}

/**
 * Writes the SVG with the engine's corrections on top of Fabric's output:
 * curved text and decorations as the canvas draws them, inverted clip paths
 * as masks, and objects with nested clip paths as pictures. Every other
 * object is written by Fabric unchanged.
 */
export function renderSvg(
  canvas: StaticCanvas,
  area: ExportRect,
  scale: number,
  options?: Partial<Pick<NormalizedSvgOptions, 'textOnPath' | 'textDecorations'>>,
  limits?: ContentLimits,
): RenderedSvg {
  const textOnPath = (options?.textOnPath ?? 'vector') === 'vector';
  const decorations = (options?.textDecorations ?? 'shapes') === 'shapes';
  const rasterizedObjectIds: string[] = [];
  const pictures = new Map<FabricObject, string>();
  for (const object of canvas.getObjects()) {
    if (!hasNestedClipPath(object)) continue;
    pictures.set(object, rasterMarkup(canvas, object, Math.max(2, scale * 2), limits));
    const id = readObjectId(object);
    if (id !== undefined) rasterizedObjectIds.push(id);
  }
  const baseWriter = (object: FabricObject): ((reviver?: TSVGReviver) => string) | undefined => {
    if (textOnPath && isTextOnPath(object)) return (reviver) => textOnPathToSVG(object, reviver);
    if (decorations && hasStraightDecorations(object)) return (reviver) => decoratedTextToSVG(object, reviver);
    return undefined;
  };
  const writerFor = (object: FabricObject): ((reviver?: TSVGReviver) => string) | undefined => {
    const picture = pictures.get(object);
    if (picture !== undefined) return () => picture;
    const base = baseWriter(object);
    if (ownClipPathIsInverted(object)) {
      const prototypeWriter = (reviver?: TSVGReviver): string =>
        (Object.getPrototypeOf(object) as { toSVG: (reviver?: TSVGReviver) => string }).toSVG.call(object, reviver);
      return (reviver) => writeWithInvertedMask(object, base ?? prototypeWriter, reviver);
    }
    return base;
  };
  const svg = withSvgOverrides(canvas, writerFor, () =>
    canvas.toSVG({
      viewBox: { x: area.left, y: area.top, width: area.width, height: area.height },
      width: String(area.width * scale),
      height: String(area.height * scale),
    }),
  ).result;
  return { svg: repairFabricSvg(svg), rasterizedObjectIds };
}
