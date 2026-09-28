import type { FabricObject, StaticCanvas } from 'fabric';
import type { SerializedFabricObject } from '../document/document-format';
import { createObjects } from '../fabric/fabric-adapter';
import { readObjectId } from '../fabric/object-ids';
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

export async function applyStateChange(canvas: StaticCanvas, change: StateChange): Promise<void> {
  const serializedObjects: SerializedFabricObject[] = [];
  for (const json of change.objects.values()) {
    if (json !== null) serializedObjects.push(JSON.parse(json) as SerializedFabricObject);
  }
  const createdObjects = await createObjects(serializedObjects);
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
    arranged.forEach((object, index) => {
      if (canvas.getObjects()[index] === object) return;
      if (object.canvas === canvas) canvas.moveObjectTo(object, index);
      else canvas.insertAt(index, object);
    });
  } finally {
    canvas.renderOnAddRemove = renderOnAddRemove;
  }
  canvas.requestRenderAll();
}
