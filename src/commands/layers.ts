import type { FabricObject } from 'fabric';
import type { DocumentEngine } from '../engine/create-document-engine';
import { readObjectId } from '../fabric/object-ids';

/**
 * Keeps an object where it is in the stack. Use it for a background that must
 * stay at the bottom or a frame that must stay on top.
 */
export type LayerPin = (object: FabricObject) => boolean;

export interface LayerOptions {
  /** Objects this returns true for never move, and keep their place in the stack. */
  pinned?: LayerPin;
}

export interface LayerInfo {
  id: string | undefined;
  type: string;
  /** The object's `name` property, when it has one. */
  name: string | undefined;
  /** Position from the bottom of the stack, as Fabric counts it. */
  index: number;
  visible: boolean;
  /** True when the object cannot be selected. */
  locked: boolean;
}

interface SelectionCanvas {
  getActiveObjects?: () => FabricObject[];
}

function chosenObjects(engine: DocumentEngine, objects: readonly FabricObject[] | undefined): Set<FabricObject> {
  const list = objects ?? (engine.canvas as unknown as SelectionCanvas).getActiveObjects?.() ?? [];
  const stack = new Set(engine.canvas.getObjects());
  return new Set(list.filter((object) => stack.has(object)));
}

/**
 * Works out the new order on the objects that may move, then puts every
 * pinned object back at the index it had.
 */
function reorder(
  engine: DocumentEngine,
  label: string,
  objects: readonly FabricObject[] | undefined,
  options: LayerOptions,
  arrange: (free: FabricObject[], chosen: Set<FabricObject>) => FabricObject[],
): boolean {
  const stack = engine.canvas.getObjects();
  const isPinned = options.pinned ?? (() => false);
  const chosen = chosenObjects(engine, objects);
  for (const object of chosen) if (isPinned(object)) chosen.delete(object);
  if (chosen.size === 0) return false;

  const pinnedAt = new Map<number, FabricObject>();
  const free: FabricObject[] = [];
  stack.forEach((object, index) => {
    if (isPinned(object)) pinnedAt.set(index, object);
    else free.push(object);
  });

  const arranged = arrange(free, chosen);
  const next: FabricObject[] = [];
  let freeIndex = 0;
  for (let index = 0; index < stack.length; index += 1) {
    next.push(pinnedAt.get(index) ?? arranged[freeIndex++]!);
  }
  if (next.every((object, index) => object === stack[index])) return false;

  engine.transaction(chosen.size === 1 ? label : `${label} (${chosen.size} objects)`, () => {
    next.forEach((object, index) => {
      if (engine.canvas.getObjects()[index] !== object) engine.canvas.moveObjectTo(object, index);
    });
  });
  engine.canvas.requestRenderAll();
  return true;
}

/** Moves objects, or the selection, to the top of the stack. Returns false when nothing moved. */
export function bringToFront(engine: DocumentEngine, objects?: readonly FabricObject[], options: LayerOptions = {}): boolean {
  return reorder(engine, 'Bring to front', objects, options, (free, chosen) => [
    ...free.filter((object) => !chosen.has(object)),
    ...free.filter((object) => chosen.has(object)),
  ]);
}

/** Moves objects, or the selection, to the bottom of the stack. Returns false when nothing moved. */
export function sendToBack(engine: DocumentEngine, objects?: readonly FabricObject[], options: LayerOptions = {}): boolean {
  return reorder(engine, 'Send to back', objects, options, (free, chosen) => [
    ...free.filter((object) => chosen.has(object)),
    ...free.filter((object) => !chosen.has(object)),
  ]);
}

/** Moves objects, or the selection, one step up. Selected objects next to each other move as a block. */
export function bringForward(engine: DocumentEngine, objects?: readonly FabricObject[], options: LayerOptions = {}): boolean {
  return reorder(engine, 'Bring forward', objects, options, (free, chosen) => {
    const next = [...free];
    for (let index = next.length - 2; index >= 0; index -= 1) {
      if (chosen.has(next[index]!) && !chosen.has(next[index + 1]!)) {
        [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
      }
    }
    return next;
  });
}

/** Moves objects, or the selection, one step down. Selected objects next to each other move as a block. */
export function sendBackward(engine: DocumentEngine, objects?: readonly FabricObject[], options: LayerOptions = {}): boolean {
  return reorder(engine, 'Send backward', objects, options, (free, chosen) => {
    const next = [...free];
    for (let index = 1; index < next.length; index += 1) {
      if (chosen.has(next[index]!) && !chosen.has(next[index - 1]!)) {
        [next[index], next[index - 1]] = [next[index - 1]!, next[index]!];
      }
    }
    return next;
  });
}

/**
 * Moves objects to `index`, counted from the bottom among objects that are not
 * pinned. Several objects keep their order and land as a block.
 */
export function moveToIndex(
  engine: DocumentEngine,
  objects: readonly FabricObject[],
  index: number,
  options: LayerOptions = {},
): boolean {
  return reorder(engine, 'Move layer', objects, options, (free, chosen) => {
    const rest = free.filter((object) => !chosen.has(object));
    const block = free.filter((object) => chosen.has(object));
    const at = Math.max(0, Math.min(Math.floor(index), rest.length));
    return [...rest.slice(0, at), ...block, ...rest.slice(at)];
  });
}

/** The top-level objects from top to bottom, for a layers panel. */
export function getLayers(engine: DocumentEngine): LayerInfo[] {
  return engine.canvas
    .getObjects()
    .map((object, index) => {
      const name = (object as unknown as { name?: unknown }).name;
      return {
        id: readObjectId(object),
        type: object.type,
        name: typeof name === 'string' ? name : undefined,
        index,
        visible: object.visible !== false,
        locked: object.selectable === false,
      };
    })
    .reverse();
}
