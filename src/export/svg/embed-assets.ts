import type { FabricObject, StaticCanvas } from 'fabric';
import type { AssetWarning } from '../../assets/asset-pipeline';
import { readObjectId } from '../../fabric/object-ids';
import { childrenOf } from '../../fabric/walk-objects';
import { isSafeImageUrl } from '../../security/content-limits';
import type { FontSource, NormalizedSvgOptions } from '../export-options';

/**
 * Makes an exported SVG self-contained (fabric.js #1980). Fabric writes
 * images as links to their URLs, so the file shows empty boxes anywhere the
 * URLs cannot be reached: in Illustrator, on another computer, or after a
 * signed URL expires. This puts each image, and the fonts you pass, into the
 * file as data.
 */

export interface EmbedResult {
  svg: string;
  warnings: AssetWarning[];
}

interface EmbedContext {
  canvas: StaticCanvas;
  options: NormalizedSvgOptions;
  signal: AbortSignal | undefined;
  isAllowedUrl: (url: string) => boolean;
}

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function shortUrl(url: string): string {
  return url.length > 80 ? `${url.slice(0, 77)}...` : url;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function blobToDataUrl(blob: Blob, type?: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${type ?? (blob.type || 'application/octet-stream')};base64,${bytesToBase64(bytes)}`;
}

/** Images on the canvas by URL, with the ids of the objects that show them. */
function imagesOnCanvas(canvas: StaticCanvas): Map<string, { element: HTMLImageElement | undefined; objectIds: Set<string> }> {
  const images = new Map<string, { element: HTMLImageElement | undefined; objectIds: Set<string> }>();
  const pending: Array<{ object: FabricObject; ownerId: string | undefined }> = canvas
    .getObjects()
    .map((object) => ({ object, ownerId: readObjectId(object) }));
  const note = (element: unknown, id: string | undefined): void => {
    if (typeof HTMLImageElement === 'undefined' || !(element instanceof HTMLImageElement)) return;
    for (const url of new Set([element.currentSrc, element.src, element.getAttribute('src') ?? ''])) {
      if (!url) continue;
      const entry = images.get(url) ?? { element, objectIds: new Set<string>() };
      if (id !== undefined) entry.objectIds.add(id);
      images.set(url, entry);
    }
  };
  while (pending.length > 0) {
    const { object, ownerId } = pending.pop()!;
    const id = readObjectId(object) ?? ownerId;
    const withElement = object as unknown as { getElement?: () => unknown };
    if (typeof withElement.getElement === 'function') note(withElement.getElement(), id);
    for (const paintValue of [object.fill, object.stroke]) note((paintValue as { source?: unknown } | null)?.source, id);
    childrenOf(object).forEach((child) => pending.push({ object: child, ownerId: id }));
    if (object.clipPath) pending.push({ object: object.clipPath as FabricObject, ownerId: id });
  }
  return images;
}

function drawToDataUrl(element: HTMLImageElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = element.naturalWidth;
  canvas.height = element.naturalHeight;
  try {
    canvas.getContext('2d')!.drawImage(element, 0, 0);
    // Throws a SecurityError when the image came from another site without CORS.
    return canvas.toDataURL('image/png');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function embedImage(
  url: string,
  element: HTMLImageElement | undefined,
  context: EmbedContext,
): Promise<{ dataUrl: string } | { reason: string }> {
  if (!context.isAllowedUrl(url)) return { reason: 'its address is not allowed' };
  let fetchError = '';
  try {
    const response = await fetch(url, { signal: context.signal, mode: 'cors', credentials: 'same-origin' });
    if (!response.ok) {
      fetchError = `the server answered HTTP ${response.status}`;
    } else {
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > context.options.maxEmbeddedImageBytes) {
        void response.body?.cancel().catch(() => undefined);
        return { reason: `it is larger than ${context.options.maxEmbeddedImageBytes} bytes` };
      }
      const blob = await response.blob();
      if (blob.size > context.options.maxEmbeddedImageBytes) {
        return { reason: `it is larger than ${context.options.maxEmbeddedImageBytes} bytes` };
      }
      return { dataUrl: await blobToDataUrl(blob, blob.type.startsWith('image/') ? blob.type : undefined) };
    }
  } catch (error) {
    if (context.signal?.aborted) throw error;
    fetchError = 'it could not be downloaded, usually because the other site does not allow it with CORS';
  }
  // The picture may still be readable from the loaded image when it was loaded with CORS.
  if (element && element.complete && element.naturalWidth > 0) {
    try {
      return { dataUrl: drawToDataUrl(element) };
    } catch {
      return { reason: `${fetchError}, and the loaded picture is from another site without CORS` };
    }
  }
  return { reason: fetchError };
}

async function embedImages(svg: string, context: EmbedContext, warnings: AssetWarning[], problems: string[]): Promise<string> {
  const attribute = /(\s(?:xlink:href|href))="([^"]*)"/g;
  const urls = new Set<string>();
  for (const match of svg.matchAll(attribute)) {
    const url = unescapeXml(match[2]!);
    if (url && !url.startsWith('data:') && !url.startsWith('#')) urls.add(url);
  }
  if (urls.size === 0) return svg;

  const images = imagesOnCanvas(context.canvas);
  const replacements = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (url) => {
      const known = images.get(url) ?? images.get(new URL(url, globalThis.location?.href).href);
      const outcome = await embedImage(url, known?.element, context);
      if ('dataUrl' in outcome) {
        replacements.set(url, outcome.dataUrl);
        return;
      }
      const message = `The image ${shortUrl(url)} was not embedded in the SVG because ${outcome.reason}`;
      problems.push(message);
      warnings.push({ code: 'IMAGE_NOT_EMBEDDED', message, url, objectIds: [...(known?.objectIds ?? [])] });
    }),
  );
  return svg.replace(attribute, (whole, name: string, value: string) => {
    const replacement = replacements.get(unescapeXml(value));
    return replacement ? `${name}="${escapeAttribute(replacement)}"` : whole;
  });
}

function fontMimeType(bytes: Uint8Array): string {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === 'wOF2') return 'font/woff2';
  if (tag === 'wOFF') return 'font/woff';
  if (tag === 'OTTO') return 'font/otf';
  return 'font/ttf';
}

async function fontBytes(source: FontSource, signal: AbortSignal | undefined): Promise<Uint8Array> {
  if (typeof source === 'string') {
    const response = await fetch(source, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(await source.arrayBuffer());
}

/** Font families the canvas uses, including per-character styles. */
function familiesInUse(canvas: StaticCanvas): Set<string> {
  const families = new Set<string>();
  const add = (family: unknown): void => {
    if (typeof family !== 'string') return;
    for (const part of family.split(',')) {
      const name = part.trim().replace(/^['"]|['"]$/g, '');
      if (name && !GENERIC_FAMILIES.has(name.toLowerCase())) families.add(name);
    }
  };
  const pending = [...canvas.getObjects()];
  while (pending.length > 0) {
    const object = pending.pop()!;
    const text = object as unknown as { fontFamily?: unknown; styles?: Record<string, Record<string, { fontFamily?: unknown }>> };
    add(text.fontFamily);
    for (const line of Object.values(text.styles ?? {})) for (const style of Object.values(line ?? {})) add(style?.fontFamily);
    pending.push(...childrenOf(object));
  }
  return families;
}

async function embedFonts(svg: string, context: EmbedContext, warnings: AssetWarning[], problems: string[]): Promise<string> {
  const sources = context.options.embedFonts;
  if (Object.keys(sources).length === 0) return svg;
  const rules: string[] = [];
  for (const family of familiesInUse(context.canvas)) {
    const source = sources[family];
    if (source === undefined) {
      const message = `The font "${family}" was not embedded in the SVG because embedFonts has no file for it`;
      warnings.push({ code: 'FONT_NOT_EMBEDDED', message, family, objectIds: [] });
      continue;
    }
    try {
      const bytes = await fontBytes(source, context.signal);
      const name = family.replace(/["\\<>]/g, '');
      rules.push(`@font-face { font-family: "${name}"; src: url("data:${fontMimeType(bytes)};base64,${bytesToBase64(bytes)}"); }`);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const message = `The font "${family}" was not embedded in the SVG because its file could not be read: ${reason}`;
      problems.push(message);
      warnings.push({ code: 'FONT_NOT_EMBEDDED', message, family, objectIds: [] });
    }
  }
  if (rules.length === 0) return svg;
  const style = `<defs>\n<style type="text/css"><![CDATA[\n${rules.join('\n')}\n]]></style>\n</defs>\n`;
  // Right after the opening <svg ...> tag, so the fonts are known before any text.
  return svg.replace(/(<svg\b[^>]*>\s*)/, `$1${style}`);
}

/**
 * Embeds images and fonts as the options ask. With `embedImages: 'require'`,
 * `problems` lists what could not be embedded so the caller can block the
 * export.
 */
export async function embedSvgAssets(
  svg: string,
  canvas: StaticCanvas,
  options: NormalizedSvgOptions,
  signal: AbortSignal | undefined,
  isAllowedUrl: (url: string) => boolean = isSafeImageUrl,
): Promise<EmbedResult & { problems: string[] }> {
  const warnings: AssetWarning[] = [];
  const problems: string[] = [];
  const context: EmbedContext = { canvas, options, signal, isAllowedUrl };
  let result = svg;
  if (options.embedImages) result = await embedImages(result, context, warnings, problems);
  result = await embedFonts(result, context, warnings, []);
  return { svg: result, warnings, problems };
}
