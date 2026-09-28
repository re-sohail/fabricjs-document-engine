import type { StaticCanvas, TMat2D } from 'fabric';
import type { ExportBackground, ExportFormat, ExportRect } from './export-options';

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
): string {
  return canvas.toDataURL({ ...area, format, quality, multiplier: scale, enableRetinaScaling: false });
}

export function renderSvg(canvas: StaticCanvas, area: ExportRect, scale: number): string {
  return canvas.toSVG({
    viewBox: { x: area.left, y: area.top, width: area.width, height: area.height },
    width: String(area.width * scale),
    height: String(area.height * scale),
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, payload = ''] = dataUrl.split(',');
  const mimeType = /data:([^;]+)/.exec(header ?? '')?.[1] ?? 'application/octet-stream';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}
