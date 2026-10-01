import type { FabricObject, StaticCanvas, TSVGReviver } from 'fabric';
import type { AssetOptions } from '../assets/asset-pipeline';
import type { FabricDocument } from '../document/document-format';
import type { DocumentEngine } from '../engine/create-document-engine';
import { DocumentEngineError, isDocumentEngineError } from '../engine/errors';
import type { CustomObjectDefinition } from '../fabric/object-registry';
import { readObjectId } from '../fabric/object-ids';
import { walkObjects } from '../fabric/walk-objects';
import { disposeObjects } from '../export/batch-render';
import type { ExportBackground } from '../export/export-options';
import { repairFabricSvg, withExportView } from '../export/render-export';
import { embedSvgAssets } from '../export/svg/embed-assets';
import { withSvgOverrides } from '../export/svg/overrides';
import { isTextOnPath, textOnPathToSVG } from '../export/svg/text-on-path';
import type { ContentLimits } from '../security/content-limits';
import { jsPdfStyle, loadFonts, registerFonts, standardFamily } from './fonts';
import type { PdfFont, RegisteredFonts } from './fonts';
import { layoutPage } from './page-layout';
import type { PageLayout, PageLayoutOptions } from './page-layout';
import { decoratedTextToSVG, hasStraightDecorations } from './text-decorations';

/**
 * Exports canvases and documents as PDF (fabric.js #5906), with jsPDF and
 * svg2pdf.js as optional peer dependencies.
 *
 * - `vector` draws every object as PDF vectors and text, so text can be
 *   selected and the file prints sharply at any size.
 * - `raster` draws each page as one picture at `dpi`.
 * - `hybrid` (the default) draws everything as vectors except what svg2pdf
 *   cannot draw faithfully (shadows, blend modes, gradient outlines,
 *   non-scaling outlines on scaled objects, and text in a font with no file),
 *   which becomes a picture of just that object, in its place.
 */

export type PdfMode = 'vector' | 'raster' | 'hybrid';

/** An engine, a Fabric canvas, or a saved document or plain Fabric JSON. */
export type PdfSource = DocumentEngine | StaticCanvas | FabricDocument | Record<string, unknown>;

export interface PdfExportOptions extends PageLayoutOptions {
  mode?: PdfMode;
  /** Resolution of everything drawn as a picture. Default 300. */
  dpi?: number;
  /** TrueType files for the fonts the canvas uses. */
  fonts?: PdfFont[];
  /**
   * Text in a font with no file in `fonts`. `rasterize` (the default in
   * hybrid mode) draws it as a picture so it looks right; `substitute` keeps
   * it as text in the closest built-in PDF font.
   */
  missingFonts?: 'rasterize' | 'substitute';
  background?: ExportBackground;
  metadata?: { title?: string; author?: string; subject?: string; keywords?: string; creator?: string };
  signal?: AbortSignal;
  /** For documents: custom object classes, asset options and limits, as for the engine. */
  customObjects?: CustomObjectDefinition[];
  assets?: AssetOptions;
  limits?: ContentLimits;
}

export type PdfWarningCode = 'PDF_RASTERIZED' | 'PDF_UNSUPPORTED' | 'PDF_FONT_SUBSTITUTED' | 'IMAGE_NOT_EMBEDDED';

export interface PdfWarning {
  code: PdfWarningCode;
  message: string;
  /** The page, counted from 1. */
  page: number;
  objectIds: string[];
  family?: string;
  url?: string;
}

export interface PdfExportResult {
  blob: Blob;
  pageCount: number;
  warnings: PdfWarning[];
}

interface JsPdfDocument {
  addPage(format: [number, number], orientation: 'portrait' | 'landscape'): unknown;
  addFileToVFS(name: string, data: string): unknown;
  addFont(file: string, family: string, style: string): unknown;
  addImage(image: HTMLCanvasElement, format: string, x: number, y: number, width: number, height: number, alias?: string, compression?: string): unknown;
  svg(element: Element, options: { x: number; y: number; width: number; height: number }): Promise<unknown>;
  saveGraphicsState(): unknown;
  restoreGraphicsState(): unknown;
  rect(x: number, y: number, width: number, height: number, style: null): unknown;
  clip(): unknown;
  discardPath(): unknown;
  setProperties(properties: Record<string, string>): unknown;
  output(type: 'blob'): Blob;
}

type JsPdfConstructor = new (options: Record<string, unknown>) => JsPdfDocument;

const RASTER_REASONS = {
  shadow: 'it has a shadow, which PDF vectors cannot draw',
  blend: 'it uses a blend mode, which PDF vectors cannot draw',
  gradientStroke: 'its outline is a gradient or pattern',
  uniformStroke: 'it keeps its outline width while scaled (strokeUniform)',
  font: 'its font has no TrueType file in fonts',
  characters: 'it uses characters the built-in PDF fonts do not have; add a TrueType font that has them',
} as const;

type RasterReason = keyof typeof RASTER_REASONS;

function stop(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DocumentEngineError('EXPORT_ABORTED', 'The PDF export was cancelled');
}

async function loadPeers(needsSvg: boolean): Promise<JsPdfConstructor> {
  let jsPDF: JsPdfConstructor;
  try {
    jsPDF = (await import('jspdf')).jsPDF as unknown as JsPdfConstructor;
  } catch (error) {
    throw new DocumentEngineError('PDF_UNAVAILABLE', 'PDF export needs the jspdf package. Install it with: npm install jspdf svg2pdf.js', {
      cause: error,
    });
  }
  if (needsSvg) {
    try {
      // Adds `svg()` to jsPDF documents.
      await import('svg2pdf.js');
    } catch (error) {
      throw new DocumentEngineError(
        'PDF_UNAVAILABLE',
        'Vector and hybrid PDF export need the svg2pdf.js package. Install it with: npm install svg2pdf.js, or use mode: "raster".',
        { cause: error },
      );
    }
  }
  return jsPDF;
}

function isEngine(source: PdfSource): source is DocumentEngine {
  return typeof (source as Partial<DocumentEngine>).toDocument === 'function' && 'canvas' in source;
}

function isCanvas(source: PdfSource): source is StaticCanvas {
  const candidate = source as Partial<StaticCanvas>;
  return typeof candidate.getObjects === 'function' && typeof candidate.toCanvasElement === 'function';
}

function idsOf(object: FabricObject): string[] {
  const ids: string[] = [];
  walkObjects([object], (child) => {
    const id = readObjectId(child);
    if (id !== undefined) ids.push(id);
  });
  return ids.slice(0, 1);
}

function familiesOf(object: FabricObject): string[] {
  const text = object as unknown as { fontFamily?: unknown; styles?: Record<string, Record<string, { fontFamily?: unknown }>> };
  const families = new Set<string>();
  if (typeof text.fontFamily === 'string') families.add(text.fontFamily);
  for (const line of Object.values(text.styles ?? {})) {
    for (const style of Object.values(line ?? {})) if (typeof style?.fontFamily === 'string') families.add(style.fontFamily);
  }
  return [...families];
}

function resolvesTo(family: string, registered: RegisteredFonts): { registered: boolean; standard: boolean } {
  const names = family.split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, ''));
  if (names.some((name) => registered.families.has(name.toLowerCase()))) return { registered: true, standard: false };
  return { registered: false, standard: names.some((name) => standardFamily(name) !== undefined) };
}

/** Why an object cannot be drawn as PDF vectors, or undefined when it can. */
function rasterReason(object: FabricObject, registered: RegisteredFonts, missingFonts: 'rasterize' | 'substitute'): RasterReason | undefined {
  let reason: RasterReason | undefined;
  walkObjects([object], (child) => {
    if (reason) return;
    if (child.shadow) reason = 'shadow';
    else if (child.globalCompositeOperation && child.globalCompositeOperation !== 'source-over') reason = 'blend';
    else if (typeof child.stroke === 'object' && child.stroke !== null && child.strokeWidth > 0) reason = 'gradientStroke';
    else if (child.strokeUniform && child.stroke && child.strokeWidth > 0) {
      const { x: scaleX, y: scaleY } = child.getObjectScaling();
      if (Math.abs(scaleX - 1) > 1e-6 || Math.abs(scaleY - 1) > 1e-6) reason = 'uniformStroke';
    }
    const text = (child as unknown as { text?: unknown }).text;
    if (!reason && typeof text === 'string') {
      const families = familiesOf(child).map((family) => resolvesTo(family, registered));
      const allRegistered = families.every((family) => family.registered);
      if (!allRegistered && /[^\u0000-ÿ]/.test(text)) reason = 'characters';
      else if (!allRegistered && missingFonts === 'rasterize' && families.some((family) => !family.registered && !family.standard)) reason = 'font';
    }
  });
  return reason;
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
function rasterMarkup(canvas: StaticCanvas, object: FabricObject, multiplier: number): string {
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
    element = canvas.toCanvasElement(multiplier, { left, top, width: right - left, height: bottom - top, filter });
  } finally {
    Object.assign(canvas, saved);
  }
  const url = element.toDataURL('image/png');
  element.width = 0;
  element.height = 0;
  return `<image x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" preserveAspectRatio="none" xlink:href="${url}" />\n`;
}

function quoteFamily(name: string): string {
  return /^[a-z-]+$/i.test(name) ? name : `"${name.replace(/"/g, '')}"`;
}

function resolveFamily(list: string, registered: RegisteredFonts): string {
  const names = list.split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, ''));
  for (const name of names) {
    const own = registered.families.get(name.toLowerCase());
    if (own) return quoteFamily(own);
  }
  for (const name of names) {
    const standard = standardFamily(name);
    if (standard) return standard;
  }
  return 'helvetica';
}

function weightOf(value: string): string {
  const number = Number(value);
  return value === 'bold' || value === 'bolder' || (Number.isFinite(number) && number >= 600) ? 'bold' : 'normal';
}

/**
 * Points every font at a font jsPDF has, and rounds weights to normal or
 * bold. svg2pdf matches family names exactly and otherwise falls back to
 * Times, and it looks for weights such as 500 as styles no font has.
 */
function normalizeFonts(root: Element, registered: RegisteredFonts): void {
  for (const element of [root, ...Array.from(root.getElementsByTagName('*'))]) {
    const family = element.getAttribute('font-family');
    if (family) element.setAttribute('font-family', resolveFamily(family, registered));
    const weight = element.getAttribute('font-weight');
    if (weight) element.setAttribute('font-weight', weightOf(weight));
    const style = element.getAttribute('style');
    if (style && /font-(family|weight)/.test(style)) {
      element.setAttribute(
        'style',
        style
          .replace(/font-family:\s*([^;]+)/g, (_, value: string) => `font-family: ${resolveFamily(value, registered)}`)
          .replace(/font-weight:\s*([^;]+)/g, (_, value: string) => `font-weight: ${weightOf(value.trim())}`),
      );
    }
  }
}

/** Warns once for each family and style the canvas uses that has no file of its own. */
function warnSubstitutedStyles(canvas: StaticCanvas, registered: RegisteredFonts, page: number, warnings: PdfWarning[], warned: Set<string>): void {
  if (registered.substituted.length === 0) return;
  const missing = new Set(registered.substituted.map(({ family, style }) => `${family.toLowerCase()}|${style}`));
  walkObjects(canvas.getObjects(), (object) => {
    const text = object as unknown as {
      text?: unknown;
      fontFamily?: string;
      fontWeight?: unknown;
      fontStyle?: unknown;
      styles?: Record<string, Record<string, { fontFamily?: string; fontWeight?: unknown; fontStyle?: unknown }>>;
    };
    if (typeof text.text !== 'string') return;
    const uses = [{ family: text.fontFamily, weight: text.fontWeight, style: text.fontStyle }];
    for (const line of Object.values(text.styles ?? {})) {
      for (const style of Object.values(line ?? {})) {
        uses.push({ family: style?.fontFamily ?? text.fontFamily, weight: style?.fontWeight ?? text.fontWeight, style: style?.fontStyle ?? text.fontStyle });
      }
    }
    for (const use of uses) {
      const family = registered.families.get(String(use.family ?? '').toLowerCase());
      if (!family) continue;
      const style = jsPdfStyle(use.weight, use.style);
      const key = `${family.toLowerCase()}|${style}`;
      if (!missing.has(key) || warned.has(key)) continue;
      warned.add(key);
      warnings.push({
        code: 'PDF_FONT_SUBSTITUTED',
        message: `No ${style} file was given for "${family}", so its ${style} text uses another file of the same family`,
        page,
        objectIds: idsOf(object),
        family,
      });
    }
  });
}

interface PageContext {
  document: JsPdfDocument;
  layout: PageLayout;
  options: PdfExportOptions;
  registered: RegisteredFonts;
  page: number;
  warnings: PdfWarning[];
}

function clipTo(context: PageContext, draw: () => Promise<void> | void): Promise<void> | void {
  const clip = context.layout.clip;
  if (!clip) return draw();
  const { document } = context;
  document.saveGraphicsState();
  document.rect(clip.x, clip.y, clip.width, clip.height, null);
  document.clip();
  document.discardPath();
  const finish = (): void => {
    document.restoreGraphicsState();
  };
  const drawn = draw();
  if (drawn instanceof Promise) return drawn.finally(finish);
  finish();
  return undefined;
}

async function drawRasterPage(canvas: StaticCanvas, context: PageContext): Promise<void> {
  const { layout, options } = context;
  const multiplier = (layout.scale * (options.dpi ?? 300)) / 72;
  const element = withExportView(canvas, options.background ?? 'keep', 'png', () => canvas.toCanvasElement(multiplier));
  try {
    await clipTo(context, () => {
      context.document.addImage(element, 'PNG', layout.x, layout.y, layout.width, layout.height, undefined, 'FAST');
    });
  } finally {
    element.width = 0;
    element.height = 0;
  }
}

async function drawVectorPage(canvas: StaticCanvas, context: PageContext): Promise<void> {
  const { layout, options, page, warnings, registered } = context;
  const mode = options.mode ?? 'hybrid';
  const missingFonts = options.missingFonts ?? (mode === 'hybrid' ? 'rasterize' : 'substitute');
  const multiplier = (layout.scale * (options.dpi ?? 300)) / 72;
  const width = canvas.getWidth();
  const height = canvas.getHeight();

  const svg = withExportView(canvas, options.background ?? 'keep', 'svg', () => {
    const rasters = new Map<FabricObject, string>();
    for (const object of canvas.getObjects()) {
      const reason = rasterReason(object, registered, missingFonts);
      if (!reason) continue;
      if (mode === 'hybrid') {
        rasters.set(object, rasterMarkup(canvas, object, multiplier));
        warnings.push({
          code: 'PDF_RASTERIZED',
          message: `An object was drawn as a picture at ${options.dpi ?? 300} dpi because ${RASTER_REASONS[reason]}`,
          page,
          objectIds: idsOf(object),
        });
      } else {
        warnings.push({
          code: reason === 'font' || reason === 'characters' ? 'PDF_FONT_SUBSTITUTED' : 'PDF_UNSUPPORTED',
          message: `An object may look different in the PDF because ${RASTER_REASONS[reason]}`,
          page,
          objectIds: idsOf(object),
        });
      }
    }
    const writerFor = (object: FabricObject): ((reviver?: TSVGReviver) => string) | undefined => {
      const raster = rasters.get(object);
      if (raster !== undefined) return () => raster;
      if (isTextOnPath(object)) return (reviver) => textOnPathToSVG(object, reviver);
      if (hasStraightDecorations(object)) return (reviver) => decoratedTextToSVG(object, reviver);
      return undefined;
    };
    return withSvgOverrides(canvas, writerFor, () =>
      canvas.toSVG({ viewBox: { x: 0, y: 0, width, height }, width: String(width), height: String(height) }),
    ).result;
  });

  const embedded = await embedSvgAssets(
    repairFabricSvg(svg),
    canvas,
    { textOnPath: 'vector', embedImages: true, maxEmbeddedImageBytes: Number.MAX_SAFE_INTEGER, embedFonts: {} },
    options.signal,
  );
  stop(options.signal);
  for (const warning of embedded.warnings) {
    if (warning.code === 'IMAGE_NOT_EMBEDDED') {
      warnings.push({ code: 'IMAGE_NOT_EMBEDDED', message: warning.message, page, objectIds: warning.objectIds, url: warning.url });
    }
  }
  const root = new DOMParser().parseFromString(embedded.svg, 'image/svg+xml').documentElement;
  normalizeFonts(root, registered);
  await clipTo(context, async () => {
    await context.document.svg(root, { x: layout.x, y: layout.y, width: layout.width, height: layout.height });
  });
}

/**
 * Exports one or more pages as a PDF. Each source becomes one page: an
 * engine's canvas, a Fabric canvas, or a saved document, which is drawn on
 * an off-screen canvas that is freed after its page.
 */
export async function exportPdf(sources: PdfSource | readonly PdfSource[], options: PdfExportOptions = {}): Promise<PdfExportResult> {
  const list = Array.isArray(sources) ? [...(sources as readonly PdfSource[])] : [sources as PdfSource];
  if (list.length === 0) throw new DocumentEngineError('INVALID_EXPORT_OPTIONS', 'exportPdf needs at least one page');
  const dpi = options.dpi ?? 300;
  if (!(Number.isFinite(dpi) && dpi > 0 && dpi <= 1200)) throw new DocumentEngineError('INVALID_EXPORT_OPTIONS', 'dpi must be between 1 and 1200');
  const mode = options.mode ?? 'hybrid';
  if (!['vector', 'raster', 'hybrid'].includes(mode)) throw new DocumentEngineError('INVALID_EXPORT_OPTIONS', 'mode must be "vector", "raster" or "hybrid"');
  if (typeof document === 'undefined') throw new DocumentEngineError('PDF_UNAVAILABLE', 'PDF export needs a browser DOM');
  stop(options.signal);

  const jsPDF = await loadPeers(mode !== 'raster');
  const fonts = await loadFonts(options.fonts ?? [], options.signal);
  stop(options.signal);

  let pdf: JsPdfDocument | undefined;
  let registered: RegisteredFonts = { families: new Map(), substituted: [] };
  const warnings: PdfWarning[] = [];
  const warnedStyles = new Set<string>();
  let renderer: { canvas: StaticCanvas; engine: DocumentEngine; release: () => Promise<void> } | undefined;

  try {
    for (let index = 0; index < list.length; index += 1) {
      stop(options.signal);
      const source = list[index]!;
      let canvas: StaticCanvas;
      if (isEngine(source)) canvas = source.canvas;
      else if (isCanvas(source)) canvas = source;
      else {
        renderer ??= await createRenderer(options);
        await renderer.engine.loadDocument(source, { signal: options.signal, discardUnsavedChanges: true });
        canvas = renderer.canvas;
      }
      const layout = layoutPage({ width: canvas.getWidth(), height: canvas.getHeight() }, options);
      const format: [number, number] = [layout.pageWidth, layout.pageHeight];
      if (!pdf) {
        pdf = new jsPDF({ unit: 'pt', format, orientation: layout.orientation, compress: true, putOnlyUsedFonts: true });
        registered = registerFonts(pdf, fonts);
      } else {
        pdf.addPage(format, layout.orientation);
      }
      warnSubstitutedStyles(canvas, registered, index + 1, warnings, warnedStyles);
      const context: PageContext = { document: pdf, layout, options, registered, page: index + 1, warnings };
      if (mode === 'raster') await drawRasterPage(canvas, context);
      else await drawVectorPage(canvas, context);
      if (renderer && canvas === renderer.canvas) disposeObjects(renderer.canvas);
    }
    stop(options.signal);
    const { metadata } = options;
    pdf!.setProperties({ creator: metadata?.creator ?? 'fabricjs-document-engine', ...metadata });
    return { blob: pdf!.output('blob'), pageCount: list.length, warnings };
  } catch (error) {
    if (isDocumentEngineError(error)) throw error;
    if (options.signal?.aborted) throw new DocumentEngineError('EXPORT_ABORTED', 'The PDF export was cancelled', { cause: error });
    const reason = error instanceof Error ? error.message : String(error);
    throw new DocumentEngineError('PDF_FAILED', `The PDF could not be made: ${reason}`, { cause: error });
  } finally {
    await renderer?.release();
  }
}

async function createRenderer(options: PdfExportOptions): Promise<{ canvas: StaticCanvas; engine: DocumentEngine; release: () => Promise<void> }> {
  const [{ StaticCanvas }, { createDocumentEngine }] = await Promise.all([import('fabric'), import('../engine/create-document-engine')]);
  const element = document.createElement('canvas');
  const canvas = new StaticCanvas(element, { renderOnAddRemove: false, enableRetinaScaling: false });
  const engine = createDocumentEngine({
    canvas,
    customObjects: options.customObjects,
    assets: options.assets,
    limits: options.limits,
    history: { limit: 1 },
  });
  return {
    canvas,
    engine,
    release: async () => {
      disposeObjects(canvas);
      engine.destroy();
      await canvas.dispose();
      element.width = 0;
      element.height = 0;
    },
  };
}
