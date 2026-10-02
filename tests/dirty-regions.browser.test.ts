import { afterEach, describe, expect, it } from 'vitest';
import { Canvas, Circle, Group, IText, Rect, Shadow } from 'fabric';
import type { FabricObject } from 'fabric';
import { batchCanvasUpdates, createPerformanceMonitor, createSpatialIndex, enableDirtyRegionRendering } from '../src/performance';

const open: Canvas[] = [];

afterEach(async () => {
  for (const canvas of open.splice(0)) await canvas.dispose();
});

function makeCanvas(width = 600, height = 400): Canvas {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width, height, enableRetinaScaling: false, renderOnAddRemove: false, backgroundColor: '#fafafa' });
  open.push(canvas);
  return canvas;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function fill(canvas: Canvas, count: number, random = seeded(7)): FabricObject[] {
  const objects: FabricObject[] = [];
  for (let index = 0; index < count; index += 1) {
    objects.push(
      new Rect({
        left: random() * (canvas.width - 30),
        top: random() * (canvas.height - 30),
        width: 10 + random() * 30,
        height: 10 + random() * 30,
        fill: `hsl(${Math.floor(random() * 360)} 60% 50%)`,
        stroke: '#222',
        strokeWidth: 1,
        objectCaching: false,
      }),
    );
  }
  canvas.add(...objects);
  return objects;
}

function pixels(canvas: Canvas): Uint8ClampedArray {
  return canvas.getContext().getImageData(0, 0, canvas.width, canvas.height).data;
}

function differingPixels(first: Uint8ClampedArray, second: Uint8ClampedArray, width = 600, tolerance = 64): number {
  const height = first.length / 4 / width;
  const close = (one: Uint8ClampedArray, at: number, other: Uint8ClampedArray, to: number): boolean =>
    [0, 1, 2, 3].every((channel) => Math.abs(one[at + channel]! - other[to + channel]!) <= tolerance);
  const matchedNearby = (one: Uint8ClampedArray, other: Uint8ClampedArray, x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (close(one, (y * width + x) * 4, other, (ny * width + nx) * 4)) return true;
      }
    }
    return false;
  };
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      if (close(first, at, second, at)) continue;
      if (!matchedNearby(first, second, x, y) || !matchedNearby(second, first, x, y)) count += 1;
    }
  }
  return count;
}

describe('redrawing only what changed (fabric.js #9847)', () => {
  it('reproduces: moving one object redraws every object', () => {
    const canvas = makeCanvas();
    const objects = fill(canvas, 800);
    const monitor = createPerformanceMonitor(canvas);
    canvas.renderAll();
    objects[10]!.set({ left: objects[10]!.left + 5 });
    canvas.renderAll();
    expect(monitor.stats().lastObjectsDrawn).toBe(800);
    monitor.stop();
  });

  it('redraws only the objects near a moved one', () => {
    const canvas = makeCanvas();
    const objects = fill(canvas, 800);
    const renderer = enableDirtyRegionRendering(canvas);
    const monitor = createPerformanceMonitor(canvas);
    canvas.renderAll();
    for (let step = 0; step < 10; step += 1) {
      objects[10]!.set({ left: objects[10]!.left + 3, top: objects[10]!.top + 2 });
      canvas.renderAll();
      expect(renderer.stats().lastObjectsDrawn).toBeLessThan(80);
      expect(monitor.stats().lastObjectsDrawn).toBe(renderer.stats().lastObjectsDrawn);
    }
    const drawn = pixels(canvas);
    renderer.invalidate();
    canvas.renderAll();
    expect(differingPixels(drawn, pixels(canvas))).toBe(0);
    monitor.stop();
    renderer.disable();
  });

  it('matches a full redraw after every kind of change', async () => {
    const canvas = makeCanvas();
    const random = seeded(42);
    const objects = fill(canvas, 150, random);
    const text = new IText('Dirty regions', { left: 200, top: 150, fontSize: 30, fontStyle: 'italic' });
    const group = new Group([new Circle({ radius: 20, fill: 'red' }), new Rect({ left: 30, width: 20, height: 20, fill: 'blue' })], { left: 400, top: 250 });
    canvas.add(text, group);
    const renderer = enableDirtyRegionRendering(canvas);
    canvas.renderAll();
    const changes: Array<() => void> = [
      () => objects[1]!.set({ left: objects[1]!.left + 40 }),
      () => objects[2]!.set({ angle: 33 }),
      () => objects[3]!.set({ scaleX: 2.5, scaleY: 0.5 }),
      () => objects[4]!.set({ fill: 'black' }),
      () => objects[5]!.set({ shadow: new Shadow({ color: 'rgba(0,0,0,0.6)', blur: 12, offsetX: 15, offsetY: 10 }) }),
      () => objects[5]!.set({ left: objects[5]!.left - 30 }),
      () => objects[6]!.set({ opacity: 0.3 }),
      () => objects[7]!.set({ visible: false }),
      () => canvas.remove(objects[8]!),
      () => canvas.add(new Circle({ left: 100, top: 100, radius: 30, fill: 'green', stroke: 'black', strokeWidth: 6 })),
      () => canvas.bringObjectToFront(objects[9]!),
      () => text.set({ text: 'Changed text, longer' }),
      () => (group.getObjects()[0] as Circle).set({ fill: 'purple', radius: 30 }),
      () => group.set({ angle: 20 }),
      () => objects[11]!.set({ strokeWidth: 8, stroke: 'orange' }),
      () => objects[12]!.set({ globalCompositeOperation: 'multiply', left: 250, top: 160 }),
      () => canvas.setActiveObject(objects[13]!),
      () => objects[13]!.set({ left: objects[13]!.left + 25 }).setCoords(),
      () => canvas.setActiveObject(group),
      () => canvas.discardActiveObject(),
    ];
    for (const [position, change] of changes.entries()) {
      change();
      canvas.renderAll();
      const drawn = pixels(canvas);
      renderer.invalidate();
      canvas.renderAll();
      expect([position, differingPixels(drawn, pixels(canvas))]).toEqual([position, 0]);
    }
    for (let step = 0; step < 25; step += 1) {
      const target = objects[Math.floor(random() * objects.length)]!;
      target.set({ left: target.left + (random() - 0.5) * 80, top: target.top + (random() - 0.5) * 80, angle: random() * 360 });
      canvas.renderAll();
      const drawn = pixels(canvas);
      renderer.invalidate();
      canvas.renderAll();
      const bad = differingPixels(drawn, pixels(canvas));
      expect(bad).toBe(0);
    }
    expect(renderer.stats().frames).toBeGreaterThan(changes.length);
    renderer.disable();
  });

  it('draws in full when the view changes, and skips frames with no change', () => {
    const canvas = makeCanvas();
    fill(canvas, 50);
    const renderer = enableDirtyRegionRendering(canvas);
    canvas.renderAll();
    const before = renderer.stats();
    canvas.renderAll();
    expect(renderer.stats().skippedFrames).toBe(before.skippedFrames + 1);
    canvas.setZoom(1.5);
    canvas.renderAll();
    expect(renderer.stats().fullFrames).toBe(before.fullFrames + 1);
    renderer.disable();
  });

  it('draws in full when most of the canvas changed', () => {
    const canvas = makeCanvas();
    const objects = fill(canvas, 200);
    const renderer = enableDirtyRegionRendering(canvas);
    canvas.renderAll();
    const before = renderer.stats().fullFrames;
    objects.forEach((object) => object.set({ left: object.left + 1 }));
    canvas.renderAll();
    expect(renderer.stats().fullFrames).toBe(before + 1);
    renderer.disable();
  });

  it('leaves exports in full and puts Fabric back on disable', () => {
    const canvas = makeCanvas();
    const objects = fill(canvas, 100);
    const renderer = enableDirtyRegionRendering(canvas);
    canvas.renderAll();
    objects[0]!.set({ left: 5 });
    const exported = canvas.toCanvasElement();
    expect(exported.width).toBe(600);
    expect(Object.prototype.hasOwnProperty.call(canvas, 'renderCanvas')).toBe(true);
    renderer.disable();
    expect(Object.prototype.hasOwnProperty.call(canvas, 'renderCanvas')).toBe(false);
  });
});

describe('spatial index', () => {
  it('finds items by area and follows moves', () => {
    const index = createSpatialIndex<string>({ cellSize: 100 });
    index.set('a', { left: 10, top: 10, width: 20, height: 20 });
    index.set('b', { left: 500, top: 500, width: 20, height: 20 });
    index.set('huge', { left: -10000, top: -10000, width: 20000, height: 20000 });
    expect([...index.query({ left: 0, top: 0, width: 50, height: 50 })].sort()).toEqual(['a', 'huge']);
    index.set('a', { left: 520, top: 520, width: 5, height: 5 });
    expect([...index.query({ left: 0, top: 0, width: 50, height: 50 })]).toEqual(['huge']);
    expect([...index.query({ left: 490, top: 490, width: 50, height: 50 })].sort()).toEqual(['a', 'b', 'huge']);
    expect(index.delete('b')).toBe(true);
    expect(index.size).toBe(2);
    expect([...index.query({ left: -1e6, top: -1e6, width: 2e6, height: 2e6 })].sort()).toEqual(['a', 'huge']);
  });
});

describe('batched updates', () => {
  it('renders once at the end of nested batches, also async', async () => {
    const canvas = makeCanvas();
    canvas.renderOnAddRemove = true;
    let requests = 0;
    const original = canvas.requestRenderAll.bind(canvas);
    canvas.requestRenderAll = () => {
      requests += 1;
      original();
    };
    batchCanvasUpdates(canvas, () => {
      batchCanvasUpdates(canvas, () => fill(canvas, 20));
      fill(canvas, 20);
    });
    expect(requests).toBe(1);
    expect(canvas.renderOnAddRemove).toBe(true);
    await batchCanvasUpdates(canvas, async () => {
      await Promise.resolve();
      fill(canvas, 5);
    });
    expect(requests).toBe(2);
  });
});

describe('performance monitor', () => {
  it('records frame times and objects drawn', () => {
    const canvas = makeCanvas();
    fill(canvas, 100);
    const monitor = createPerformanceMonitor(canvas, { samples: 3 });
    for (let frame = 0; frame < 5; frame += 1) canvas.renderAll();
    const stats = monitor.stats();
    expect(stats.frames).toBe(3);
    expect(stats.lastObjectsDrawn).toBe(100);
    expect(stats.p95Ms).toBeGreaterThanOrEqual(stats.p50Ms);
    monitor.stop();
  });
});
