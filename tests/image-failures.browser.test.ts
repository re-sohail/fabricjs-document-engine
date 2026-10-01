import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Rect } from 'fabric';
import { createDocumentEngine, isDocumentEngineError } from '../src';
import type { DocumentEngine, DocumentEngineOptions, FabricDocument, ImageAsset } from '../src';
import { findMissingImages } from '../src/assets/image-check';

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

const route = (name: string): string => `/__test-assets__/${name}`;

/** The same test server under another host name, so the browser treats it as another site. */
function otherSite(name: string): string {
  const host = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  return `${location.protocol}//${host}:${location.port}${route(name)}`;
}

function documentWithImages(images: Array<{ src: string; crossOrigin?: string }>): FabricDocument {
  return {
    schemaVersion: 1,
    id: 'with-images',
    createdAt: '',
    updatedAt: '',
    canvas: { width: 300, height: 200 },
    objects: images.map((image, index) => ({ type: 'Image', id: `image-${index}`, width: 1, height: 1, ...image })),
    metadata: {},
  };
}

async function missingAssetsOf(promise: Promise<unknown>): Promise<ImageAsset[]> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(isDocumentEngineError(error) && error.code).toBe('MISSING_ASSETS');
  return isDocumentEngineError(error) ? error.missingAssets : [];
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`image load failures on Fabric ${fabric.version}`, () => {
  it('loads a working image without reporting anything', async () => {
    const failures = await findMissingImages([{ url: route('pixel.png'), crossOrigin: 'anonymous' }], new AbortController().signal);
    expect(failures).toEqual([]);
  });

  it('says which image was not found, with its status and objects', async () => {
    const engine = createEngine();
    const [missing] = await missingAssetsOf(engine.loadDocument(documentWithImages([{ src: route('gone.png') }])));
    expect(missing?.objectIds).toEqual(['image-0']);
    expect(missing?.failure).toMatchObject({ url: route('gone.png'), reason: 'NOT_FOUND', status: 404 });
    expect(missing?.failure?.message).toContain('404');
  });

  it('tells a server error apart from a missing file', async () => {
    const failures = await findMissingImages([{ url: route('broken-server.png'), crossOrigin: null }], new AbortController().signal);
    expect(failures).toEqual([expect.objectContaining({ reason: 'HTTP_ERROR', status: 500 })]);
  });

  it('reports bytes that are not a picture as a decode failure', async () => {
    const failures = await findMissingImages([{ url: route('not-a-picture.png'), crossOrigin: null }], new AbortController().signal);
    expect(failures).toEqual([expect.objectContaining({ reason: 'DECODE', status: 200 })]);
  });

  it('reports broken embedded data as a decode failure', async () => {
    const url = 'data:image/png;base64,bm90IGEgcG5n';
    const failures = await findMissingImages([{ url, crossOrigin: null }], new AbortController().signal);
    expect(failures).toEqual([expect.objectContaining({ url, reason: 'DECODE' })]);
  });

  it('stops waiting for a slow image after the time limit', async () => {
    const engine = createEngine({ assets: { imageTimeout: 100 } });
    const url = route('slow.png?ms=3000');
    const [missing] = await missingAssetsOf(engine.loadDocument(documentWithImages([{ src: url }])));
    expect(missing?.failure).toMatchObject({ url, reason: 'TIMEOUT', timeoutMs: 100 });
  });

  it('waits for a slow image when the time limit is off', async () => {
    const failures = await findMissingImages([{ url: route('slow.png?ms=150'), crossOrigin: null }], new AbortController().signal, {
      timeoutMs: 0,
    });
    expect(failures).toEqual([]);
  });

  it('names CORS when another site does not allow the image to be read', async () => {
    const url = otherSite('no-cors.png');
    const failures = await findMissingImages([{ url, crossOrigin: 'anonymous' }], new AbortController().signal);
    expect(failures).toEqual([expect.objectContaining({ url, reason: 'CORS' })]);
    expect(failures[0]?.message).toContain('Access-Control-Allow-Origin');
  });

  it('loads an image from another site that sends CORS headers', async () => {
    const failures = await findMissingImages([{ url: otherSite('pixel.png'), crossOrigin: 'anonymous' }], new AbortController().signal);
    expect(failures).toEqual([]);
  });

  it('reports a revoked blob URL as unreachable', async () => {
    const url = URL.createObjectURL(new Blob(['x'], { type: 'image/png' }));
    URL.revokeObjectURL(url);
    const failures = await findMissingImages([{ url, crossOrigin: null }], new AbortController().signal);
    expect(failures).toEqual([expect.objectContaining({ url, reason: 'NETWORK' })]);
  });

  it('reports images as aborted when the work is cancelled', async () => {
    const controller = new AbortController();
    const checking = findMissingImages([{ url: route('slow.png?ms=3000'), crossOrigin: null }], controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect(await checking).toEqual([expect.objectContaining({ reason: 'ABORTED' })]);
  });

  it('includes the reason in the error message and keeps the canvas', async () => {
    const engine = createEngine();
    engine.canvas.add(new Rect({ width: 5, height: 5 }));
    const error = await engine.loadDocument(documentWithImages([{ src: route('gone.png') }])).catch((reason: unknown) => reason);
    expect(String((error as Error).message)).toContain('NOT_FOUND');
    expect(engine.canvas.getObjects()).toHaveLength(1);
  });

  it('gives checkAssets the reason for each missing image', async () => {
    const engine = createEngine();
    // Never drawn: a broken picture cannot be painted.
    engine.canvas.renderOnAddRemove = false;
    const element = new Image();
    element.src = route('gone.png');
    engine.canvas.add(new fabric.FabricImage(element, { width: 1, height: 1 }));
    const report = await engine.checkAssets();
    expect(report.missingImages).toEqual([
      expect.objectContaining({ url: expect.stringContaining('gone.png'), failure: expect.objectContaining({ reason: 'NOT_FOUND' }) }),
    ]);
  });
});
