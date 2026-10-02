import type { FabricObject, StaticCanvas } from 'fabric';
import type { SerializedFabricObject } from '../document/document-format';
import { createObjects } from '../fabric/fabric-adapter';
import { readObjectId } from '../fabric/object-ids';
import { applyPage } from '../fabric/page-state';
import type { PageState } from '../fabric/page-state';
import { PAGE_KEY } from './snapshot';
import type { StateChange } from './snapshot';

interface CanvasWithSelection {
  discardActiveObject?: () => unknown;
}

function arrangeObjects(current: readonly FabricObject[], change: StateChange, created: Map<string, FabricObject>): FabricObject[] {
  const arranged: FabricObject[] = [];
  for (const object of current) {
    const id = readObjectId(object) ?? '';
    if (!change.objects.has(id)) {
      arranged.push(object);
      continue;
    }
    const replacement = created.get(id);
    if (replacement) {
      arranged.push(replacement);
      created.delete(id);
    }
  }
  arranged.push(...created.values());
  if (change.order === null) return arranged;

  const position = new Map(change.order.map((id, index) => [id, index]));
  return arranged.sort(
    (first, second) =>
      (position.get(readObjectId(first) ?? '') ?? Infinity) - (position.get(readObjectId(second) ?? '') ?? Infinity),
  );
}

/**
 * Applies a change. `isStale` is checked after every wait: when it returns
 * true the canvas now shows another document, so nothing is applied and the
 * call returns false.
 */
export async function applyStateChange(canvas: StaticCanvas, change: StateChange, isStale: () => boolean = () => false): Promise<boolean> {
  // The page goes first, so objects land on a canvas of the right size.
  const page = change.objects.get(PAGE_KEY);
  if (page) {
    if (isStale()) return false;
    await applyPage(canvas, JSON.parse(page) as PageState);
  }
  const serializedObjects: SerializedFabricObject[] = [];
  for (const [id, json] of change.objects) {
    if (id !== PAGE_KEY && json !== null) serializedObjects.push(JSON.parse(json) as SerializedFabricObject);
  }
  const createdObjects = await createObjects(serializedObjects);
  if (isStale()) {
    createdObjects.forEach((object) => object.dispose?.());
    return false;
  }
  const createdById = new Map(createdObjects.map((object) => [readObjectId(object) ?? '', object]));

  (canvas as unknown as CanvasWithSelection).discardActiveObject?.();
  const current = canvas.getObjects();
  const arranged = arrangeObjects(current, change, createdById);
  const kept = new Set(arranged);
  const renderOnAddRemove = canvas.renderOnAddRemove;
  canvas.renderOnAddRemove = false;
  try {
    const outgoing = current.filter((object) => !kept.has(object));
    if (outgoing.length > 0) canvas.remove(...outgoing);
    let onCanvas = canvas.getObjects();
    arranged.forEach((object, index) => {
      if (onCanvas[index] === object) return;
      if (object.canvas === canvas) canvas.moveObjectTo(object, index);
      else canvas.insertAt(index, object);
      onCanvas = canvas.getObjects();
    });
  } finally {
    canvas.renderOnAddRemove = renderOnAddRemove;
  }
  canvas.requestRenderAll();
  return true;
}
