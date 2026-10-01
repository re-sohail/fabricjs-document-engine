import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Circle, FabricText, Path, Rect, Shadow, StaticCanvas } from 'fabric';
import { createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, FabricDocument } from '../src';
import { PAGE_SIZES, exportPdf } from '../src/pdf';
import type { PdfExportOptions, PdfFont } from '../src/pdf';
import { inkDifference, rasterizeCanvas } from './support/pixels';
import { rasterizePdfPage, readPdf } from './support/pdf';

/**
 * PDF export (fabric.js #5906). Every page is drawn back to pixels with
 * pdf.js and compared with the canvas, and pdf.js also reports which text
 * is real text in the file.
 */

const WIDTH = 320;
const HEIGHT = 200;
// PDF text is smoothed differently from canvas text.
const MATCHES = 0.04;

let roboto: ArrayBuffer;
let face: FontFace;
const robotoFont = (): PdfFont => ({ family: 'Roboto', source: roboto });

const openCanvases: StaticCanvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(width = WIDTH, height = HEIGHT): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width, height, backgroundColor: 'white' });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas });
  openEngines.push(engine);
  return engine;
}

function text(value: string, options: Record<string, unknown> = {}): FabricText {
  // Fabric 7 places objects by their centre unless told otherwise.
  return new FabricText(value, { left: 20, top: 30, originX: 'left', originY: 'top', fontSize: 30, fontFamily: 'Roboto', fill: '#123456', ...options });
}

async function pageDifference(engine: DocumentEngine, options: PdfExportOptions = {}): Promise<{ difference: number; text: string; warnings: string[] }> {
  engine.canvas.renderAll();
  const reference = rasterizeCanvas(engine.canvas);
  const result = await exportPdf(engine, { fonts: [robotoFont()], ...options });
  const pdf = await readPdf(result.blob);
  const drawn = await rasterizePdfPage(result.blob, 1, engine.canvas.getWidth(), engine.canvas.getHeight());
  return { difference: inkDifference(reference, drawn), text: pdf.pages[0]!.text, warnings: result.warnings.map((warning) => warning.code) };
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => (isDocumentEngineError(error) ? error.code : error),
  );
}

beforeAll(async () => {
  roboto = await (await fetch('/__test-assets__/roboto.ttf')).arrayBuffer();
  face = new FontFace('Roboto', roboto);
  document.fonts.add(await face.load());
});

afterAll(() => {
  document.fonts.delete(face);
});

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`PDF export on Fabric ${fabric.version}`, () => {
  it('draws shapes and real, selectable text that match the canvas', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ left: 180, top: 30, width: 100, height: 60, fill: 'teal', stroke: 'black', strokeWidth: 2 }), text('Hello PDF'));
    const { difference, text: found, warnings } = await pageDifference(engine, { mode: 'vector' });
    expect(difference).toBeLessThan(MATCHES);
    expect(found).toContain('Hello PDF');
    expect(warnings).toEqual([]);
  });

  it('draws text on a path as real text in its place', async () => {
    const engine = createEngine();
    engine.canvas.add(text('Curved in a PDF', { path: new Path('M 20 170 Q 160 -20 300 170', { visible: false }), left: 160, top: 100, originX: 'center', originY: 'center', pathAlign: 'center' }));
    const { difference, text: found } = await pageDifference(engine);
    expect(difference).toBeLessThan(MATCHES);
    expect(found.replace(/\s/g, '')).toContain('CurvedinaPDF');
  });

  it('draws underlines and line-throughs, which svg2pdf would drop', async () => {
    const engine = createEngine();
    engine.canvas.add(text('Underlined', { underline: true }), text('Struck', { top: 100, linethrough: true, fill: 'crimson' }));
    const { difference, text: found } = await pageDifference(engine);
    expect(difference).toBeLessThan(MATCHES);
    expect(found).toContain('Underlined');
  });

  it('draws shadows and blend modes as pictures in hybrid mode, and keeps other text as text', async () => {
    const engine = createEngine();
    engine.canvas.add(
      new Rect({ left: 20, top: 20, width: 100, height: 60, fill: 'orange', shadow: new Shadow({ color: 'rgba(0,0,0,0.6)', blur: 8, offsetX: 5, offsetY: 5 }) }),
      new Rect({ left: 150, top: 20, width: 80, height: 80, fill: 'yellow' }),
      new Circle({ left: 190, top: 50, radius: 40, fill: 'cyan', globalCompositeOperation: 'multiply' }),
      text('Still text', { top: 140 }),
    );
    const { difference, text: found, warnings } = await pageDifference(engine);
    expect(difference).toBeLessThan(MATCHES);
    expect(warnings).toEqual(['PDF_RASTERIZED', 'PDF_RASTERIZED']);
    expect(found).toContain('Still text');
  });

  it('warns about what vector mode cannot draw', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ left: 20, top: 20, width: 100, height: 60, fill: 'orange', shadow: new Shadow({ blur: 8 }) }));
    const result = await exportPdf(engine, { mode: 'vector' });
    expect(result.warnings.map((warning) => warning.code)).toEqual(['PDF_UNSUPPORTED']);
  });

  it('draws the whole page as one picture in raster mode', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ left: 20, top: 20, width: 100, height: 60, fill: 'navy' }), text('Pixels', { top: 120 }));
    const { difference, text: found } = await pageDifference(engine, { mode: 'raster', dpi: 150 });
    expect(difference).toBeLessThan(MATCHES);
    expect(found).toBe('');
  });

  it('draws text in a font with no file as a picture, or substitutes a built-in font when asked', async () => {
    const engine = createEngine();
    engine.canvas.add(text('Unknown font', { fontFamily: 'No Such Font Family' }));
    const hybrid = await exportPdf(engine);
    expect(hybrid.warnings.map((warning) => warning.message)).toEqual([expect.stringContaining('font has no TrueType file')]);
    expect((await readPdf(hybrid.blob)).pages[0]!.text).toBe('');
    const substituted = await exportPdf(engine, { missingFonts: 'substitute' });
    expect(substituted.warnings).toEqual([]);
    expect((await readPdf(substituted.blob)).pages[0]!.text).toContain('Unknown font');
  });

  it('keeps standard fonts as text without a file', async () => {
    const engine = createEngine();
    engine.canvas.add(text('Arial text', { fontFamily: 'Arial' }), text('Times text', { fontFamily: 'Times New Roman', top: 100 }));
    const result = await exportPdf(engine);
    expect(result.warnings).toEqual([]);
    expect((await readPdf(result.blob)).pages[0]!.text).toContain('Arial text');
  });

  it('draws letters the built-in fonts lack as a picture', async () => {
    const engine = createEngine();
    engine.canvas.add(text('你好', { fontFamily: 'sans-serif' }));
    const result = await exportPdf(engine);
    expect(result.warnings.map((warning) => warning.message)).toEqual([expect.stringContaining('characters the built-in PDF fonts do not have')]);
  });

  it('keeps bold text in its family when only a regular file is given', async () => {
    const engine = createEngine();
    engine.canvas.add(text('Bold Roboto', { fontWeight: 'bold' }), text('Medium', { fontWeight: 500, top: 100 }));
    const result = await exportPdf(engine, { fonts: [robotoFont()] });
    // Weight 500 rounds to normal, which has a file; bold has none.
    expect(result.warnings.map((warning) => [warning.code, warning.family])).toEqual([['PDF_FONT_SUBSTITUTED', 'Roboto']]);
    expect(result.warnings[0]!.message).toContain('bold');
    const found = (await readPdf(result.blob)).pages[0]!.text;
    expect(found).toContain('Bold Roboto');
    expect(found).toContain('Medium');
  });

  it('refuses font files jsPDF cannot use, and says what to use instead', async () => {
    const engine = createEngine();
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
    const error = await exportPdf(engine, { fonts: [{ family: 'Roboto', source: woff2 }] }).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('PDF_FAILED');
    expect((error as Error).message).toContain('TrueType (.ttf)');
  });

  it('uses named page sizes, turns pages to fit the drawing, and takes custom sizes', async () => {
    const wide = createEngine(400, 200);
    const tall = createEngine(200, 400);
    const sizesOf = async (source: DocumentEngine, options: PdfExportOptions): Promise<number[]> => {
      const { pages } = await readPdf((await exportPdf(source, options)).blob);
      return [pages[0]!.width, pages[0]!.height].map((value) => Math.round(value));
    };
    expect(await sizesOf(tall, { page: 'A4' })).toEqual(PAGE_SIZES.A4.map(Math.round));
    expect(await sizesOf(wide, { page: 'A4' })).toEqual([...PAGE_SIZES.A4].reverse().map(Math.round));
    expect(await sizesOf(wide, { page: 'Letter', orientation: 'portrait' })).toEqual([612, 792]);
    expect(await sizesOf(wide, { page: [300, 300] })).toEqual([300, 300]);
    expect(await sizesOf(wide, { page: 'canvas', margin: 10 })).toEqual([320, 170]);
  });

  it('places the drawing inside the margins', async () => {
    const engine = createEngine(200, 200);
    (engine.canvas as Canvas).backgroundColor = 'black';
    const result = await exportPdf(engine, { page: [200, 300], margin: 50, mode: 'raster' });
    const pixels = await rasterizePdfPage(result.blob, 1, 200, 300);
    const at = (x: number, y: number): number => pixels.data[(y * 200 + x) * 4]!;
    // A 100 x 100 drawing centred in the 100 x 200 box: black from y 100 to 200.
    expect(at(100, 150)).toBeLessThan(30);
    expect(at(100, 70)).toBeGreaterThan(220);
    expect(at(20, 150)).toBeGreaterThan(220);
  });

  it('clips a covering drawing to the box', async () => {
    const engine = createEngine(200, 100);
    (engine.canvas as Canvas).backgroundColor = 'black';
    const result = await exportPdf(engine, { page: [200, 200], margin: 20, fit: 'cover', mode: 'raster' });
    const pixels = await rasterizePdfPage(result.blob, 1, 200, 200);
    const at = (x: number, y: number): number => pixels.data[(y * 200 + x) * 4]!;
    expect(at(100, 100)).toBeLessThan(30);
    expect(at(10, 100)).toBeGreaterThan(220);
  });

  it('makes one page per source: engines, canvases and saved documents', async () => {
    const engine = createEngine(300, 200);
    engine.canvas.add(text('From an engine'));
    const canvas = new StaticCanvas(undefined, { width: 200, height: 300, backgroundColor: 'white' });
    openCanvases.push(canvas);
    canvas.add(text('From a canvas', { fontSize: 20 }));
    const saved: FabricDocument = {
      schemaVersion: 1,
      id: 'saved',
      createdAt: '',
      updatedAt: '',
      canvas: { width: 400, height: 100 },
      objects: [{ type: 'Text', text: 'From a document', fontFamily: 'Roboto', fontSize: 20, left: 10, top: 10, originX: 'left', originY: 'top' }],
      metadata: {},
    };
    const result = await exportPdf([engine, canvas, saved], { fonts: [robotoFont()] });
    expect(result.pageCount).toBe(3);
    const { pages } = await readPdf(result.blob);
    expect(pages.map((page) => [Math.round(page.width), Math.round(page.height)])).toEqual([
      [225, 150],
      [150, 225],
      [300, 75],
    ]);
    expect(pages.map((page) => page.text)).toEqual(['From an engine', 'From a canvas', 'From a document']);
  });

  it('ignores the zoom and pan of the editor', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ left: 20, top: 20, width: 100, height: 60, fill: 'teal' }));
    engine.canvas.renderAll();
    const reference = rasterizeCanvas(engine.canvas);
    engine.canvas.setViewportTransform([2, 0, 0, 2, -50, -30]);
    const result = await exportPdf(engine, { mode: 'vector' });
    expect(inkDifference(reference, await rasterizePdfPage(result.blob, 1, WIDTH, HEIGHT))).toBeLessThan(MATCHES);
    expect(engine.canvas.viewportTransform).toEqual([2, 0, 0, 2, -50, -30]);
  });

  it('writes the title and author', async () => {
    const engine = createEngine();
    const result = await exportPdf(engine, { metadata: { title: 'Poster', author: 'Ada' } });
    const { info } = await readPdf(result.blob);
    expect(info).toMatchObject({ Title: 'Poster', Author: 'Ada', Creator: 'fabricjs-document-engine' });
  });

  it('leaves the background out when asked', async () => {
    const engine = createEngine(100, 100);
    (engine.canvas as Canvas).backgroundColor = 'red';
    const result = await exportPdf(engine, { background: 'transparent', mode: 'vector' });
    const pixels = await rasterizePdfPage(result.blob, 1, 100, 100);
    expect([...pixels.data.slice(0, 3)]).toEqual([255, 255, 255]);
  });

  it('can be cancelled, and refuses bad options', async () => {
    const engine = createEngine();
    expect(await codeOf(exportPdf(engine, { signal: AbortSignal.abort() }))).toBe('EXPORT_ABORTED');
    expect(await codeOf(exportPdf(engine, { dpi: 0 }))).toBe('INVALID_EXPORT_OPTIONS');
    expect(await codeOf(exportPdf(engine, { mode: 'print' as never }))).toBe('INVALID_EXPORT_OPTIONS');
    expect(await codeOf(exportPdf([]))).toBe('INVALID_EXPORT_OPTIONS');
  });

  it('frees the canvas it uses for saved documents', async () => {
    const saved: FabricDocument = {
      schemaVersion: 1,
      id: 'saved',
      createdAt: '',
      updatedAt: '',
      canvas: { width: 100, height: 100 },
      objects: [{ type: 'Rect', width: 50, height: 50, fill: 'teal' }],
      metadata: {},
    };
    const created: HTMLCanvasElement[] = [];
    const original = document.createElement.bind(document);
    document.createElement = ((name: string, options?: ElementCreationOptions) => {
      const element = original(name, options);
      if (name === 'canvas') created.push(element as HTMLCanvasElement);
      return element;
    }) as typeof document.createElement;
    try {
      await exportPdf([saved, saved, saved], { mode: 'raster' });
    } finally {
      document.createElement = original;
    }
    expect(created.filter((canvas) => canvas.width * canvas.height > 0).length).toBeLessThanOrEqual(2);
  });
});
