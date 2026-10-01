import type { SerializedFabricObject } from '../document/document-format';

export interface CanvasSnapshot {
  objectsById: Map<string, string>;
  order: string[];
}

export interface StateChange {
  objects: Map<string, string | null>;
  order: string[] | null;
}

export interface SnapshotDifference {
  before: StateChange;
  after: StateChange;
}

/**
 * The page itself (size, background, overlay, mask) is one more entry in the
 * same map under this reserved key. It never appears in `order`, so the
 * diff stays proportional to what changed and object ordering is unaffected.
 * Object ids come from `createId`, which never produces this value.
 */
export const PAGE_KEY = '__page__';

export function createSnapshot(objects: readonly SerializedFabricObject[], page?: unknown): CanvasSnapshot {
  const objectsById = new Map<string, string>();
  const order: string[] = [];
  if (page !== undefined) objectsById.set(PAGE_KEY, JSON.stringify(page));
  for (const object of objects) {
    const id = object.id ?? '';
    objectsById.set(id, JSON.stringify(object));
    order.push(id);
  }
  return { objectsById, order };
}

function haveSameOrder(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

export function diffSnapshots(previous: CanvasSnapshot, next: CanvasSnapshot): SnapshotDifference | null {
  const before = new Map<string, string | null>();
  const after = new Map<string, string | null>();

  for (const [id, json] of next.objectsById) {
    const previousJson = previous.objectsById.get(id);
    if (previousJson === json) continue;
    before.set(id, previousJson ?? null);
    after.set(id, json);
  }
  for (const [id, json] of previous.objectsById) {
    if (next.objectsById.has(id)) continue;
    before.set(id, json);
    after.set(id, null);
  }

  const orderChanged = !haveSameOrder(previous.order, next.order);
  if (before.size === 0 && !orderChanged) return null;
  return {
    before: { objects: before, order: orderChanged ? previous.order : null },
    after: { objects: after, order: orderChanged ? next.order : null },
  };
}
