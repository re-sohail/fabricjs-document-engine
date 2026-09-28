import type { FabricObject } from 'fabric';

interface ObjectWithId {
  id?: unknown;
}

export function readObjectId(object: FabricObject): string | undefined {
  const id = (object as unknown as ObjectWithId).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function writeObjectId(object: FabricObject, id: string): void {
  (object as unknown as ObjectWithId).id = id;
}
