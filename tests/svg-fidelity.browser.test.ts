import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Circle, FabricText, Group, Rect, StaticCanvas, Textbox } from 'fabric';
import type { FabricObject } from 'fabric';
import { createDocumentEngine } from '../src';
import type { DocumentEngine } from '../src';
import { renderSvg } from '../src/export/render-export';
import { exportPdf } from '../src/pdf';
import { inkDifference, rasterizeCanvas, rasterizeSvg } from './support/pixels';

/**
 * SVG export of clip paths (fabric.js #10460) and of decorations on ordinary
 * text (fabric.js #10645). Every case compares the engine's SVG with the
 * canvas pixel by pixel; the cases Fabric gets wrong also check Fabric's own
 * output, so each fix is tied to a reproduced problem.
 */

const WIDTH = 320;
const HEIGHT = 200;
const MATCHES = 0.02;
const IS_FABRIC_7 = fabric.version.startsWith('7');

const openCanvases: StaticCanvas[] = [];
const openEngines: DocumentEngine[] = [];

function scene(...objects: FabricObject[]): StaticCanvas {
  const canvas = new StaticCanvas(undefined, { width: WIDTH, height: HEIGHT, backgroundColor: 'white' });
  openCanvases.push(canvas);
  canvas.add(...objects);
  canvas.renderAll();
  return canvas;
}

function clipped(clipPath: FabricObject, target: FabricObject = new Rect({ left: 40, top: 20, width: 200, height: 150, fill: 'teal' })): FabricObject {
  target.clipPath = clipPath;
  return target;
}

const circle = (options: Record<string, unknown> = {}): Circle => new Circle({ radius: 55, originX: 'center', originY: 'center', ...options });
const group = (): Group =>
  new Group([new Rect({ width: 120, height: 80, fill: 'orange' }), new Circle({ left: 80, top: 40, radius: 40, fill: 'purple' })], { left: 60, top: 30 });
const text = (options: Record<string, unknown> = {}): FabricText =>
  new FabricText('Decorated text', { left: 20, top: 40, originX: 'left', originY: 'top', fontSize: 30, fontFamily: 'sans-serif', fill: '#123', ...options });

function nestedClip(): FabricObject {
  const outer = circle({ radius: 60 });
  outer.clipPath = new Rect({ width: 80, height: 80, originX: 'center', originY: 'center', angle: 30 });
  return clipped(outer);
}

async function engineDifference(canvas: StaticCanvas): Promise<number> {
  const { svg } = renderSvg(canvas, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, 1);
  return inkDifference(rasterizeCanvas(canvas), await rasterizeSvg(svg, WIDTH, HEIGHT));
}

async function fabricDifference(canvas: StaticCanvas): Promise<number> {
  return inkDifference(rasterizeCanvas(canvas), await rasterizeSvg(canvas.toSVG(), WIDTH, HEIGHT));
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`SVG clip paths on Fabric ${fabric.version}`, () => {
  const cases: Array<[string, () => FabricObject[], boolean?]> = [
    ['a plain clip path', () => [clipped(circle())]],
    ['an absolutely positioned clip path', () => [clipped(new Circle({ radius: 50, left: 100, top: 60, absolutePositioned: true }))]],
    ['a clip path on a group', () => [clipped(circle(), group())]],
    ['an inverted clip path', () => [clipped(circle({ inverted: true }))], true],
    ['an inverted clip path on a group', () => [clipped(circle({ radius: 40, inverted: true }), group())], true],
    ['an inverted clip path on an object in a group', () => [new Group([clipped(circle({ inverted: true })), new Rect({ left: 260, top: 10, width: 30, height: 30, fill: 'red' })])], true],
  ];
  for (const [name, build, fabricIsWrong] of cases) {
    it(`matches the canvas for ${name}`, async () => {
      const canvas = scene(...build());
      expect(await engineDifference(canvas)).toBeLessThan(MATCHES);
      if (fabricIsWrong) expect(await fabricDifference(canvas)).toBeGreaterThan(0.3);
    });
  }

  it('reproduces the problem: Fabric cannot write a clip path that has its own clip path', () => {
    const canvas = scene(nestedClip());
    if (IS_FABRIC_7) expect(() => canvas.toSVG()).toThrow();
    else expect(canvas.toSVG()).toContain('url(#undefined)');
  });

  it('draws an object with a nested clip path as a picture that matches the canvas', async () => {
    const canvas = scene(nestedClip(), new Rect({ left: 260, top: 10, width: 30, height: 30, fill: 'red' }));
    const { svg, rasterizedObjectIds } = renderSvg(canvas, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, 1);
    expect(svg).not.toContain('url(#undefined)');
    expect(svg.match(/<image /g)).toHaveLength(1);
    expect(rasterizedObjectIds).toHaveLength(0); // objects on a bare canvas have no ids
    expect(await engineDifference(canvas)).toBeLessThan(MATCHES);
  });

  it('warns through the engine when it draws an object as a picture', async () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element, { width: WIDTH, height: HEIGHT });
    openCanvases.push(canvas);
    const engine = createDocumentEngine({ canvas });
    openEngines.push(engine);
    const object = nestedClip();
    canvas.add(object);
    const result = await engine.export({ format: 'svg' });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'CLIP_PATH_RASTERIZED', objectIds: [(object as unknown as { id: string }).id] }),
    ]);
  });

  it('draws masked objects as pictures in a hybrid PDF', async () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element, { width: WIDTH, height: HEIGHT });
    openCanvases.push(canvas);
    const engine = createDocumentEngine({ canvas });
    openEngines.push(engine);
    canvas.add(clipped(circle({ inverted: true })), nestedClip());
    const { warnings } = await exportPdf(engine);
    expect(warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining('clip path'),
      expect.stringContaining('clip path'),
    ]);
  });
});

describe(`SVG decorations on ordinary text on Fabric ${fabric.version}`, () => {
  const cases: Array<[string, () => FabricObject[]]> = [
    ['an underline', () => [text({ underline: true })]],
    ['an overline', () => [text({ overline: true })]],
    ['a line-through', () => [text({ linethrough: true })]],
    ['all three lines', () => [text({ underline: true, overline: true, linethrough: true })]],
    ['thick lines', () => [text({ underline: true, textDecorationThickness: 200 })]],
    [
      'mixed letter styles with raised letters',
      () => [text({ styles: { 0: { 0: { fill: 'red', fontSize: 40 }, 3: { fontWeight: 'bold', underline: true }, 8: { linethrough: true, fill: 'blue' }, 10: { deltaY: -8 } } } })],
    ],
    ['raised letters without lines', () => [text({ styles: { 0: { 2: { deltaY: -10 }, 6: { deltaY: 8 } } } })]],
    ['a wrapped text box', () => [new Textbox('A text box with underline that wraps', { left: 20, top: 20, width: 200, fontSize: 22, underline: true, fontFamily: 'sans-serif' })]],
    ['right-to-left text', () => [text({ direction: 'rtl', underline: true, textAlign: 'right' })]],
    ['wide letter spacing', () => [text({ charSpacing: 300, overline: true })]],
    ['text backgrounds', () => [text({ textBackgroundColor: 'yellow', styles: { 0: { 2: { textBackgroundColor: 'cyan' } } } })]],
  ];
  for (const [name, build] of cases) {
    it(`matches the canvas for ${name}`, async () => {
      expect(await engineDifference(scene(...build()))).toBeLessThan(MATCHES);
    });
  }

  // CSS decorations are placed by each SVG reader its own way; Chromium's
  // placement differs from the canvas, while the engine's shapes do not.
  it.runIf(navigator.userAgent.includes('Chrome'))("reproduces the problem: Fabric's CSS overline lands away from the canvas", async () => {
    expect(await fabricDifference(scene(text({ overline: true })))).toBeGreaterThan(0.05);
  });

  it("keeps Fabric's CSS decorations when asked", () => {
    const canvas = scene(text({ underline: true }));
    const css = renderSvg(canvas, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, 1, { textDecorations: 'css' }).svg;
    const shapes = renderSvg(canvas, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, 1).svg;
    expect(css).toContain('text-decoration');
    expect(shapes).not.toContain('text-decoration=');
  });
});
