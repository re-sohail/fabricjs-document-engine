import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { isDocumentEngineError, renderDocuments } from '../src';
import type { FabricDocument, RenderDocumentsOptions, RenderedDocument, SerializedFabricObject } from '../src';

/**
 * Rendering many documents (fabric.js #4848): results stream out, failures
 * stay per document, and every canvas a batch creates is freed afterwards.
 */

function picture(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
  const url = canvas.toDataURL();
  canvas.width = 0;
  canvas.height = 0;
  return url;
}

function makeDocument(index: number, objects: SerializedFabricObject[] = []): FabricDocument {
  return {
    schemaVersion: 1,
    id: `doc-${index}`,
    createdAt: '',
    updatedAt: '',
    canvas: { width: 100 + index, height: 50 },
    objects: [
      { type: 'Rect', id: `rect-${index}`, left: 5, top: 5, width: 30, height: 20, fill: 'teal' },
      { type: 'Textbox', id: `text-${index}`, left: 5, top: 30, width: 80, text: `Page ${index}`, fontSize: 12 },
      ...objects,
    ],
    metadata: {},
  };
}

function documents(count: number, withImages = false): FabricDocument[] {
  const image = withImages ? picture() : '';
  return Array.from({ length: count }, (_, index) =>
    makeDocument(index, withImages ? [{ type: 'Image', id: `image-${index}`, src: `${image}#${index}`, left: 50, top: 5, width: 16, height: 16 }] : []),
  );
}

async function collect(source: AsyncGenerator<RenderedDocument>): Promise<RenderedDocument[]> {
  const results: RenderedDocument[] = [];
  for await (const rendered of source) results.push(rendered);
  return results;
}

/** Watches every canvas created while `work` runs and counts those still holding pixels afterwards. */
async function canvasesLeftBehind(work: () => Promise<unknown>): Promise<number> {
  const created: HTMLCanvasElement[] = [];
  const original = document.createElement.bind(document);
  const spy = vi.spyOn(document, 'createElement').mockImplementation(((name: string, options?: ElementCreationOptions) => {
    const element = original(name, options);
    if (name.toLowerCase() === 'canvas') created.push(element as HTMLCanvasElement);
    return element;
  }) as typeof document.createElement);
  try {
    await work();
  } finally {
    spy.mockRestore();
  }
  return created.filter((canvas) => canvas.width * canvas.height > 0).length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe(`rendering many documents on Fabric ${fabric.version}`, () => {
  it('renders each document at its own size and says which one each result is', async () => {
    const results = await collect(renderDocuments(documents(5), { format: 'png' }));
    expect(results.map((result) => result.index).sort()).toEqual([0, 1, 2, 3, 4]);
    for (const { index, documentId, result, error } of results) {
      expect(error).toBeUndefined();
      expect(documentId).toBe(`doc-${index}`);
      expect(result?.width).toBe(100 + index);
      expect(result?.blob.type).toBe('image/png');
      expect(result?.blob.size).toBeGreaterThan(100);
    }
  });

  it('keeps going when one document fails, and reports why', async () => {
    const input: unknown[] = [makeDocument(0), { schemaVersion: 1, objects: 'broken' }, makeDocument(2)];
    const results = (await collect(renderDocuments(input, { format: 'png' }))).sort((a, b) => a.index - b.index);
    expect(results.map((result) => Boolean(result.result))).toEqual([true, false, true]);
    expect(results[1]?.error?.code).toBe('INVALID_DOCUMENT');
  });

  it('renders SVG and JSON too', async () => {
    const [svg] = await collect(renderDocuments(documents(1), { format: 'svg', svg: { embedImages: true } }));
    expect(await svg!.result!.blob.text()).toContain('<svg');
    const [json] = await collect(renderDocuments(documents(1), { format: 'json' }));
    expect(JSON.parse(await json!.result!.blob.text()).id).toBe('doc-0');
  });

  it('takes documents from an async source, such as pages of a query', async () => {
    async function* pages(): AsyncGenerator<FabricDocument> {
      for (let index = 0; index < 4; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield makeDocument(index);
      }
    }
    const results = await collect(renderDocuments(pages(), { format: 'jpeg', concurrency: 3 }));
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.result?.blob.type === 'image/jpeg')).toBe(true);
  });

  it('reports progress after each document', async () => {
    const seen: Array<{ done: number; total: number | undefined }> = [];
    await collect(renderDocuments(documents(3), { format: 'png', onProgress: (progress) => seen.push(progress) }));
    expect(seen).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
  });

  it('runs no more documents at once than the concurrency', async () => {
    let started = 0;
    let finished = 0;
    let mostAtOnce = 0;
    // Each document is handed out only when a canvas is free, so the gap
    // between documents taken and documents finished is what runs at once.
    async function* counted(): AsyncGenerator<FabricDocument> {
      for (let index = 0; index < 8; index += 1) {
        started += 1;
        mostAtOnce = Math.max(mostAtOnce, started - finished);
        yield makeDocument(index);
      }
    }
    for await (const _ of renderDocuments(counted(), { format: 'png', concurrency: 2 })) finished += 1;
    expect(finished).toBe(8);
    expect(mostAtOnce).toBe(2);
  });

  it('frees every canvas it creates, however many documents it renders', async () => {
    const options: RenderDocumentsOptions = { format: 'png', concurrency: 2 };
    const fewer = await canvasesLeftBehind(() => collect(renderDocuments(documents(15, true), options)));
    const more = await canvasesLeftBehind(() => collect(renderDocuments(documents(60, true), options)));
    // Fabric and the font check each keep one small canvas for measuring text.
    expect(fewer).toBeLessThanOrEqual(2);
    expect(more).toBe(fewer);
  }, 60_000);

  it('frees its canvases when the caller stops early', async () => {
    const left = await canvasesLeftBehind(async () => {
      for await (const rendered of renderDocuments(documents(10, true), { format: 'png' })) {
        expect(rendered.result).toBeDefined();
        break;
      }
    });
    expect(left).toBeLessThanOrEqual(2);
  });

  it('stops when cancelled and frees its canvases', async () => {
    const controller = new AbortController();
    let error: unknown;
    let rendered = 0;
    const left = await canvasesLeftBehind(async () => {
      try {
        for await (const _ of renderDocuments(documents(20, true), { format: 'png', signal: controller.signal })) {
          rendered += 1;
          controller.abort();
        }
      } catch (reason) {
        error = reason;
      }
    });
    expect(isDocumentEngineError(error) && error.code).toBe('EXPORT_ABORTED');
    expect(rendered).toBe(1);
    expect(left).toBeLessThanOrEqual(2);
  });

  it('renders nothing for no documents', async () => {
    expect(await collect(renderDocuments([], { format: 'png' }))).toEqual([]);
  });
});
