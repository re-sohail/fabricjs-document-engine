import type { FabricObject, StaticCanvas, TSVGReviver } from 'fabric';
import { walkObjects } from '../../fabric/walk-objects';

export type SvgWriter = (reviver?: TSVGReviver) => string;

/**
 * Runs `work` while chosen objects on the canvas, including objects in
 * groups, write their SVG with `writerFor`. Any toSVG an app set on an
 * object itself is put back afterwards. Returns how many objects were
 * handled.
 */
export function withSvgOverrides<Result>(
  canvas: StaticCanvas,
  writerFor: (object: FabricObject) => SvgWriter | undefined,
  work: () => Result,
): { result: Result; count: number } {
  const patched: Array<[FabricObject, PropertyDescriptor | undefined]> = [];
  walkObjects(canvas.getObjects(), (object) => {
    const writer = writerFor(object);
    if (!writer) return;
    patched.push([object, Object.getOwnPropertyDescriptor(object, 'toSVG')]);
    Object.defineProperty(object, 'toSVG', { configurable: true, writable: true, value: writer });
  });
  try {
    return { result: work(), count: patched.length };
  } finally {
    for (const [object, own] of patched) {
      if (own) Object.defineProperty(object, 'toSVG', own);
      else delete (object as unknown as { toSVG?: unknown }).toSVG;
    }
  }
}
