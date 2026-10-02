export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SpatialIndexOptions {
  cellSize?: number;
  maxCellsPerItem?: number;
}

export interface SpatialIndex<Item> {
  set(item: Item, bounds: Rect): void;
  delete(item: Item): boolean;
  has(item: Item): boolean;
  query(bounds: Rect): Set<Item>;
  clear(): void;
  readonly size: number;
}

const OFFSET = 1 << 20;
const keyOf = (column: number, row: number): number => (column + OFFSET) * 2 ** 21 + (row + OFFSET);

export function createSpatialIndex<Item>(options: SpatialIndexOptions = {}): SpatialIndex<Item> {
  const cellSize = options.cellSize ?? 256;
  const maxCells = options.maxCellsPerItem ?? 64;
  const cells = new Map<number, Set<Item>>();
  const placed = new Map<Item, number[] | 'large'>();
  const large = new Set<Item>();

  const span = (bounds: Rect): [number, number, number, number] => [
    Math.floor(bounds.left / cellSize),
    Math.floor(bounds.top / cellSize),
    Math.floor((bounds.left + Math.max(0, bounds.width)) / cellSize),
    Math.floor((bounds.top + Math.max(0, bounds.height)) / cellSize),
  ];

  function remove(item: Item): boolean {
    const where = placed.get(item);
    if (where === undefined) return false;
    placed.delete(item);
    if (where === 'large') {
      large.delete(item);
      return true;
    }
    for (const key of where) {
      const bucket = cells.get(key)!;
      bucket.delete(item);
      if (bucket.size === 0) cells.delete(key);
    }
    return true;
  }

  return {
    set(item, bounds) {
      remove(item);
      const [left, top, right, bottom] = span(bounds);
      const count = (right - left + 1) * (bottom - top + 1);
      if (!Number.isFinite(count) || count > maxCells) {
        large.add(item);
        placed.set(item, 'large');
        return;
      }
      const keys: number[] = [];
      for (let column = left; column <= right; column += 1) {
        for (let row = top; row <= bottom; row += 1) {
          const key = keyOf(column, row);
          let bucket = cells.get(key);
          if (!bucket) cells.set(key, (bucket = new Set()));
          bucket.add(item);
          keys.push(key);
        }
      }
      placed.set(item, keys);
    },
    delete: remove,
    has: (item) => placed.has(item),
    query(bounds) {
      const found = new Set<Item>(large);
      const [left, top, right, bottom] = span(bounds);
      if ((right - left + 1) * (bottom - top + 1) > cells.size) {
        for (const [key, bucket] of cells) {
          const column = Math.floor(key / 2 ** 21) - OFFSET;
          const row = (key % 2 ** 21) - OFFSET;
          if (column >= left && column <= right && row >= top && row <= bottom) bucket.forEach((item) => found.add(item));
        }
        return found;
      }
      for (let column = left; column <= right; column += 1) {
        for (let row = top; row <= bottom; row += 1) cells.get(keyOf(column, row))?.forEach((item) => found.add(item));
      }
      return found;
    },
    clear() {
      cells.clear();
      placed.clear();
      large.clear();
    },
    get size() {
      return placed.size;
    },
  };
}
