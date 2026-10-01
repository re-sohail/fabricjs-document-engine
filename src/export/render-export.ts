import type { StaticCanvas, TMat2D } from 'fabric';
import type { ExportBackground, ExportFormat, ExportRect, NormalizedSvgOptions } from './export-options';
import { withTextOnPathSVG } from './svg/text-on-path';

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

export function renderSvg(canvas: StaticCanvas, area: ExportRect, scale: number, options?: Pick<NormalizedSvgOptions, 'textOnPath'>): string {
  const write = (): string =>
    canvas.toSVG({
      viewBox: { x: area.left, y: area.top, width: area.width, height: area.height },
      width: String(area.width * scale),
      height: String(area.height * scale),
    });
  const svg = (options?.textOnPath ?? 'vector') === 'vector' ? withTextOnPathSVG(canvas, write).result : write();
  return repairFabricSvg(svg);
}
