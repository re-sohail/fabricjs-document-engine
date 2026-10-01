import type { FabricObject, TSVGReviver } from 'fabric';
import { walkObjects } from '../../fabric/walk-objects';

/**
 * Clip paths Fabric cannot write as SVG (fabric.js #10460).
 *
 * - An inverted clip path (`inverted: true`) shows everything outside the
 *   shape. Fabric writes it as an ordinary `<clipPath>`, which shows the
 *   inside instead. An SVG `<mask>` draws it exactly: white everywhere, the
 *   shape in black.
 * - A clip path that has its own clip path: Fabric 7 throws while writing the
 *   SVG and Fabric 6 writes `url(#undefined)`. The object is drawn as a
 *   picture instead, with a warning.
 */

interface Clippable {
  clipPath?: (FabricObject & Clippable & { inverted?: boolean; clipPathId?: string }) | undefined;
}

/** True when a clip path anywhere in the object's tree has a clip path of its own. */
export function hasNestedClipPath(object: FabricObject): boolean {
  let nested = false;
  walkObjects([object], (child) => {
    if ((child as unknown as Clippable).clipPath?.clipPath) nested = true;
  });
  return nested;
}

/** True when a clip path anywhere in the object's tree is inverted. */
export function hasInvertedClipPath(object: FabricObject): boolean {
  let inverted = false;
  walkObjects([object], (child) => {
    if ((child as unknown as Clippable).clipPath?.inverted) inverted = true;
  });
  return inverted;
}

/** True when the object's own clip path is inverted (and simple). */
export function ownClipPathIsInverted(object: FabricObject): boolean {
  const clipPath = (object as unknown as Clippable).clipPath;
  return Boolean(clipPath?.inverted) && !clipPath?.clipPath;
}

const FAR = 1_000_000;

/**
 * Turns the object's own `<clipPath>` in Fabric's markup into an inverting
 * `<mask>`. `write` produces the markup with the clip path not inverted; the
 * id Fabric gave the clip path picks out exactly this object's definition.
 */
export function writeWithInvertedMask(object: FabricObject, write: (reviver?: TSVGReviver) => string, reviver?: TSVGReviver): string {
  const clipPath = (object as unknown as Clippable).clipPath!;
  clipPath.inverted = false;
  let markup: string;
  try {
    markup = write(reviver);
  } finally {
    clipPath.inverted = true;
  }
  const id = clipPath.clipPathId;
  if (!id) return markup;
  const definition = new RegExp(`<clipPath id="${id}"\\s*>([\\s\\S]*?)</clipPath>`);
  return markup
    .replace(
      definition,
      (_, shape: string) =>
        `<mask id="${id}" maskUnits="userSpaceOnUse" x="${-FAR}" y="${-FAR}" width="${2 * FAR}" height="${2 * FAR}">\n` +
        `<rect x="${-FAR}" y="${-FAR}" width="${2 * FAR}" height="${2 * FAR}" fill="white" />\n` +
        `<g fill="black" stroke="none">${shape}</g>\n</mask>`,
    )
    .replace(`clip-path="url(#${id})"`, `mask="url(#${id})"`);
}
