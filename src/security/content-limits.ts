import { findImageReferences } from '../assets/asset-references';
import type { SerializedFabricObject } from '../document/document-format';
import { DocumentEngineError } from '../engine/errors';
import type { DocumentIssue } from '../engine/errors';

export interface ContentLimits {
  maxObjects?: number;
  maxDepth?: number;
  isAllowedUrl?: (url: string) => boolean;
  /** Longest side of the page or of an export, in pixels. Default 16,384. */
  maxCanvasSide?: number;
  /** Largest page or export area, in pixels. Default 67,108,864 (8,192 × 8,192, what iOS 18 Safari can draw). */
  maxCanvasPixels?: number;
  /** Largest decoded image, in pixels. Default 67,108,864. */
  maxImagePixels?: number;
  /** Longest document, in characters of JSON. Default 100,000,000. */
  maxDocumentLength?: number;
}

export const DEFAULT_MAX_CANVAS_SIDE = 16_384;
export const DEFAULT_MAX_CANVAS_PIXELS = 67_108_864;
export const DEFAULT_MAX_IMAGE_PIXELS = 67_108_864;
export const DEFAULT_MAX_DOCUMENT_LENGTH = 100_000_000;

/**
 * Why a drawing surface of this size is refused, or undefined when it fits.
 * Pure arithmetic, run before any canvas is created: a canvas over the
 * browser's limit fails silently or crashes the tab.
 */
export function canvasSizeProblem(width: number, height: number, limits: ContentLimits = {}): string | undefined {
  const maxSide = limits.maxCanvasSide ?? DEFAULT_MAX_CANVAS_SIDE;
  const maxPixels = limits.maxCanvasPixels ?? DEFAULT_MAX_CANVAS_PIXELS;
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  if (w > maxSide || h > maxSide) return `${w} × ${h} pixels is larger than the ${maxSide}-pixel limit per side`;
  if (w * h > maxPixels) return `${w} × ${h} pixels is ${w * h} pixels, more than the limit of ${maxPixels}`;
  return undefined;
}

const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeImageUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(trimmed)?.[1];
  if (scheme === undefined) return true;
  if (scheme === 'http' || scheme === 'https' || scheme === 'blob') return true;
  if (scheme === 'data') return trimmed.startsWith('data:image/');
  return false;
}

function withoutDangerousKeys(json: string): unknown {
  return JSON.parse(json, (key, nested: unknown) => (dangerousKeys.has(key) ? undefined : nested));
}

function pageSize(document: Record<string, unknown>): { width: unknown; height: unknown } {
  const canvas = document.canvas as Record<string, unknown> | undefined;
  return typeof canvas === 'object' && canvas !== null
    ? { width: canvas.width, height: canvas.height }
    : { width: document.width, height: document.height };
}

function deepestNesting(value: unknown): number {
  let deepest = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (pending.length > 0) {
    const { value: current, depth } = pending.pop()!;
    if (typeof current !== 'object' || current === null) continue;
    deepest = Math.max(deepest, depth);
    for (const child of Object.values(current)) pending.push({ value: child, depth: depth + 1 });
  }
  return deepest;
}

function countObjects(objects: readonly SerializedFabricObject[]): number {
  let count = 0;
  const pending = [...objects];
  while (pending.length > 0) {
    const object = pending.pop()!;
    count += 1;
    if (Array.isArray(object.objects)) pending.push(...object.objects);
    if (object.clipPath && typeof object.clipPath === 'object') pending.push(object.clipPath);
  }
  return count;
}

function unsafe(path: string, message: string): DocumentIssue {
  return { code: 'UNSAFE_DOCUMENT', path, message };
}

export function secureDocument(input: unknown, limits: ContentLimits = {}): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const maxDepth = limits.maxDepth ?? 100;
  const maxObjects = limits.maxObjects ?? 50_000;

  // The JSON text is needed to strip dangerous keys anyway, so its length
  // costs nothing extra.
  const json = JSON.stringify(input);
  const maxLength = limits.maxDocumentLength ?? DEFAULT_MAX_DOCUMENT_LENGTH;
  if (json.length > maxLength) {
    refuseWhenUnsafe([unsafe('', `the document is ${json.length} characters of JSON, the limit is ${maxLength}`)]);
  }
  const document = withoutDangerousKeys(json) as { objects?: unknown } & Record<string, unknown>;
  const issues: DocumentIssue[] = [];

  const { width, height } = pageSize(document);
  if (typeof width === 'number' && typeof height === 'number') {
    const problem = canvasSizeProblem(width, height, limits);
    if (problem) issues.push(unsafe('canvas', `the page is ${problem}`));
  }

  const depth = deepestNesting(document);
  if (depth > maxDepth) issues.push(unsafe('', `the document is nested ${depth} levels deep, the limit is ${maxDepth}`));

  if (Array.isArray(document.objects) && issues.length === 0) {
    const objects = document.objects.filter(
      (object): object is SerializedFabricObject => typeof object === 'object' && object !== null,
    );
    const count = countObjects(objects);
    if (count > maxObjects) issues.push(unsafe('objects', `the document has ${count} objects, the limit is ${maxObjects}`));
  }

  refuseWhenUnsafe(issues);
  return document;
}

function refuseWhenUnsafe(issues: DocumentIssue[]): void {
  if (issues.length === 0) return;
  throw new DocumentEngineError('UNSAFE_DOCUMENT', `The document was refused: ${issues.map((issue) => issue.message).join('; ')}`, {
    issues,
  });
}

export function refuseUnsafeImageUrls(
  objects: readonly SerializedFabricObject[],
  isAllowedUrl: (url: string) => boolean = isSafeImageUrl,
): void {
  const issues: DocumentIssue[] = [];
  for (const reference of findImageReferences(objects)) {
    if (isAllowedUrl(reference.url)) continue;
    const where = reference.objectId ? `object ${reference.objectId}` : 'an object';
    issues.push(unsafe('objects', `${where} uses the image address "${reference.url.slice(0, 60)}", which is not allowed`));
  }
  refuseWhenUnsafe(issues);
}
