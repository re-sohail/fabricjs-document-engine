import type { SerializedFabricObject } from '../document/document-format';
import { findFontReferences, findImageReferences } from './asset-references';

export interface ImageAsset {
  url: string;
  objectIds: string[];
}

export interface FontAsset {
  family: string;
  weight: string;
  style: string;
  objectIds: string[];
}

export interface AssetManifest {
  images: ImageAsset[];
  fonts: FontAsset[];
}

export function isEmbeddedUrl(url: string): boolean {
  return url.startsWith('data:');
}

export function fontKey(font: Pick<FontAsset, 'family' | 'weight' | 'style'>): string {
  return `${font.style}|${font.weight}|${font.family}`;
}

function addObjectId(objectIds: string[], objectId: string | undefined): void {
  if (objectId !== undefined && !objectIds.includes(objectId)) objectIds.push(objectId);
}

export function buildAssetManifest(objects: readonly SerializedFabricObject[]): AssetManifest {
  const imagesByUrl = new Map<string, ImageAsset>();
  for (const reference of findImageReferences(objects)) {
    if (isEmbeddedUrl(reference.url)) continue;
    const image = imagesByUrl.get(reference.url) ?? { url: reference.url, objectIds: [] };
    addObjectId(image.objectIds, reference.objectId);
    imagesByUrl.set(reference.url, image);
  }

  const fontsByKey = new Map<string, FontAsset>();
  for (const reference of findFontReferences(objects)) {
    const key = fontKey(reference);
    const font = fontsByKey.get(key) ?? { family: reference.family, weight: reference.weight, style: reference.style, objectIds: [] };
    addObjectId(font.objectIds, reference.objectId);
    fontsByKey.set(key, font);
  }

  return { images: [...imagesByUrl.values()], fonts: [...fontsByKey.values()] };
}
