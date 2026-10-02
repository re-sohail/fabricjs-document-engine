import type { FabricObject, StaticCanvas } from 'fabric';

export interface PerformanceMonitorOptions {
  samples?: number;
}

export interface FrameStats {
  frames: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  worstMs: number;
  lastObjectsDrawn: number;
}

export interface PerformanceMonitor {
  stats(): FrameStats;
  reset(): void;
  stop(): void;
}

interface CanvasInternals {
  getContext(): CanvasRenderingContext2D;
  _renderObjects(ctx: CanvasRenderingContext2D, objects: FabricObject[]): void;
  on(name: string, handler: (event: { ctx: CanvasRenderingContext2D }) => void): unknown;
  off(name: string, handler: (event: { ctx: CanvasRenderingContext2D }) => void): unknown;
}

export function createPerformanceMonitor(canvas: StaticCanvas, options: PerformanceMonitorOptions = {}): PerformanceMonitor {
  const self = canvas as unknown as CanvasInternals;
  const capacity = Math.max(1, options.samples ?? 120);
  const times = new Float64Array(capacity);
  let count = 0;
  let next = 0;
  let started = 0;
  let objectsDrawn = 0;
  let lastObjectsDrawn = 0;

  const onBefore = ({ ctx }: { ctx: CanvasRenderingContext2D }): void => {
    if (ctx !== self.getContext()) return;
    started = performance.now();
    objectsDrawn = 0;
  };
  const onAfter = ({ ctx }: { ctx: CanvasRenderingContext2D }): void => {
    if (ctx !== self.getContext() || started === 0) return;
    times[next] = performance.now() - started;
    next = (next + 1) % capacity;
    count = Math.min(count + 1, capacity);
    lastObjectsDrawn = objectsDrawn;
    started = 0;
  };
  const original = self._renderObjects;
  const hadOwn = Object.prototype.hasOwnProperty.call(canvas, '_renderObjects');
  function renderObjects(this: StaticCanvas, ctx: CanvasRenderingContext2D, objects: FabricObject[]): void {
    if (ctx === self.getContext()) objectsDrawn += objects.length;
    original.call(this, ctx, objects);
  }
  self._renderObjects = renderObjects;
  self.on('before:render', onBefore);
  self.on('after:render', onAfter);

  return {
    stats() {
      const recorded = Array.from(times.subarray(0, count)).sort((first, second) => first - second);
      const at = (share: number): number => (count === 0 ? 0 : recorded[Math.min(count - 1, Math.floor(share * count))]!);
      return {
        frames: count,
        averageMs: count === 0 ? 0 : recorded.reduce((sum, time) => sum + time, 0) / count,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        worstMs: count === 0 ? 0 : recorded[count - 1]!,
        lastObjectsDrawn,
      };
    },
    reset() {
      count = 0;
      next = 0;
    },
    stop() {
      self.off('before:render', onBefore);
      self.off('after:render', onAfter);
      if (self._renderObjects !== renderObjects) return;
      if (hadOwn) self._renderObjects = original;
      else delete (canvas as unknown as { _renderObjects?: unknown })._renderObjects;
    },
  };
}
