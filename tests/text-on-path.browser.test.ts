import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, FabricText, Gradient, Group, IText, Path, Shadow, StaticCanvas, Textbox } from 'fabric';
import type { FabricObject } from 'fabric';
import { createDocumentEngine } from '../src';
import type { DocumentEngine } from '../src';
import { repairFabricSvg } from '../src/export/render-export';
import { withTextOnPathSVG } from '../src/export/svg/text-on-path';
import { inkDifference, rasterizeCanvas, rasterizeSvg } from './support/pixels';

/**
 * Text on a path in SVG (fabric.js #6958). Every case draws the canvas, then
 * draws the SVG the engine writes, and compares the pixels. The cases where
 * Fabric's own SVG is wrong also check that Fabric's output really differs,
 * so each fix is tied to a reproduced problem.
 */

const WIDTH = 360;
const HEIGHT = 240;
const IS_FABRIC_7 = fabric.version.startsWith('7');
// Canvas and SVG smooth text edges a little differently. Real mistakes, such
// as a baseline 2 pixels off, are far above this.
const MATCHES = 0.02;
const WRONG = 0.05;

const arch = (): Path => new Path('M 30 190 Q 180 -10 330 190', { visible: false });
const wave = (): Path => new Path('M 20 140 C 100 20 180 220 340 90', { visible: false });
const circle = (): Path => new Path('M 100 120 a 80 80 0 1 0 160 0 a 80 80 0 1 0 -160 0', { visible: false });

const openCanvases: StaticCanvas[] = [];
const openEngines: DocumentEngine[] = [];

function sceneWith(...objects: FabricObject[]): StaticCanvas {
  const canvas = new StaticCanvas(undefined, { width: WIDTH, height: HEIGHT, backgroundColor: 'white' });
  openCanvases.push(canvas);
  canvas.add(...objects);
  canvas.renderAll();
  return canvas;
}

function curved(text: string, options: Record<string, unknown> = {}): FabricText {
  return new FabricText(text, {
    path: arch(),
    left: WIDTH / 2,
    top: HEIGHT / 2,
    originX: 'center',
    originY: 'center',
    fontSize: 26,
    fontFamily: 'sans-serif',
    fill: '#1b2a4a',
    ...options,
  } as never);
}

function engineSvg(canvas: StaticCanvas): string {
  return repairFabricSvg(withTextOnPathSVG(canvas, () => canvas.toSVG()).result);
}

function fabricSvg(canvas: StaticCanvas): string {
  // Only the missing space Fabric leaves after `rotate`, so its file can be read at all.
  return repairFabricSvg(canvas.toSVG());
}

async function compare(canvas: StaticCanvas): Promise<{ engine: number; fabric: number }> {
  const reference = rasterizeCanvas(canvas);
  const [ours, theirs] = await Promise.all([
    rasterizeSvg(engineSvg(canvas), WIDTH, HEIGHT),
    rasterizeSvg(fabricSvg(canvas), WIDTH, HEIGHT),
  ]);
  return { engine: inkDifference(reference, ours), fabric: inkDifference(reference, theirs) };
}

function parseError(svg: string): string | undefined {
  return new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')?.textContent ?? undefined;
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`text on a path in SVG on Fabric ${fabric.version}`, () => {
  it('notices a drawing that is two pixels off, so the comparison can be trusted', async () => {
    const canvas = sceneWith(curved('Shifted text'));
    const reference = rasterizeCanvas(canvas);
    const shifted = engineSvg(canvas).replace('<g transform="matrix(1 0 0 1 180 120)', '<g transform="matrix(1 0 0 1 182 122)');
    expect(shifted).not.toBe(engineSvg(canvas));
    expect(inkDifference(reference, await rasterizeSvg(shifted, WIDTH, HEIGHT))).toBeGreaterThan(WRONG);
  });

  it('writes valid XML where Fabric does not', () => {
    const canvas = sceneWith(curved('Text with spaces'));
    expect(parseError(canvas.toSVG())).toBeDefined();
    expect(parseError(engineSvg(canvas))).toBeUndefined();
    expect(parseError(fabricSvg(canvas))).toBeUndefined();
  });

  const cases: Array<[string, () => FabricObject[], { fabricIsWrong?: boolean }?]> = [
    ['text along a curve', () => [curved('Along the curve')]],
    ['text along a cubic wave', () => [curved('Riding a wave of text', { path: wave() })]],
    ['text centred on the path', () => [curved('Centred', { textAlign: 'center' })]],
    ['text at the end of the path', () => [curved('At the end', { textAlign: 'right' })]],
    ['text on the other side of the path', () => [curved('Other side', { pathSide: 'right' })]],
    ['pathAlign center', () => [curved('Centre aligned', { pathAlign: 'center' })], { fabricIsWrong: true }],
    ['pathAlign ascender', () => [curved('Ascender aligned', { pathAlign: 'ascender' })], { fabricIsWrong: true }],
    ['pathAlign descender', () => [curved('Descender aligned', { pathAlign: 'descender' })], { fabricIsWrong: true }],
    ['a start offset', () => [curved('Offset start', { pathStartOffset: 60 })]],
    ['a negative start offset that wraps', () => [curved('Wrapped', { pathStartOffset: -60 })]],
    ['a closed path with an offset past its end', () => [curved('Round and round we go', { path: circle(), pathStartOffset: 600 })]],
    ['wide letter spacing', () => [curved('Spaced', { charSpacing: 300 })]],
    [
      'styles on single letters',
      () => [
        curved('Mixed styles', {
          styles: {
            0: {
              0: { fill: 'crimson', fontSize: 36 },
              3: { fontWeight: 'bold' },
              5: { fontStyle: 'italic' },
              7: { stroke: 'navy', strokeWidth: 1 },
            },
          },
        }),
      ],
    ],
    ['raised and lowered letters', () => [curved('Up and down', { styles: { 0: { 0: { deltaY: -8 }, 3: { deltaY: 6 } } } })], { fabricIsWrong: true }],
    ['a text background', () => [curved('Highlighted', { textBackgroundColor: '#ffe066' })], { fabricIsWrong: true }],
    ['backgrounds on some letters', () => [curved('Some marked', { styles: { 0: { 0: { textBackgroundColor: '#9ee' }, 1: { textBackgroundColor: '#9ee' } } } })], { fabricIsWrong: true }],
    // Fabric's CSS underline on rotated letters comes close in Chromium, less so elsewhere.
    ['underline', () => [curved('Underlined', { underline: true })]],
    ['overline and line-through', () => [curved('Both lines', { overline: true, linethrough: true })]],
    ['thick decorations', () => [curved('Thick lines', { underline: true, textDecorationThickness: 160 })]],
    ['an outline drawn under the fill', () => [curved('Outlined', { stroke: 'orange', strokeWidth: 4, paintFirst: 'stroke', fontSize: 34 })]],
    ['an outline drawn over the fill', () => [curved('Outlined', { stroke: 'orange', strokeWidth: 2, fontSize: 34 })]],
    [
      'the guide path drawn under the text',
      () => [curved('On a visible path', { path: new Path('M 30 190 Q 180 -10 330 190', { fill: '', stroke: '#888', strokeWidth: 2 }) })],
      { fabricIsWrong: true },
    ],
    ['a rotated, scaled and flipped text', () => [curved('Transformed', { angle: 18, scaleX: 1.2, scaleY: 0.9, flipX: true })]],
    ['a skewed text', () => [curved('Skewed', { skewX: 12 })]],
    ['half transparent text', () => [curved('See through', { opacity: 0.5 })]],
    ['right-to-left text', () => [curved('right to left', { direction: 'rtl' })]],
    ['two lines on one path', () => [curved('Line one\nLine two')]],
    ['editable text', () => [new IText('Editable', { path: arch(), left: 180, top: 120, originX: 'center', originY: 'center', fontSize: 26, fontFamily: 'sans-serif' } as never)]],
    ['a text box', () => [new Textbox('A text box on a path', { path: arch(), width: 300, left: 180, top: 120, originX: 'center', originY: 'center', fontSize: 22, fontFamily: 'sans-serif' } as never)]],
    // Without caching: a cached group clips text on a path on the canvas, see below.
    [
      'text inside a rotated group',
      () => [new Group([curved('In a group')], { objectCaching: false, angle: -15, scaleX: 0.9, left: 180, top: 120, originX: 'center', originY: 'center' })],
    ],
    ['a gradient fill', () => [curved('Gradient', { fontSize: 40, fill: new Gradient({ type: 'linear', coords: { x1: 0, y1: 0, x2: 300, y2: 0 }, colorStops: [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }] }) })]],
  ];

  for (const [name, build, expectations] of cases) {
    it(`matches the canvas for ${name}`, async () => {
      const result = await compare(sceneWith(...build()));
      expect(result.engine, `engine SVG differs from the canvas by ${(result.engine * 100).toFixed(1)}%`).toBeLessThan(MATCHES);
      if (expectations?.fabricIsWrong) {
        expect(result.fabric, `Fabric's SVG differs by ${(result.fabric * 100).toFixed(1)}%`).toBeGreaterThan(WRONG);
      }
    });
  }

  it.runIf(IS_FABRIC_7)('matches the canvas for a decoration colour', async () => {
    const result = await compare(sceneWith(curved('Coloured line', { underline: true, styles: { 0: { 0: { textDecorationColor: 'red' }, 1: { textDecorationColor: 'red' } } } })));
    expect(result.engine).toBeLessThan(MATCHES);
  });

  it('shows all of a text on a path that the canvas clips in a cached group', async () => {
    // Fabric sizes a group's cache to the path's box, so letters that rise
    // above the curve are cut off on the canvas. The SVG shows them.
    const cached = sceneWith(new Group([curved('In a group')], { angle: -15, left: 180, top: 120, originX: 'center', originY: 'center' }));
    const uncached = sceneWith(new Group([curved('In a group')], { objectCaching: false, angle: -15, left: 180, top: 120, originX: 'center', originY: 'center' }));
    const svg = await rasterizeSvg(engineSvg(cached), WIDTH, HEIGHT);
    expect(inkDifference(rasterizeCanvas(cached), svg)).toBeGreaterThan(MATCHES);
    expect(inkDifference(rasterizeCanvas(uncached), svg)).toBeLessThan(MATCHES);
  });

  it('writes one text element per visible character, emoji included', () => {
    const svg = engineSvg(sceneWith(curved('😀👍🏽 ok')));
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect([...document.querySelectorAll('text')].map((text) => text.textContent)).toEqual(['😀', '👍🏽', 'o', 'k']);
  });

  it('escapes text and drops style values that could break the file', () => {
    const svg = engineSvg(sceneWith(curved('<a & "b">', { fontFamily: 'Evil"; fill: red' })));
    expect(parseError(svg)).toBeUndefined();
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect([...document.querySelectorAll('text')].map((text) => text.textContent).join('')).toBe('<a&"b">');
    expect(svg).not.toContain('Evil');
  });

  it('keeps a hidden text hidden and a shadow on the text', () => {
    const hidden = engineSvg(sceneWith(curved('Hidden', { visible: false })));
    expect(hidden).toContain('visibility: hidden');
    const shadowed = engineSvg(sceneWith(curved('Shadow', { shadow: new Shadow({ color: 'black', blur: 4, offsetX: 2, offsetY: 2 }) })));
    expect(shadowed).toMatch(/filter: url\(#SVGID_/);
    expect(shadowed).toContain('<filter');
  });

  it('places text whose path was assigned without set', () => {
    const text = new FabricText('Assigned', { fontSize: 26, fontFamily: 'sans-serif' } as never);
    (text as unknown as { path: Path }).path = arch();
    const svg = engineSvg(sceneWith(text));
    expect(parseError(svg)).toBeUndefined();
    expect(svg).not.toContain('NaN');
    expect(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text[transform]')).toHaveLength(8);
  });

  it('leaves other objects exactly as Fabric writes them', () => {
    const canvas = sceneWith(new FabricText('Plain text', { left: 20, top: 20 }), new Textbox('A box', { left: 20, top: 80, width: 100 }));
    expect(engineSvg(canvas)).toBe(canvas.toSVG());
  });

  it("puts back an app's own toSVG after exporting", () => {
    const text = curved('Custom');
    const custom = (): string => '<g id="custom"></g>';
    (text as unknown as { toSVG: () => string }).toSVG = custom;
    const canvas = sceneWith(text);
    engineSvg(canvas);
    expect((text as unknown as { toSVG: () => string }).toSVG).toBe(custom);
    const plain = curved('Plain');
    sceneWith(plain);
    engineSvg(sceneWith(plain));
    expect(Object.prototype.hasOwnProperty.call(plain, 'toSVG')).toBe(false);
  });
});

describe(`SVG export of text on a path through the engine on Fabric ${fabric.version}`, () => {
  function createEngine(): DocumentEngine {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element, { width: WIDTH, height: HEIGHT, backgroundColor: 'white' });
    openCanvases.push(canvas);
    const engine = createDocumentEngine({ canvas });
    openEngines.push(engine);
    return engine;
  }

  it('matches the canvas by default', async () => {
    const engine = createEngine();
    engine.canvas.add(curved('Exported along a path', { pathAlign: 'center', textBackgroundColor: '#eef' }));
    engine.canvas.renderAll();
    const result = await engine.export({ format: 'svg' });
    const svg = await result.blob.text();
    expect(parseError(svg)).toBeUndefined();
    const difference = inkDifference(rasterizeCanvas(engine.canvas), await rasterizeSvg(svg, WIDTH, HEIGHT));
    expect(difference).toBeLessThan(MATCHES);
    expect(result.warnings).toEqual([]);
  });

  it("keeps Fabric's output when asked, repaired and with a warning", async () => {
    const engine = createEngine();
    engine.canvas.add(curved('Fabric output with spaces'));
    const check = await engine.preflightExport({ format: 'svg', svg: { textOnPath: 'fabric' } });
    expect(check.warnings.map((warning) => warning.code)).toEqual(['TEXT_ON_PATH_APPROXIMATED']);
    const result = await engine.export({ format: 'svg', svg: { textOnPath: 'fabric' } });
    expect(parseError(await result.blob.text())).toBeUndefined();
    expect(result.warnings.map((warning) => warning.code)).toEqual(['TEXT_ON_PATH_APPROXIMATED']);
  });

  it('refuses unknown SVG options', async () => {
    const engine = createEngine();
    const error = await engine.export({ format: 'svg', svg: { textOnPath: 'curvy' as never } }).catch((reason: unknown) => reason);
    expect((error as { code?: string }).code).toBe('INVALID_EXPORT_OPTIONS');
  });
});
