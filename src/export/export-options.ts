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

/** A font file for `embedFonts`: a URL to fetch, or the file's bytes. */
export type FontSource = string | ArrayBuffer | Uint8Array | Blob;

export interface SvgExportOptions {
  /**
   * How text that follows a path is written. `vector` (the default) writes
   * each character where Fabric draws it on the canvas. `fabric` keeps
   * Fabric's own output, which ignores `pathAlign` and draws text
   * backgrounds and underlines straight.
   */
  textOnPath?: 'vector' | 'fabric';
  /**
   * How underlines, overlines and line-throughs of ordinary text are written.
   * `shapes` (the default) draws them where the canvas does; `css` keeps
   * Fabric's `text-decoration`, which readers place in their own way.
   */
  textDecorations?: 'shapes' | 'css';
  /**
   * Puts every image into the file as data, so the SVG opens anywhere
   * without the original image URLs. `require` blocks the export when an
   * image cannot be embedded; `true` exports anyway with a warning.
   */
  embedImages?: boolean | 'require';
  /** The largest image, in bytes, to embed. Default 25 MB. */
  maxEmbeddedImageBytes?: number;
  /** Font files to put into the file, by font family, for the families the canvas uses. */
  embedFonts?: Record<string, FontSource>;
}

export interface ExportOptions {
  format: ExportFormat;
  scale?: number;
  quality?: number;
  area?: ExportArea;
  padding?: number;
  background?: ExportBackground;
  signal?: AbortSignal;
  /** Options for SVG exports. */
  svg?: SvgExportOptions;
}

export interface NormalizedSvgOptions {
  textOnPath: 'vector' | 'fabric';
  textDecorations: 'shapes' | 'css';
  embedImages: boolean | 'require';
  maxEmbeddedImageBytes: number;
  embedFonts: Record<string, FontSource>;
}

export interface NormalizedExportOptions {
  format: ExportFormat;
  scale: number;
  quality: number;
  area: ExportArea;
  padding: number;
  background: ExportBackground;
  signal: AbortSignal | undefined;
  svg: NormalizedSvgOptions;
}

export const DEFAULT_MAX_EMBEDDED_IMAGE_BYTES: number = 25 * 1024 * 1024;

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

  const svg = options.svg ?? {};
  const textOnPath = svg.textOnPath ?? 'vector';
  if (textOnPath !== 'vector' && textOnPath !== 'fabric') throw invalid('svg.textOnPath must be "vector" or "fabric"');
  const textDecorations = svg.textDecorations ?? 'shapes';
  if (textDecorations !== 'shapes' && textDecorations !== 'css') throw invalid('svg.textDecorations must be "shapes" or "css"');
  const embedImages = svg.embedImages ?? false;
  if (embedImages !== true && embedImages !== false && embedImages !== 'require') {
    throw invalid('svg.embedImages must be true, false or "require"');
  }
  const maxEmbeddedImageBytes = svg.maxEmbeddedImageBytes ?? DEFAULT_MAX_EMBEDDED_IMAGE_BYTES;
  if (!isPositive(maxEmbeddedImageBytes)) throw invalid('svg.maxEmbeddedImageBytes must be greater than zero');
  const embedFonts = svg.embedFonts ?? {};
  if (typeof embedFonts !== 'object' || Array.isArray(embedFonts)) throw invalid('svg.embedFonts must map font families to font files');

  return {
    format: options.format,
    scale,
    quality,
    area,
    padding,
    background: options.background ?? 'keep',
    signal: options.signal,
    svg: { textOnPath, textDecorations, embedImages, maxEmbeddedImageBytes, embedFonts },
  };
}
