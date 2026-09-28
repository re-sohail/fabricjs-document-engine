import { DocumentEngineError } from '../engine/errors';

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'svg' | 'json';

export interface ExportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type ExportArea = 'canvas' | 'content' | 'selection' | ExportRect;

export type ExportBackground = 'keep' | 'transparent' | (string & {});

export interface ExportOptions {
  format: ExportFormat;
  scale?: number;
  quality?: number;
  area?: ExportArea;
  padding?: number;
  background?: ExportBackground;
  signal?: AbortSignal;
}

export interface NormalizedExportOptions {
  format: ExportFormat;
  scale: number;
  quality: number;
  area: ExportArea;
  padding: number;
  background: ExportBackground;
  signal: AbortSignal | undefined;
}

const formats = new Set<ExportFormat>(['png', 'jpeg', 'webp', 'svg', 'json']);

function invalid(message: string): DocumentEngineError {
  return new DocumentEngineError('INVALID_EXPORT_OPTIONS', message);
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function isRasterFormat(format: ExportFormat): boolean {
  return format === 'png' || format === 'jpeg' || format === 'webp';
}

export function normalizeExportOptions(options: ExportOptions): NormalizedExportOptions {
  if (!formats.has(options.format)) throw invalid(`Unknown export format "${String(options.format)}", use png, jpeg, webp, svg or json`);
  const scale = options.scale ?? 1;
  if (!isPositive(scale)) throw invalid('scale must be a number greater than zero');
  const quality = options.quality ?? 0.92;
  if (!(quality >= 0 && quality <= 1)) throw invalid('quality must be between 0 and 1');
  const padding = options.padding ?? 0;
  if (!(Number.isFinite(padding) && padding >= 0)) throw invalid('padding must be zero or more');

  const area = options.area ?? 'canvas';
  if (typeof area === 'object') {
    if (![area.left, area.top].every(Number.isFinite) || !isPositive(area.width) || !isPositive(area.height)) {
      throw invalid('area needs finite left and top and a positive width and height');
    }
  } else if (!['canvas', 'content', 'selection'].includes(area)) {
    throw invalid(`Unknown export area "${String(area)}", use canvas, content, selection or a rectangle`);
  }

  return {
    format: options.format,
    scale,
    quality,
    area,
    padding,
    background: options.background ?? 'keep',
    signal: options.signal,
  };
}
