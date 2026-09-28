import { findImageReferences } from '../assets/asset-references';
import type { SerializedFabricObject } from '../document/document-format';
import { DocumentEngineError } from '../engine/errors';
import type { DocumentIssue } from '../engine/errors';

export interface ContentLimits {
  maxObjects?: number;
  maxDepth?: number;
  isAllowedUrl?: (url: string) => boolean;
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

function withoutDangerousKeys(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, nested: unknown) => (dangerousKeys.has(key) ? undefined : nested));
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

  const document = withoutDangerousKeys(input) as { objects?: unknown };
  const issues: DocumentIssue[] = [];

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
