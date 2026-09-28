import type { SerializedFabricObject } from '../document/document-format';

export interface ImageReference {
  url: string;
  objectId: string | undefined;
  crossOrigin: string | null | undefined;
  holder: Record<string, unknown>;
  key: string;
}

export interface FontReference {
  family: string;
  weight: string;
  style: string;
  objectId: string | undefined;
}

interface PendingObject {
  object: SerializedFabricObject;
  ownerId: string | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function visitObjects(objects: readonly SerializedFabricObject[], visit: (object: SerializedFabricObject, ownerId: string | undefined) => void): void {
  const pending: PendingObject[] = objects.map((object) => ({ object, ownerId: object.id })).reverse();
  while (pending.length > 0) {
    const { object, ownerId } = pending.pop()!;
    const id = object.id ?? ownerId;
    visit(object, id);
    const children: PendingObject[] = (object.objects ?? []).map((child) => ({ object: child, ownerId: child.id ?? id }));
    if (object.clipPath) children.push({ object: object.clipPath, ownerId: id });
    pending.push(...children.reverse());
  }
}

export function findImageReferences(objects: readonly SerializedFabricObject[]): ImageReference[] {
  const references: ImageReference[] = [];
  visitObjects(objects, (object, objectId) => {
    if (typeof object.src === 'string' && object.src.length > 0) {
      references.push({
        url: object.src,
        objectId,
        crossOrigin: object.crossOrigin as string | null | undefined,
        holder: object,
        key: 'src',
      });
    }
    for (const paintKey of ['fill', 'stroke']) {
      const paint = object[paintKey];
      if (isPlainObject(paint) && typeof paint.source === 'string' && paint.source.length > 0) {
        references.push({
          url: paint.source,
          objectId,
          crossOrigin: paint.crossOrigin as string | null | undefined,
          holder: paint,
          key: 'source',
        });
      }
    }
  });
  return references;
}

function characterStylesOf(styles: unknown): Record<string, unknown>[] {
  if (Array.isArray(styles)) {
    return styles.map((range) => (isPlainObject(range) && isPlainObject(range.style) ? range.style : {}));
  }
  if (!isPlainObject(styles)) return [];
  return Object.values(styles).flatMap((line) => (isPlainObject(line) ? Object.values(line).filter(isPlainObject) : []));
}

function textOf(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

export function findFontReferences(objects: readonly SerializedFabricObject[]): FontReference[] {
  const references: FontReference[] = [];
  visitObjects(objects, (object, objectId) => {
    if (typeof object.fontFamily !== 'string') return;
    const base: FontReference = {
      family: object.fontFamily,
      weight: textOf(object.fontWeight, 'normal'),
      style: textOf(object.fontStyle, 'normal'),
      objectId,
    };
    references.push(base);
    for (const characterStyle of characterStylesOf(object.styles)) {
      if (characterStyle.fontFamily === undefined && characterStyle.fontWeight === undefined && characterStyle.fontStyle === undefined) {
        continue;
      }
      references.push({
        family: textOf(characterStyle.fontFamily, base.family),
        weight: textOf(characterStyle.fontWeight, base.weight),
        style: textOf(characterStyle.fontStyle, base.style),
        objectId,
      });
    }
  });
  return references;
}
