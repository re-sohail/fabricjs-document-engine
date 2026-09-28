import { CURRENT_SCHEMA_VERSION } from './document-format';
import type { DocumentIssue } from '../engine/errors';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function invalid(path: string, message: string): DocumentIssue {
  return { code: 'INVALID_DOCUMENT', path, message };
}

function validateObjectList(list: unknown, path: string, issues: DocumentIssue[]): void {
  if (!Array.isArray(list)) {
    issues.push(invalid(path, 'must be an array of objects'));
    return;
  }
  const pending: Array<{ value: unknown; path: string }> = list.map((value, index) => ({
    value,
    path: `${path}[${index}]`,
  }));
  while (pending.length > 0) {
    const { value, path: objectPath } = pending.pop()!;
    if (!isPlainObject(value)) {
      issues.push(invalid(objectPath, 'must be an object'));
      continue;
    }
    if (typeof value.type !== 'string' || value.type.length === 0) {
      issues.push(invalid(`${objectPath}.type`, 'must be a non-empty string'));
    }
    if (value.id !== undefined && typeof value.id !== 'string') {
      issues.push(invalid(`${objectPath}.id`, 'must be a string when present'));
    }
    if (value.objects !== undefined) {
      if (!Array.isArray(value.objects)) {
        issues.push(invalid(`${objectPath}.objects`, 'must be an array of objects'));
      } else {
        value.objects.forEach((child, index) => {
          pending.push({ value: child, path: `${objectPath}.objects[${index}]` });
        });
      }
    }
    if (value.clipPath !== undefined) {
      pending.push({ value: value.clipPath, path: `${objectPath}.clipPath` });
    }
  }
}

export function validateDocument(value: unknown): DocumentIssue[] {
  if (!isPlainObject(value)) return [invalid('', 'document must be an object')];

  if (typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion)) {
    return [invalid('schemaVersion', 'must be an integer')];
  }
  if (value.schemaVersion > CURRENT_SCHEMA_VERSION || value.schemaVersion < 1) {
    return [
      {
        code: 'UNSUPPORTED_SCHEMA',
        path: 'schemaVersion',
        message: `schema version ${value.schemaVersion} is not supported, expected ${CURRENT_SCHEMA_VERSION}`,
      },
    ];
  }

  const issues: DocumentIssue[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) {
    issues.push(invalid('id', 'must be a non-empty string'));
  }
  if (typeof value.createdAt !== 'string') issues.push(invalid('createdAt', 'must be an ISO date string'));
  if (typeof value.updatedAt !== 'string') issues.push(invalid('updatedAt', 'must be an ISO date string'));
  if (value.revision !== undefined && !(Number.isInteger(value.revision) && (value.revision as number) >= 0)) {
    issues.push(invalid('revision', 'must be a whole number of zero or more when present'));
  }
  if (value.assets !== undefined) {
    const assets = value.assets;
    if (!isPlainObject(assets) || !Array.isArray(assets.images) || !Array.isArray(assets.fonts)) {
      issues.push(invalid('assets', 'must be an object with images and fonts arrays when present'));
    }
  }
  if (!isPlainObject(value.metadata)) issues.push(invalid('metadata', 'must be an object'));

  if (!isPlainObject(value.canvas)) {
    issues.push(invalid('canvas', 'must be an object'));
  } else {
    if (!isPositiveNumber(value.canvas.width)) issues.push(invalid('canvas.width', 'must be a positive number'));
    if (!isPositiveNumber(value.canvas.height)) issues.push(invalid('canvas.height', 'must be a positive number'));
  }

  validateObjectList(value.objects, 'objects', issues);
  return issues;
}
