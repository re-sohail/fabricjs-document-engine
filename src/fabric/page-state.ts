import { util } from 'fabric';
import type { StaticCanvas } from 'fabric';
import type { SerializedFabricObject } from '../document/document-format';

/**
 * Everything about the page itself rather than the objects on it: its size,
 * its background color or pattern, a background image, an overlay color or
 * image, and a mask that clips the whole canvas. Fabric writes these with
 * `canvas.toObject()` under the same names.
 */
export interface PageState {
  width: number;
  height: number;
  background?: unknown;
  backgroundImage?: SerializedFabricObject;
  overlay?: unknown;
  overlayImage?: SerializedFabricObject;
  clipPath?: SerializedFabricObject;
}

/** The page fields saved with a document, besides its size. */
export const PAGE_FIELDS = ['background', 'backgroundImage', 'overlay', 'overlayImage', 'clipPath'] as const;

export type PageField = (typeof PAGE_FIELDS)[number];

/** Copies the page fields that are set from serialized canvas output. */
export function pickPageFields(source: Partial<Record<PageField, unknown>>): Partial<Record<PageField, unknown>> {
  const picked: Partial<Record<PageField, unknown>> = {};
  for (const field of PAGE_FIELDS) {
    if (source[field] !== undefined && source[field] !== null) picked[field] = source[field];
  }
  return picked;
}

/** The canvas-level objects that can hold images or other objects: background and overlay images and the mask. */
export function pageObjects(page: Partial<Record<PageField, unknown>>): SerializedFabricObject[] {
  const objects: SerializedFabricObject[] = [];
  for (const field of ['backgroundImage', 'overlayImage', 'clipPath'] as const) {
    const value = page[field];
    if (typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string') {
      objects.push(value as SerializedFabricObject);
    }
  }
  return objects;
}

/**
 * Creates the live values for `canvas.set`: Fabric objects for the images
 * and mask, gradients and patterns for colors. Missing fields become
 * `undefined`, which clears them on the canvas.
 */
export function enlivenPage(page: Partial<Record<PageField, unknown>>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return util.enlivenObjectEnlivables<Record<string, unknown>>(
    {
      backgroundColor: page.background,
      backgroundImage: page.backgroundImage,
      overlayColor: page.overlay,
      overlayImage: page.overlayImage,
      clipPath: page.clipPath,
    } as never,
    signal ? { signal } : {},
  );
}

/** Applies a page state: the size first, then the enlivened fields. */
export async function applyPage(canvas: StaticCanvas, page: PageState): Promise<void> {
  const live = await enlivenPage(page);
  if (canvas.getWidth() !== page.width || canvas.getHeight() !== page.height) {
    canvas.setDimensions({ width: page.width, height: page.height });
  }
  canvas.set(live as never);
  canvas.requestRenderAll();
}

/**
 * Every top-level object a document holds: the objects on the page, then its
 * background image, overlay image and mask. Asset checks, address checks and
 * type checks walk this list, so they cover the page as well.
 */
export function documentObjects(document: {
  objects: readonly SerializedFabricObject[];
  canvas?: Partial<Record<PageField, unknown>>;
}): SerializedFabricObject[] {
  const page = document.canvas ? pageObjects(document.canvas) : [];
  return page.length === 0 ? [...document.objects] : [...document.objects, ...page];
}
