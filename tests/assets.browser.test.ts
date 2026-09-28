import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, FabricImage, Textbox } from 'fabric';
import { createDocumentEngine, isDocumentEngineError } from '../src';
import type { AssetWarning, DocumentEngine, DocumentEngineOptions, FabricDocument } from '../src';
import { inspectAssets } from '../src/assets/asset-pipeline';
import { createMemoryStorage } from '../src/storage';

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

function pictureOfSize(width: number, height: number): HTMLCanvasElement {
  const picture = document.createElement('canvas');
  picture.width = width;
  picture.height = height;
  const context = picture.getContext('2d')!;
  context.fillStyle = 'tomato';
  context.fillRect(0, 0, width, height);
  return picture;
}

const smallPicture = pictureOfSize(4, 4).toDataURL();
const widePicture = pictureOfSize(8, 2).toDataURL();

function documentWithImages(sources: string[]): FabricDocument {
  return {
    schemaVersion: 1,
    id: 'with-images',
    createdAt: '',
    updatedAt: '',
    canvas: { width: 300, height: 200 },
    objects: sources.map((src, index) => ({ type: 'Image', id: `image-${index}`, src, width: 4, height: 4 })),
    metadata: {},
  };
}

function srcOf(object: unknown): string {
  return (object as FabricImage).getSrc();
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`assets and fonts on Fabric ${fabric.version}`, () => {
  it('lists every missing image before touching the canvas', async () => {
    const engine = createEngine();
    engine.canvas.add(new Textbox('keep me'));
    const error = await engine
      .loadDocument(documentWithImages(['/missing-one.png', smallPicture, '/missing-two.png']))
      .catch((reason: unknown) => reason);

    expect(isDocumentEngineError(error) && error.code).toBe('MISSING_ASSETS');
    const missing = isDocumentEngineError(error) ? error.missingAssets : [];
    expect(missing.map((image) => image.url)).toEqual(['/missing-one.png', '/missing-two.png']);
    expect(missing.map((image) => image.objectIds)).toEqual([['image-0'], ['image-2']]);
    expect(engine.canvas.getObjects()).toHaveLength(1);
  });

  it('loads with a replacement when the app offers one', async () => {
    const replaceMissingImage = vi.fn(() => smallPicture);
    const engine = createEngine({ assets: { replaceMissingImage } });
    const warnings: AssetWarning[] = [];
    engine.on('assets:warning', (event) => warnings.push(...event.warnings));

    await engine.loadDocument(documentWithImages(['/gone.png']));
    expect(replaceMissingImage).toHaveBeenCalledWith({ url: '/gone.png', objectIds: ['image-0'] });
    expect(srcOf(engine.canvas.getObjects()[0])).toBe(smallPicture);
    expect(warnings.map((warning) => warning.code)).toEqual(['IMAGE_REPLACED']);
  });

  it('still fails when the replacement is missing too', async () => {
    const engine = createEngine({ assets: { replaceMissingImage: () => '/also-gone.png' } });
    const error = await engine.loadDocument(documentWithImages(['/gone.png'])).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('MISSING_ASSETS');
  });

  it('resolves stored asset addresses before loading', async () => {
    const engine = createEngine({ assets: { resolveUrl: (url) => (url === 'asset://logo' ? smallPicture : url) } });
    const loaded = await engine.loadDocument(documentWithImages(['asset://logo']));
    expect(srcOf(engine.canvas.getObjects()[0])).toBe(smallPicture);
    expect(loaded.objects[0]?.src).toBe(smallPicture);
  });

  it('warns about fonts that are not available and can require them instead', async () => {
    const textDocument = documentWithImages([]);
    textDocument.objects.push({ type: 'Textbox', id: 'title', text: 'Hello', fontFamily: 'Surely Not An Installed Font' });

    const lenient = createEngine();
    const loaded = vi.fn();
    lenient.on('load:success', loaded);
    await lenient.loadDocument(textDocument);
    const warnings: AssetWarning[] = loaded.mock.calls[0]![0].warnings;
    expect(warnings.map((warning) => [warning.code, warning.family, warning.objectIds])).toEqual([
      ['FONT_UNAVAILABLE', 'Surely Not An Installed Font', ['title']],
    ]);

    const strict = createEngine({ assets: { requireFonts: true } });
    const error = await strict.loadDocument(textDocument).catch((reason: unknown) => reason);
    expect(isDocumentEngineError(error) && error.code).toBe('MISSING_FONTS');
    expect(isDocumentEngineError(error) && error.missingFonts.map((font) => font.family)).toEqual([
      'Surely Not An Installed Font',
    ]);
  });

  it('lets the app load a font before text is created', async () => {
    const loadFont = vi.fn(async ({ family }: { family: string }) => {
      const face = new FontFace(family, 'local("Arial"), local("DejaVu Sans"), local("Liberation Sans"), local("Helvetica")');
      document.fonts.add(await face.load());
    });
    const engine = createEngine({ assets: { loadFont, requireFonts: true } });
    const brandedDocument = documentWithImages([]);
    brandedDocument.objects.push({ type: 'Textbox', id: 'title', text: 'Brand', fontFamily: 'Brand Display' });

    await engine.loadDocument(brandedDocument);
    expect(loadFont).toHaveBeenCalledWith(expect.objectContaining({ family: 'Brand Display', objectIds: ['title'] }));
    expect(engine.canvas.getObjects()).toHaveLength(1);
  });

  it('warns that images from another site without crossOrigin will block export', async () => {
    const report = await inspectAssets(
      documentWithImages(['https://images.example.test/photo.png']),
      { checkImages: false },
      new AbortController().signal,
    );
    expect(report.warnings.map((warning) => warning.code)).toEqual(['IMAGE_CROSS_ORIGIN']);

    const safe = documentWithImages(['https://images.example.test/photo.png']);
    safe.objects[0]!.crossOrigin = 'anonymous';
    const safeReport = await inspectAssets(safe, { checkImages: false }, new AbortController().signal);
    expect(safeReport.warnings).toEqual([]);
  });

  it('uploads images that only live in this tab when saving', async () => {
    const blob = await new Promise<Blob>((resolve) => pictureOfSize(4, 4).toBlob((value) => resolve(value!)));
    const blobUrl = URL.createObjectURL(blob);
    const upload = vi.fn(async () => `${smallPicture}#uploaded`);
    const storage = createMemoryStorage();
    const engine = createEngine({ storage, assets: { upload } });
    engine.canvas.add(await FabricImage.fromURL(blobUrl));
    await nextTick();

    const saved = await engine.save();
    await engine.save();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(saved.objects[0]?.src).toMatch(/#uploaded$/);
    expect(((await storage.loadDocument(saved.id)) as FabricDocument).objects[0]?.src).toMatch(/#uploaded$/);
  });

  it('warns when a tab-only image is saved without an upload handler', async () => {
    const blob = await new Promise<Blob>((resolve) => pictureOfSize(4, 4).toBlob((value) => resolve(value!)));
    const engine = createEngine({ storage: createMemoryStorage() });
    const warnings: AssetWarning[] = [];
    engine.on('assets:warning', (event) => warnings.push(...event.warnings));
    engine.canvas.add(await FabricImage.fromURL(URL.createObjectURL(blob)));
    await engine.save();
    expect(warnings.map((warning) => warning.code)).toEqual(['ASSET_NOT_PORTABLE']);
  });

  it('replaces an image everywhere, keeps its size on the page and undoes in one step', async () => {
    const engine = createEngine();
    const first = await FabricImage.fromURL(smallPicture);
    const second = await FabricImage.fromURL(smallPicture);
    first.set({ scaleX: 10, scaleY: 10 });
    engine.canvas.add(first, second);
    await nextTick();

    const replaced = await engine.replaceImage(smallPicture, widePicture);
    expect(replaced).toBe(2);
    const images = engine.canvas.getObjects() as FabricImage[];
    expect(images.map(srcOf)).toEqual([widePicture, widePicture]);
    expect(images[0]!.getScaledWidth()).toBeCloseTo(40);
    expect(images[0]!.getScaledHeight()).toBeCloseTo(40);
    expect(engine.getHistory().undo[0]).toBe('Replace image');

    await engine.undo();
    expect((engine.canvas.getObjects() as FabricImage[]).map(srcOf)).toEqual([smallPicture, smallPicture]);
  });

  it('describes the assets of the current canvas', async () => {
    const engine = createEngine();
    engine.canvas.add(new Textbox('Title', { fontFamily: 'Georgia', fontWeight: 'bold' }));
    const manifest = engine.getAssetManifest();
    expect(manifest.fonts).toEqual([
      expect.objectContaining({ family: 'Georgia', weight: 'bold', style: 'normal' }),
    ]);
    const report = await engine.checkAssets();
    expect(report.missingImages).toEqual([]);
  });
});
