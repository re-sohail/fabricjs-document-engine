import type { FabricObject } from 'fabric';
import type { SerializedFabricObject } from '../document/document-format';

interface ObjectWithChildren {
  getObjects(): FabricObject[];
}

export function childrenOf(object: FabricObject): FabricObject[] {
  const container = object as unknown as Partial<ObjectWithChildren>;
  return typeof container.getObjects === 'function' ? container.getObjects() : [];
}

export function walkObjects(roots: readonly FabricObject[], visit: (object: FabricObject) => void): void {
  const pending = [...roots].reverse();
  while (pending.length > 0) {
    const object = pending.pop()!;
    visit(object);
    const children = childrenOf(object);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
}

export function collectSerializedTypes(objects: readonly SerializedFabricObject[]): Set<string> {
  const types = new Set<string>();
  const pending = [...objects];
  while (pending.length > 0) {
    const object = pending.pop()!;
    types.add(object.type);
    if (object.objects) pending.push(...object.objects);
    if (object.clipPath) pending.push(object.clipPath);
  }
  return types;
}
