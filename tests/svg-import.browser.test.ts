import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Group, loadSVGFromString, util } from 'fabric';
import type { FabricObject } from 'fabric';
import { createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, DocumentEngineOptions, SvgImportOptions } from '../src';
import { inkDifference, rasterizeCanvas, rasterizeSvg } from './support/pixels';

/**
 * SVG import keeps the SVG's viewport (fabric.js #10916). The browser draws
 * each test SVG as an image, and the canvas after import must look the same.
 */

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(width = 200, height = 200, options: Omit<DocumentEngineOptions, 'canvas'> = {}): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width, height, backgroundColor: 'white' });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas, ...options });
  openEngines.push(engine);
  return engine;
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => (isDocumentEngineError(error) ? error.code : error),
  );
}

/** Imports at 0, 0 and compares the canvas with the browser's own drawing of the file. */
async function importAndCompare(svg: string, width: number, height: number, options: SvgImportOptions = {}): Promise<number> {
  const engine = createEngine(width, height);
  await engine.importSvg(svg, options);
  engine.canvas.renderAll();
  return inkDifference(rasterizeCanvas(engine.canvas), await rasterizeSvg(svg, width, height));
}

const offscreenSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect x="40" y="40" width="60" height="40" fill="teal"/>
  <circle cx="900" cy="700" r="30" fill="orange"/>
  <rect x="-400" y="-300" width="20" height="20" fill="purple" style="display:none"/>
</svg>`;

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`SVG import on Fabric ${fabric.version}`, () => {
  it('reproduces the problem: grouping by content moves artwork when something is outside the viewport', async () => {
    const { objects, options } = await loadSVGFromString(offscreenSvg);
    const group = util.groupSVGElements(objects.filter(Boolean) as FabricObject[], options);
    group.set({ left: 0, top: 0, originX: 'left', originY: 'top' });
    group.setCoords();
    // The group's corner is the far element's, not the viewport's, so the teal rectangle is not at 40, 40.
    const teal = (group as Group).getObjects()[0]!;
    expect(Math.abs(teal.getBoundingRect().left - 40)).toBeGreaterThan(5);
  });

  it('keeps every element where the SVG puts it, whatever lies outside the viewport', async () => {
    const engine = createEngine();
    const result = await engine.importSvg(offscreenSvg);
    const group = result.objects[0] as Group;
    expect(result.viewport).toEqual({ width: 200, height: 200 });
    expect(group.width).toBe(200);
    expect(group.height).toBe(200);
    // Fabric's bounding box includes half of the default 1 unit stroke.
    const teal = group.getObjects()[0]!.getBoundingRect();
    expect(teal.left).toBeCloseTo(39.5, 3);
    expect(teal.top).toBeCloseTo(39.5, 3);
    engine.canvas.renderAll();
    expect(inkDifference(rasterizeCanvas(engine.canvas), await rasterizeSvg(offscreenSvg, 200, 200))).toBeLessThan(0.02);
  });

  it('matches the browser for a viewBox with an offset and a scale', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="50 50 100 100">
      <rect x="60" y="60" width="30" height="20" fill="crimson"/><circle cx="120" cy="120" r="15" fill="navy"/></svg>`;
    expect(await importAndCompare(svg, 200, 200)).toBeLessThan(0.02);
  });

  it('matches the browser without a viewBox', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120">
      <rect x="20" y="30" width="50" height="40" fill="green"/><ellipse cx="110" cy="60" rx="30" ry="20" fill="gold"/></svg>`;
    expect(await importAndCompare(svg, 160, 120)).toBeLessThan(0.02);
  });

  it('matches the browser for nested transforms', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
      <g transform="translate(20 10) rotate(20 100 100)"><g transform="scale(1.5)">
        <rect x="30" y="30" width="40" height="20" fill="tomato"/><path d="M 60 80 L 90 80 L 75 105 z" fill="slateblue"/>
      </g></g></svg>`;
    expect(await importAndCompare(svg, 200, 200)).toBeLessThan(0.02);
  });

  for (const ratio of ['xMidYMid meet', 'xMinYMin meet', 'xMaxYMax meet', 'xMidYMid slice', 'none']) {
    it(`matches the browser for preserveAspectRatio="${ratio}"`, async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 100 100" preserveAspectRatio="${ratio}">
        <rect x="10" y="10" width="80" height="80" fill="teal"/><circle cx="50" cy="50" r="20" fill="white"/></svg>`;
      expect(await importAndCompare(svg, 240, 120)).toBeLessThan(0.02);
    });
  }

  it('keeps hidden elements hidden without moving anything', async () => {
    const engine = createEngine();
    const group = (await engine.importSvg(offscreenSvg)).objects[0] as Group;
    const hidden = group.getObjects().find((object) => object.fill === 'purple');
    expect(hidden?.visible).toBe(false);
  });

  it('drops elements outside the viewport when asked', async () => {
    const engine = createEngine();
    const result = await engine.importSvg(offscreenSvg, { offscreen: 'drop' });
    const fills = (result.objects[0] as Group).getObjects().map((object) => object.fill);
    expect(fills).toEqual(['teal']);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['SVG_OFFSCREEN_DROPPED']);
  });

  it('clips elements to the viewport when asked', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <rect x="50" y="50" width="200" height="200" fill="black"/></svg>`;
    const engine = createEngine(300, 300);
    await engine.importSvg(svg, { offscreen: 'clip' });
    engine.canvas.renderAll();
    const pixels = rasterizeCanvas(engine.canvas);
    const at = (x: number, y: number): number => pixels.data[(y * 300 + x) * 4]!;
    expect(at(75, 75)).toBeLessThan(50);
    expect(at(150, 150)).toBeGreaterThan(200);
  });

  it('places and fits the viewport into a box', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="teal"/></svg>`;
    const engine = createEngine(400, 400);
    const contain = (await engine.importSvg(svg, { left: 20, top: 30, fit: { width: 100, height: 100 } })).objects[0]!;
    const box = contain.getBoundingRect();
    expect([box.left, box.top, box.width, box.height].map(Math.round)).toEqual([20, 55, 100, 50]);
    const cover = (await engine.importSvg(svg, { fit: { width: 100, height: 100, mode: 'cover' } })).objects[0]!.getBoundingRect();
    expect([cover.width, cover.height].map(Math.round)).toEqual([200, 100]);
    const fill = (await engine.importSvg(svg, { fit: { width: 100, height: 100, mode: 'fill' } })).objects[0]!.getBoundingRect();
    expect([fill.width, fill.height].map(Math.round)).toEqual([100, 100]);
  });

  it('can add separate objects in the same places', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 100 100">
      <rect x="10" y="10" width="30" height="20" fill="red"/><rect x="50" y="60" width="20" height="20" fill="blue"/></svg>`;
    const grouped = createEngine();
    const group = (await grouped.importSvg(svg)).objects[0] as Group;
    const expected = group.getObjects().map((object) => object.getBoundingRect());
    const separate = createEngine();
    const result = await separate.importSvg(svg, { as: 'objects' });
    expect(result.objects).toHaveLength(2);
    expect(separate.canvas.getObjects()).toEqual(result.objects);
    result.objects.forEach((object, index) => {
      const box = object.getBoundingRect();
      expect(box.left).toBeCloseTo(expected[index]!.left, 3);
      expect(box.top).toBeCloseTo(expected[index]!.top, 3);
      expect(box.width).toBeCloseTo(expected[index]!.width, 3);
    });
    // x="10" at a scale of 2, less half of the scaled default stroke.
    expect(expected[0]!.left).toBeCloseTo(19, 3);
  });

  it('is one undo step and gives every object an id', async () => {
    const engine = createEngine();
    const result = await engine.importSvg(offscreenSvg);
    expect(engine.getHistory().undo).toEqual(['Import SVG']);
    const group = result.objects[0] as Group;
    const ids = [group, ...group.getObjects()].map((object) => (object as unknown as { id?: string }).id);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    await engine.undo();
    expect(engine.canvas.getObjects()).toEqual([]);
  });

  it('reopens an imported SVG unchanged after saving', async () => {
    const engine = createEngine();
    await engine.importSvg(offscreenSvg);
    const before = (engine.canvas.getObjects()[0] as Group).getObjects().map((object) => object.calcTransformMatrix());
    const reopened = createEngine();
    await reopened.loadDocument(JSON.parse(JSON.stringify(engine.toDocument())));
    const group = reopened.canvas.getObjects()[0] as Group;
    expect(group.width).toBe(200);
    group.getObjects().forEach((object, index) => {
      object.calcTransformMatrix().forEach((value, cell) => expect(value).toBeCloseTo(before[index]![cell]!, 3));
    });
  });

  it('removes scripts, event handlers, embedded pages and links to other files', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100" onload="window.svgImportRan = true">
      <script>window.svgImportRan = true</script>
      <style>@import url("https://example.com/x.css"); rect { fill: url(https://example.com/paint.svg#p) }</style>
      <foreignObject width="50" height="50"><div xmlns="http://www.w3.org/1999/xhtml">hello</div></foreignObject>
      <rect x="10" y="10" width="30" height="30" fill="red" onclick="window.svgImportRan = true"/>
      <use xlink:href="https://example.com/icons.svg#star"/>
      <image href="javascript:alert(1)" width="10" height="10"/>
    </svg>`;
    const engine = createEngine();
    const result = await engine.importSvg(svg);
    expect((window as { svgImportRan?: boolean }).svgImportRan).toBeUndefined();
    expect(result.warnings.map((warning) => warning.code).sort()).toEqual(['SVG_CONTENT_REMOVED', 'SVG_IMAGE_BLOCKED']);
    expect((result.objects[0] as Group).getObjects()).toHaveLength(1);
  });

  it('follows the address rule from limits for images', async () => {
    const engine = createEngine(200, 200, { limits: { isAllowedUrl: (url) => url.startsWith('data:') } });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image href="/__test-assets__/pixel.png" width="10" height="10"/><rect width="5" height="5"/></svg>`;
    const result = await engine.importSvg(svg);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['SVG_IMAGE_BLOCKED']);
  });

  it('loads images inside the SVG', async () => {
    const engine = createEngine();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image href="/__test-assets__/pixel.png" x="10" y="10" width="40" height="40"/></svg>`;
    const group = (await engine.importSvg(svg)).objects[0] as Group;
    expect(group.getObjects()[0]).toBeInstanceOf(fabric.FabricImage);
  });

  it('refuses SVG over the size limits', async () => {
    const engine = createEngine(200, 200, { limits: { maxObjects: 5 } });
    const many = Array.from({ length: 10 }, (_, index) => `<rect x="${index}" width="1" height="1"/>`).join('');
    expect(await codeOf(engine.importSvg(`<svg xmlns="http://www.w3.org/2000/svg">${many}</svg>`))).toBe('UNSAFE_DOCUMENT');
    const deep = `${'<g>'.repeat(120)}<rect width="1" height="1"/>${'</g>'.repeat(120)}`;
    expect(await codeOf(createEngine().importSvg(`<svg xmlns="http://www.w3.org/2000/svg">${deep}</svg>`))).toBe('UNSAFE_DOCUMENT');
    expect(engine.canvas.getObjects()).toEqual([]);
  });

  it('refuses text that is not SVG', async () => {
    const engine = createEngine();
    expect(await codeOf(engine.importSvg(''))).toBe('SVG_IMPORT_FAILED');
    expect(await codeOf(engine.importSvg('<svg><rect></svg>'))).toBe('SVG_IMPORT_FAILED');
    expect(await codeOf(engine.importSvg('<html xmlns="http://www.w3.org/1999/xhtml"></html>'))).toBe('SVG_IMPORT_FAILED');
    expect(engine.getHistory().undo).toEqual([]);
  });

  it('adds nothing for an empty SVG', async () => {
    const engine = createEngine();
    const result = await engine.importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    expect(result.objects).toEqual([]);
    expect(engine.getHistory().undo).toEqual([]);
  });

  it('uses the drawn content as the frame when the SVG has no size', async () => {
    const engine = createEngine();
    const result = await engine.importSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect x="30" y="40" width="50" height="20"/></svg>', {
      left: 5,
      top: 5,
    });
    expect(result.viewport.width).toBeCloseTo(51, 0);
    const box = result.objects[0]!.getBoundingRect();
    expect(Math.round(box.left)).toBe(5);
  });

  it('can be cancelled', async () => {
    const engine = createEngine();
    expect(await codeOf(engine.importSvg(offscreenSvg, { signal: AbortSignal.abort() }))).toBe('LOAD_ABORTED');
    expect(engine.canvas.getObjects()).toEqual([]);
  });
});
