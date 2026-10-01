import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, FabricImage, FabricText, Group, Pattern, Rect } from 'fabric';
import { createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, DocumentEngineOptions, ExportOptions } from '../src';
import { inkDifference, rasterizeCanvas, rasterizeSvg } from './support/pixels';

/**
 * Self-contained SVG exports (fabric.js #1980). An SVG shown as an <img> may
 * not fetch anything, like a file opened in another program, so it shows
 * what a recipient sees.
 */

const WIDTH = 200;
const HEIGHT = 120;
const route = (name: string): string => `/__test-assets__/${name}`;

function otherSite(name: string): string {
  const host = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  return `${location.protocol}//${host}:${location.port}${route(name)}`;
}

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(options: Omit<DocumentEngineOptions, 'canvas'> = {}): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: WIDTH, height: HEIGHT, backgroundColor: 'white' });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas, ...options });
  openEngines.push(engine);
  return engine;
}

/** A red picture as a blob: URL, which only exists in this tab. */
async function redPicture(): Promise<string> {
  const picture = document.createElement('canvas');
  picture.width = 10;
  picture.height = 10;
  const context = picture.getContext('2d')!;
  context.fillStyle = 'red';
  context.fillRect(0, 0, 10, 10);
  const blob = await new Promise<Blob>((resolve) => picture.toBlob((value) => resolve(value!), 'image/png'));
  return URL.createObjectURL(blob);
}

async function addImage(engine: DocumentEngine, url: string, options: Record<string, unknown> = {}): Promise<FabricImage> {
  const image = await FabricImage.fromURL(url, options.crossOrigin === undefined ? {} : { crossOrigin: options.crossOrigin as 'anonymous' });
  image.set({ left: 20, top: 20, scaleX: 60 / image.width, scaleY: 60 / image.height, ...options });
  engine.canvas.add(image);
  engine.canvas.renderAll();
  return image;
}

async function exportSvg(engine: DocumentEngine, svg: ExportOptions['svg']): Promise<{ text: string; warnings: string[] }> {
  const result = await engine.export({ format: 'svg', svg });
  return { text: await result.blob.text(), warnings: result.warnings.map((warning) => warning.code) };
}

function externalLinks(svg: string): string[] {
  return [...svg.matchAll(/\s(?:xlink:href|href)="([^"]*)"/g)].map((match) => match[1]!).filter((url) => !url.startsWith('data:') && !url.startsWith('#'));
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`self-contained SVG export on Fabric ${fabric.version}`, () => {
  it('shows a linked image as missing outside the page, and an embedded one as on the canvas', async () => {
    const engine = createEngine();
    await addImage(engine, await redPicture());
    const reference = rasterizeCanvas(engine.canvas);

    const linked = await exportSvg(engine, {});
    expect(externalLinks(linked.text)).toHaveLength(1);
    expect(inkDifference(reference, await rasterizeSvg(linked.text, WIDTH, HEIGHT))).toBeGreaterThan(0.5);

    const embedded = await exportSvg(engine, { embedImages: true });
    expect(externalLinks(embedded.text)).toEqual([]);
    expect(embedded.text).toContain('data:image/png;base64,');
    expect(inkDifference(reference, await rasterizeSvg(embedded.text, WIDTH, HEIGHT))).toBeLessThan(0.02);
    expect(embedded.warnings).toEqual([]);
  });

  it('embeds same-site images and images from sites that allow CORS', async () => {
    const engine = createEngine();
    await addImage(engine, route('pixel.png'));
    await addImage(engine, otherSite('pixel.png'), { crossOrigin: 'anonymous', left: 100 });
    const { text, warnings } = await exportSvg(engine, { embedImages: true });
    expect(externalLinks(text)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('does not warn about tab-only images that it embeds', async () => {
    const engine = createEngine();
    await addImage(engine, await redPicture());
    expect((await exportSvg(engine, {})).warnings).toEqual(['ASSET_NOT_PORTABLE']);
    expect((await exportSvg(engine, { embedImages: true })).warnings).toEqual([]);
  });

  it('embeds pattern fills and images inside groups', async () => {
    const engine = createEngine();
    const url = await redPicture();
    const element = await fabric.util.loadImage(url);
    engine.canvas.add(new Rect({ left: 10, top: 10, width: 50, height: 50, fill: new Pattern({ source: element, repeat: 'repeat' }) }));
    const image = await FabricImage.fromURL(url);
    engine.canvas.add(new Group([image], { left: 100, top: 10 }));
    const { text } = await exportSvg(engine, { embedImages: true });
    expect(externalLinks(text)).toEqual([]);
    expect(text.match(/data:image\/png;base64,/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('warns about an image it may not read, and names the object', async () => {
    const engine = createEngine();
    const image = await addImage(engine, otherSite('no-cors.png'));
    const id = (image as unknown as { id: string }).id;
    const result = await engine.export({ format: 'svg', svg: { embedImages: true } });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'IMAGE_NOT_EMBEDDED', url: otherSite('no-cors.png'), objectIds: [id] }),
    ]);
    expect(result.warnings[0]!.message).toContain('CORS');
    expect(externalLinks(await result.blob.text())).toEqual([otherSite('no-cors.png')]);
  });

  it('blocks the export when every image is required', async () => {
    const engine = createEngine();
    await addImage(engine, otherSite('no-cors.png'));
    const error = await engine.export({ format: 'svg', svg: { embedImages: 'require' } }).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('EXPORT_BLOCKED');
    expect(isDocumentEngineError(error) && error.problems.map((problem) => problem.code)).toEqual(['IMAGE_NOT_EMBEDDED']);
  });

  it('leaves out images over the size limit', async () => {
    const engine = createEngine();
    await addImage(engine, route('big.png'));
    const result = await engine.export({ format: 'svg', svg: { embedImages: true, maxEmbeddedImageBytes: 1000 } });
    expect(result.warnings.map((warning) => warning.code)).toEqual(['IMAGE_NOT_EMBEDDED']);
    expect(result.warnings[0]!.message).toContain('larger than 1000 bytes');
  });

  it('respects the address rule from limits', async () => {
    const engine = createEngine({ limits: { isAllowedUrl: (url) => !url.includes('pixel') } });
    await addImage(engine, route('pixel.png'));
    const result = await engine.export({ format: 'svg', svg: { embedImages: true } });
    expect(result.warnings[0]?.message).toContain('not allowed');
  });

  it('can be cancelled while it embeds', async () => {
    const engine = createEngine();
    await addImage(engine, route('slow.png?ms=20'));
    engine.canvas.getObjects()[0]!.set('src', route('slow.png?ms=3000'));
    const image = engine.canvas.getObjects()[0] as FabricImage;
    (image.getElement() as HTMLImageElement).src = route('slow.png?ms=3000');
    const controller = new AbortController();
    const exporting = engine.export({ format: 'svg', svg: { embedImages: true }, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const error = await exporting.catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('EXPORT_ABORTED');
  });

  it('embeds fonts the canvas uses, including fonts on single letters', async () => {
    const face = new FontFace('Roboto Test', `url(${route('roboto.ttf')})`);
    document.fonts.add(await face.load());
    try {
      const engine = createEngine();
      engine.canvas.add(
        new FabricText('Embedded font', {
          left: 10,
          top: 30,
          fontSize: 28,
          fontFamily: 'Roboto Test',
          styles: { 0: { 0: { fontFamily: 'Other Family' } } },
        }),
      );
      engine.canvas.renderAll();
      const reference = rasterizeCanvas(engine.canvas);

      const result = await engine.export({
        format: 'svg',
        svg: { embedFonts: { 'Roboto Test': route('roboto.ttf') } },
      });
      const text = await result.blob.text();
      expect(text).toContain('@font-face { font-family: "Roboto Test"; src: url("data:font/ttf;base64,');
      // "Other Family" is not installed, so the preflight warns too.
      expect(result.warnings.map((warning) => [warning.code, warning.family])).toEqual([
        ['FONT_UNAVAILABLE', 'Other Family'],
        ['FONT_NOT_EMBEDDED', 'Other Family'],
      ]);
      expect(new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('parsererror')).toBeNull();

      // Only the first letter uses the missing family, so the rest must match.
      const withFont = inkDifference(reference, await rasterizeSvg(text, WIDTH, HEIGHT));
      const withoutFont = inkDifference(reference, await rasterizeSvg(await (await engine.export({ format: 'svg' })).blob.text(), WIDTH, HEIGHT));
      expect(withFont).toBeLessThan(withoutFont);
    } finally {
      document.fonts.delete(face);
    }
  });

  it('accepts font bytes as well as URLs', async () => {
    const engine = createEngine();
    engine.canvas.add(new FabricText('Bytes', { fontFamily: 'Roboto Bytes' }));
    const bytes = await (await fetch(route('roboto.ttf'))).arrayBuffer();
    const result = await engine.export({ format: 'svg', svg: { embedFonts: { 'Roboto Bytes': bytes } } });
    expect(await result.blob.text()).toContain('font-family: "Roboto Bytes"; src: url("data:font/ttf;base64,AAEAAA');
  });

  it('refuses bad embedding options', async () => {
    const engine = createEngine();
    for (const svg of [{ embedImages: 'always' }, { maxEmbeddedImageBytes: 0 }, { embedFonts: 'Roboto' }]) {
      const error = await engine.export({ format: 'svg', svg: svg as never }).catch((reason: unknown) => reason);
      expect(isDocumentEngineError(error) && error.code).toBe('INVALID_EXPORT_OPTIONS');
    }
  });
});
