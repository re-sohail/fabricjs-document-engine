import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, FabricImage, Rect, Textbox } from 'fabric';
import { createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, DocumentEngineOptions, ExportResult, FabricDocument } from '../src';

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(options: Omit<DocumentEngineOptions, 'canvas'> = {}): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 300, height: 200 });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas, ...options });
  openEngines.push(engine);
  return engine;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function pixelsOf(result: ExportResult) {
  const bitmap = await createImageBitmap(result.blob);
  const surface = document.createElement('canvas');
  surface.width = bitmap.width;
  surface.height = bitmap.height;
  const context = surface.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  return {
    width: bitmap.width,
    height: bitmap.height,
    at(x: number, y: number) {
      const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
      return { red: red!, green: green!, blue: blue!, alpha: alpha! };
    },
  };
}

function addRedSquare(engine: DocumentEngine, left = 100, top = 50): Rect {
  const square = new Rect({ left, top, width: 40, height: 40, fill: '#ff0000', originX: 'left', originY: 'top', strokeWidth: 0 });
  engine.canvas.add(square);
  return square;
}

async function brokenImage(): Promise<FabricImage> {
  const element = new Image();
  await new Promise<void>((resolve) => {
    element.onerror = () => resolve();
    element.src = '/definitely-missing-export-image.png';
  });
  return new FabricImage(element, { left: 10, top: 10 });
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`export on Fabric ${fabric.version}`, () => {
  it('exports the whole canvas as PNG at its real size', async () => {
    const engine = createEngine();
    addRedSquare(engine);
    const result = await engine.export({ format: 'png' });
    const pixels = await pixelsOf(result);
    expect(result.mimeType).toBe('image/png');
    expect([pixels.width, pixels.height]).toEqual([300, 200]);
    expect(pixels.at(120, 70)).toMatchObject({ red: 255, green: 0, blue: 0, alpha: 255 });
    expect(pixels.at(5, 5).alpha).toBe(0);
  });

  it('scales the output', async () => {
    const engine = createEngine();
    addRedSquare(engine);
    const result = await engine.export({ format: 'png', scale: 2 });
    const pixels = await pixelsOf(result);
    expect([result.width, result.height, pixels.width, pixels.height]).toEqual([600, 400, 600, 400]);
    expect(pixels.at(240, 140).red).toBe(255);
  });

  it('gives JPEG a white background instead of black', async () => {
    const engine = createEngine();
    addRedSquare(engine);
    const pixels = await pixelsOf(await engine.export({ format: 'jpeg', quality: 1 }));
    const corner = pixels.at(5, 5);
    expect(corner.red).toBeGreaterThan(245);
    expect(corner.green).toBeGreaterThan(245);
  });

  it('uses a chosen background without changing the canvas', async () => {
    const engine = createEngine();
    engine.canvas.backgroundColor = '#00ff00';
    addRedSquare(engine);
    const blue = await pixelsOf(await engine.export({ format: 'png', background: '#0000ff' }));
    expect(blue.at(5, 5)).toMatchObject({ red: 0, green: 0, blue: 255 });
    const clear = await pixelsOf(await engine.export({ format: 'png', background: 'transparent' }));
    expect(clear.at(5, 5).alpha).toBe(0);
    const kept = await pixelsOf(await engine.export({ format: 'png' }));
    expect(kept.at(5, 5)).toMatchObject({ red: 0, green: 255, blue: 0 });
    expect(engine.canvas.backgroundColor).toBe('#00ff00');
  });

  it('crops to the content with padding, to the selection or to a rectangle', async () => {
    const engine = createEngine();
    const square = addRedSquare(engine, 100, 50);
    addRedSquare(engine, 200, 120);

    const content = await engine.export({ format: 'png', area: 'content', padding: 10 });
    expect([content.width, content.height]).toEqual([160, 130]);

    (engine.canvas as Canvas).setActiveObject(square);
    const selection = await engine.export({ format: 'png', area: 'selection' });
    expect([selection.width, selection.height]).toEqual([40, 40]);
    const selectionPixels = await pixelsOf(selection);
    expect(selectionPixels.at(20, 20).red).toBe(255);

    const rectangle = await engine.export({ format: 'png', area: { left: 90, top: 40, width: 20, height: 20 } });
    const rectanglePixels = await pixelsOf(rectangle);
    expect(rectanglePixels.at(15, 15).red).toBe(255);
    expect(rectanglePixels.at(2, 2).alpha).toBe(0);
  });

  it('refuses to crop to an empty canvas or an empty selection', async () => {
    const engine = createEngine();
    await expect(engine.export({ format: 'png', area: 'content' })).rejects.toMatchObject({ code: 'INVALID_EXPORT_OPTIONS' });
    addRedSquare(engine);
    await expect(engine.export({ format: 'png', area: 'selection' })).rejects.toMatchObject({ code: 'INVALID_EXPORT_OPTIONS' });
  });

  it('ignores the current zoom and pan and restores them afterwards', async () => {
    const engine = createEngine();
    addRedSquare(engine);
    engine.canvas.setViewportTransform([2, 0, 0, 2, -150, -60]);
    const pixels = await pixelsOf(await engine.export({ format: 'png' }));
    expect(pixels.at(120, 70).red).toBe(255);
    expect(engine.canvas.viewportTransform).toEqual([2, 0, 0, 2, -150, -60]);
  });

  it('exports SVG with the chosen area and scale', async () => {
    const engine = createEngine();
    addRedSquare(engine);
    const result = await engine.export({ format: 'svg', area: { left: 100, top: 50, width: 40, height: 40 }, scale: 3 });
    const markup = await result.blob.text();
    expect(result.mimeType).toBe('image/svg+xml');
    expect(markup).toContain('viewBox="100 50 40 40"');
    expect(markup).toContain('width="120"');
    expect(markup).toContain('<rect');
  });

  it('exports editable JSON that loads back', async () => {
    const engine = createEngine();
    addRedSquare(engine);
    const result = await engine.export({ format: 'json' });
    const document = JSON.parse(await result.blob.text()) as FabricDocument;
    expect(result.document?.id).toBe(document.id);

    const other = createEngine();
    await other.loadDocument(document);
    expect(other.canvas.getObjects()).toHaveLength(1);
  });

  it('explains which image blocks the export', async () => {
    const engine = createEngine();
    const image = await brokenImage();
    engine.canvas.add(image);
    const imageId = (image as FabricImage & { id?: string }).id;

    const check = await engine.preflightExport({ format: 'png' });
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([
      expect.objectContaining({ code: 'MISSING_IMAGE', objectIds: [imageId], url: expect.stringContaining('definitely-missing-export-image.png') }),
    ]);

    const errors = vi.fn();
    engine.on('export:error', errors);
    const error = await engine.export({ format: 'png' }).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('EXPORT_BLOCKED');
    expect(isDocumentEngineError(error) && error.problems.map((problem) => problem.code)).toEqual(['MISSING_IMAGE']);
    expect(errors).toHaveBeenCalledOnce();
  });

  it('explains that an image from another site would block a picture export but not SVG', async () => {
    const sameSiteUrl = new URL('./fixtures/pixel.png', import.meta.url);
    const otherSiteUrl = new URL(sameSiteUrl.href);
    otherSiteUrl.hostname = sameSiteUrl.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    const element = new Image();
    const loaded = await new Promise<boolean>((resolve) => {
      element.onload = () => resolve(true);
      element.onerror = () => resolve(false);
      element.src = otherSiteUrl.href;
    });
    expect(loaded).toBe(true);

    const engine = createEngine();
    engine.canvas.add(new FabricImage(element));
    const png = await engine.preflightExport({ format: 'png' });
    expect(png.problems.map((problem) => problem.code)).toEqual(['CROSS_ORIGIN_IMAGE']);
    const svg = await engine.preflightExport({ format: 'svg' });
    expect(svg.ok).toBe(true);
    const error = await engine.export({ format: 'png' }).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.problems[0]?.url).toBe(otherSiteUrl.href);
  });

  it('warns about missing fonts, or blocks the export when fonts are required', async () => {
    const lenient = createEngine();
    lenient.canvas.add(new Textbox('Hello', { fontFamily: 'Surely Not An Installed Font' }));
    const result = await lenient.export({ format: 'png' });
    expect(result.warnings.map((warning) => warning.code)).toEqual(['FONT_UNAVAILABLE']);

    const strict = createEngine({ assets: { requireFonts: true } });
    strict.canvas.add(new Textbox('Hello', { fontFamily: 'Surely Not An Installed Font' }));
    const error = await strict.export({ format: 'png' }).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.problems.map((problem) => [problem.code, problem.family])).toEqual([
      ['MISSING_FONT', 'Surely Not An Installed Font'],
    ]);
  });

  it('rejects options that make no sense', async () => {
    const engine = createEngine();
    for (const options of [
      { format: 'gif' },
      { format: 'png', scale: 0 },
      { format: 'jpeg', quality: 2 },
      { format: 'png', area: { left: 0, top: 0, width: -5, height: 10 } },
    ]) {
      await expect(engine.export(options as never)).rejects.toMatchObject({ code: 'INVALID_EXPORT_OPTIONS' });
    }
  });

  it('does not touch history or unsaved state', async () => {
    const engine = createEngine();
    addRedSquare(engine);
    await nextTick();
    engine.clearHistory();
    await engine.export({ format: 'png', background: '#123456', area: 'content' });
    await nextTick();
    expect(engine.canUndo()).toBe(false);
  });

  it('can be cancelled', async () => {
    const engine = createEngine();
    addRedSquare(engine);
    const controller = new AbortController();
    controller.abort();
    await expect(engine.export({ format: 'png', signal: controller.signal })).rejects.toMatchObject({ code: 'EXPORT_ABORTED' });
  });

  it('announces successful exports', async () => {
    const engine = createEngine();
    addRedSquare(engine);
    const listener = vi.fn();
    engine.on('export:success', listener);
    await engine.export({ format: 'webp', scale: 0.5 });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ format: 'webp', width: 150, height: 100 }));
  });
});
