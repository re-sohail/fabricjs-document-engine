import type { FabricObject, StaticCanvas, TMat2D } from 'fabric';
import { createSpatialIndex } from './spatial-index';
import type { Rect } from './spatial-index';

export interface DirtyRegionOptions {
  fullRedrawRatio?: number;
  maxRegions?: number;
  cellSize?: number;
}

export interface DirtyRegionStats {
  frames: number;
  fullFrames: number;
  skippedFrames: number;
  lastObjectsDrawn: number;
  lastAreaRatio: number;
  lastRegions: Rect[];
}

export interface DirtyRegionRenderer {
  invalidate(): void;
  stats(): DirtyRegionStats;
  disable(): void;
}

const UNBOUNDED_COMPOSITES = new Set(['source-in', 'source-out', 'destination-in', 'destination-atop', 'copy']);

interface ObjectState {
  fingerprint: unknown[];
  bounds: Rect;
  seen: number;
}

interface CanvasInternals {
  _objects: FabricObject[];
  contextContainer?: CanvasRenderingContext2D;
  getContext(): CanvasRenderingContext2D;
  renderCanvas(ctx: CanvasRenderingContext2D, objects: FabricObject[]): void;
  getActiveObject?(): FabricObject | undefined;
  getRetinaScaling(): number;
  viewportTransform: TMat2D;
  width: number;
  height: number;
  backgroundColor?: unknown;
  backgroundImage?: FabricObject;
  overlayColor?: unknown;
  overlayImage?: FabricObject;
  clipPath?: FabricObject;
  fire(name: string, options?: unknown): void;
}

interface ObjectInternals {
  dirty?: boolean;
  shadow?: { blur: number; offsetX: number; offsetY: number; nonScaling?: boolean } | null;
  strokeWidth?: number;
  strokeMiterLimit?: number;
  stroke?: unknown;
  fontSize?: number;
  globalCompositeOperation?: string;
  _element?: unknown;
  cornerSize?: number;
  touchCornerSize?: number;
  padding?: number;
  hasControls?: boolean;
  hasBorders?: boolean;
  oCoords?: Record<string, { x: number; y: number }>;
  _objects?: FabricObject[];
  text?: string;
}

function union(first: Rect, second: Rect): Rect {
  const left = Math.min(first.left, second.left);
  const top = Math.min(first.top, second.top);
  return {
    left,
    top,
    width: Math.max(first.left + first.width, second.left + second.width) - left,
    height: Math.max(first.top + first.height, second.top + second.height) - top,
  };
}

function intersects(first: Rect, second: Rect, gap = 0): boolean {
  return (
    first.left <= second.left + second.width + gap &&
    second.left <= first.left + first.width + gap &&
    first.top <= second.top + second.height + gap &&
    second.top <= first.top + first.height + gap
  );
}

const area = (rect: Rect): number => Math.max(0, rect.width) * Math.max(0, rect.height);

function overhang(object: FabricObject): { x: number; y: number } {
  const self = object as unknown as ObjectInternals;
  let x = 0;
  let y = 0;
  if (self.stroke && self.strokeWidth) {
    const join = (self.strokeWidth * Math.max(1, self.strokeMiterLimit ?? 4)) / 2;
    x = y = join;
  }
  if (typeof self.fontSize === 'number' && typeof self.text === 'string') {
    x = Math.max(x, self.fontSize * 0.5);
    y = Math.max(y, self.fontSize * 0.5);
  }
  for (const child of self._objects ?? []) {
    const inner = overhang(child);
    const childShadow = shadowReach(child);
    x = Math.max(x, inner.x + childShadow.x);
    y = Math.max(y, inner.y + childShadow.y);
  }
  return { x, y };
}

function shadowReach(object: FabricObject): { x: number; y: number } {
  const shadow = (object as unknown as ObjectInternals).shadow;
  if (!shadow) return { x: 0, y: 0 };
  return { x: Math.abs(shadow.offsetX) + shadow.blur * 2, y: Math.abs(shadow.offsetY) + shadow.blur * 2 };
}

function drawnBounds(object: FabricObject): Rect {
  object.setCoords();
  const box = object.getBoundingRect();
  const scaling = object.getObjectScaling();
  const scaleX = Math.abs(scaling.x);
  const scaleY = Math.abs(scaling.y);
  const reach = overhang(object);
  const shadow = shadowReach(object);
  const nonScaling = Boolean((object as unknown as ObjectInternals).shadow?.nonScaling);
  const grow = Math.max(reach.x * scaleX, reach.y * scaleY) + Math.max(shadow.x, shadow.y) * (nonScaling ? 1 : Math.max(scaleX, scaleY));
  let bounds: Rect = { left: box.left - grow, top: box.top - grow, width: box.width + grow * 2, height: box.height + grow * 2 };
  for (const child of (object as unknown as ObjectInternals)._objects ?? []) bounds = union(bounds, drawnBounds(child));
  return bounds;
}

function fingerprint(object: FabricObject, index: number, into: unknown[] = []): unknown[] {
  const self = object as unknown as ObjectInternals & FabricObject;
  const matrix = object.calcTransformMatrix();
  const shadow = self.shadow;
  into.push(
    index,
    matrix[0],
    matrix[1],
    matrix[2],
    matrix[3],
    matrix[4],
    matrix[5],
    self.width,
    self.height,
    self.visible,
    self.opacity,
    self.strokeWidth,
    self.globalCompositeOperation,
    self._element,
    self.clipPath,
    shadow,
    shadow?.blur,
    shadow?.offsetX,
    shadow?.offsetY,
  );
  self._objects?.forEach((child, position) => fingerprint(child, position, into));
  return into;
}

function isDirty(object: FabricObject): boolean {
  const self = object as unknown as ObjectInternals;
  return Boolean(self.dirty) || (self._objects ?? []).some(isDirty);
}

function sameFingerprint(first: unknown[], second: unknown[]): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) if (first[index] !== second[index]) return false;
  return true;
}

function toViewport(rect: Rect, matrix: TMat2D): Rect {
  const [a, b, c, d, e, f] = matrix;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [rect.left, rect.top],
    [rect.left + rect.width, rect.top],
    [rect.left, rect.top + rect.height],
    [rect.left + rect.width, rect.top + rect.height],
  ] as const) {
    xs.push(a * x + c * y + e);
    ys.push(b * x + d * y + f);
  }
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

function toScene(rect: Rect, matrix: TMat2D): Rect {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  const inverse: TMat2D = [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
  return toViewport(rect, inverse);
}

function controlsArea(canvas: CanvasInternals): { key: unknown[]; rect: Rect | undefined } {
  const active = canvas.getActiveObject?.();
  if (!active) return { key: [], rect: undefined };
  const self = active as unknown as ObjectInternals;
  const points = Object.values(self.oCoords ?? {});
  if (points.length === 0 || (!self.hasControls && !self.hasBorders)) return { key: [active], rect: undefined };
  const reach = Math.max(self.cornerSize ?? 13, self.touchCornerSize ?? 0) / 2 + (self.padding ?? 0) + 4;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const key: unknown[] = [active, self.hasControls, self.hasBorders];
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
    key.push(point.x, point.y);
  }
  return { key, rect: { left: left - reach, top: top - reach, width: right - left + reach * 2, height: bottom - top + reach * 2 } };
}

function mergeRects(rects: Rect[], limit: number): Rect[] {
  if (rects.length > 64) return [rects.reduce(union)];
  const merged = [...rects];
  let changed = true;
  while (changed) {
    changed = false;
    for (let first = 0; first < merged.length && !changed; first += 1) {
      for (let second = first + 1; second < merged.length; second += 1) {
        if (intersects(merged[first]!, merged[second]!, 8)) {
          merged[first] = union(merged[first]!, merged[second]!);
          merged.splice(second, 1);
          changed = true;
          break;
        }
      }
    }
  }
  while (merged.length > limit) {
    let best = [0, 1];
    let bestGrowth = Infinity;
    for (let first = 0; first < merged.length; first += 1) {
      for (let second = first + 1; second < merged.length; second += 1) {
        const growth = area(union(merged[first]!, merged[second]!)) - area(merged[first]!) - area(merged[second]!);
        if (growth < bestGrowth) {
          bestGrowth = growth;
          best = [first, second];
        }
      }
    }
    merged[best[0]!] = union(merged[best[0]!]!, merged[best[1]!]!);
    merged.splice(best[1]!, 1);
  }
  return merged;
}

export function enableDirtyRegionRendering(canvas: StaticCanvas, options: DirtyRegionOptions = {}): DirtyRegionRenderer {
  const self = canvas as unknown as CanvasInternals;
  const fullRatio = options.fullRedrawRatio ?? 0.4;
  const maxRegions = Math.max(1, options.maxRegions ?? 4);
  const index = createSpatialIndex<FabricObject>({ cellSize: options.cellSize ?? 256 });
  const states = new Map<FabricObject, ObjectState>();
  const unbounded = new Set<FabricObject>();
  const original = self.renderCanvas;
  const hadOwn = Object.prototype.hasOwnProperty.call(canvas, 'renderCanvas');
  const stats: DirtyRegionStats = { frames: 0, fullFrames: 0, skippedFrames: 0, lastObjectsDrawn: 0, lastAreaRatio: 0, lastRegions: [] };
  let frame = 0;
  let forceFull = true;
  let lastPage: unknown[] = [];
  let lastControls: { key: unknown[]; rect: Rect | undefined } = { key: [], rect: undefined };

  const pageKey = (): unknown[] => [
    ...self.viewportTransform,
    self.width,
    self.height,
    self.getRetinaScaling(),
    self.backgroundColor,
    self.backgroundImage,
    (self.backgroundImage as ObjectInternals | undefined)?.dirty,
    self.overlayColor,
    self.overlayImage,
    (self.overlayImage as ObjectInternals | undefined)?.dirty,
    self.clipPath,
    (self.clipPath as ObjectInternals | undefined)?.dirty,
  ];

  function track(object: FabricObject, position: number): Rect[] {
    const print = fingerprint(object, position);
    const state = states.get(object);
    if (state) {
      state.seen = frame;
      if (!isDirty(object) && sameFingerprint(state.fingerprint, print)) return [];
    }
    const bounds = drawnBounds(object);
    states.set(object, { fingerprint: print, bounds, seen: frame });
    index.set(object, bounds);
    const composite = (object as unknown as ObjectInternals).globalCompositeOperation ?? 'source-over';
    if (UNBOUNDED_COMPOSITES.has(composite)) unbounded.add(object);
    else unbounded.delete(object);
    return state ? [state.bounds, bounds] : [bounds];
  }

  function drawFull(ctx: CanvasRenderingContext2D, objects: FabricObject[]): void {
    stats.fullFrames += 1;
    stats.lastObjectsDrawn = objects.length;
    stats.lastAreaRatio = 1;
    stats.lastRegions = [];
    original.call(canvas, ctx, objects);
  }

  function renderCanvas(this: StaticCanvas, ctx: CanvasRenderingContext2D, objects: FabricObject[]): void {
    if (ctx !== self.getContext()) {
      original.call(canvas, ctx, objects);
      return;
    }
    frame += 1;
    stats.frames += 1;
    const changed: Rect[] = [];
    self._objects.forEach((object, position) => changed.push(...track(object, position)));
    for (const [object, state] of states) {
      if (state.seen === frame) continue;
      changed.push(state.bounds);
      states.delete(object);
      index.delete(object);
      unbounded.delete(object);
    }
    const page = pageKey();
    const controls = controlsArea(self);
    const pageChanged = !sameFingerprint(page, lastPage) || page.length !== lastPage.length;
    const controlsChanged = !sameFingerprint(controls.key, lastControls.key) || controls.key.length !== lastControls.key.length;
    const viewportChanged: Rect[] = [];
    if (controlsChanged) {
      if (lastControls.rect) viewportChanged.push(lastControls.rect);
      if (controls.rect) viewportChanged.push(controls.rect);
      const before = lastControls.key[0] as FabricObject | undefined;
      const after = controls.key[0] as FabricObject | undefined;
      for (const object of [before, after]) {
        const state = object ? states.get(object) : undefined;
        if (state) changed.push(state.bounds);
      }
    }
    lastPage = page;
    lastControls = controls;
    if (forceFull || pageChanged) {
      forceFull = false;
      drawFull(ctx, objects);
      return;
    }
    const matrix = self.viewportTransform;
    const retina = self.getRetinaScaling();
    const canvasRect: Rect = { left: 0, top: 0, width: self.width, height: self.height };
    const regions: Rect[] = [];
    for (const rect of [...changed.map((scene) => toViewport(scene, matrix)), ...viewportChanged]) {
      const pad = 2 / retina;
      const left = Math.max(0, Math.floor((rect.left - pad) * retina) / retina);
      const top = Math.max(0, Math.floor((rect.top - pad) * retina) / retina);
      const right = Math.min(self.width, Math.ceil((rect.left + rect.width + pad) * retina) / retina);
      const bottom = Math.min(self.height, Math.ceil((rect.top + rect.height + pad) * retina) / retina);
      if (right > left && bottom > top) regions.push({ left, top, width: right - left, height: bottom - top });
    }
    if (regions.length === 0) {
      stats.skippedFrames += 1;
      stats.lastObjectsDrawn = 0;
      stats.lastAreaRatio = 0;
      stats.lastRegions = [];
      self.fire('before:render', { ctx });
      self.fire('after:render', { ctx });
      return;
    }
    const merged = mergeRects(regions, maxRegions);
    const drawnArea = merged.reduce((sum, rect) => sum + area(rect), 0);
    if (drawnArea > area(canvasRect) * fullRatio) {
      drawFull(ctx, objects);
      return;
    }
    const wanted = new Set<FabricObject>(unbounded);
    for (const rect of merged) {
      const pad = 2 / retina;
      const scene = toScene({ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }, matrix);
      index.query(scene).forEach((object) => {
        const bounds = states.get(object)?.bounds;
        if (!bounds || intersects(bounds, scene)) wanted.add(object);
      });
    }
    const toDraw = objects.filter((object) => wanted.has(object));
    stats.lastObjectsDrawn = toDraw.length;
    stats.lastAreaRatio = drawnArea / area(canvasRect);
    stats.lastRegions = merged;
    ctx.save();
    ctx.beginPath();
    for (const rect of merged) ctx.rect(rect.left, rect.top, rect.width, rect.height);
    ctx.clip();
    try {
      original.call(canvas, ctx, toDraw);
    } finally {
      ctx.restore();
    }
  }

  self.renderCanvas = renderCanvas as never;

  return {
    invalidate() {
      forceFull = true;
    },
    stats: () => ({ ...stats, lastRegions: [...stats.lastRegions] }),
    disable() {
      if (self.renderCanvas !== (renderCanvas as never)) return;
      if (hadOwn) self.renderCanvas = original;
      else delete (canvas as unknown as { renderCanvas?: unknown }).renderCanvas;
      index.clear();
      states.clear();
    },
  };
}
