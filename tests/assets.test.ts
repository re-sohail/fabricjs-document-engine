import { describe, expect, it } from 'vitest';
import { findFontReferences, findImageReferences } from '../src/assets/asset-references';
import { buildAssetManifest } from '../src/assets/asset-manifest';
import { prepareAssetsForSave } from '../src/assets/asset-pipeline';
import { fontDescriptor } from '../src/assets/font-check';
import { isCrossOriginUrl } from '../src/assets/image-check';
import type { FabricDocument, SerializedFabricObject } from '../src/document/document-format';

const objects: SerializedFabricObject[] = [
  { type: 'Image', id: 'photo', src: 'https://cdn.test/photo.png' },
  { type: 'Image', id: 'again', src: 'https://cdn.test/photo.png' },
  { type: 'Image', id: 'inline', src: 'data:image/png;base64,AAAA' },
  {
    type: 'Group',
    id: 'group',
    objects: [{ type: 'Rect', id: 'patterned', fill: { type: 'pattern', source: 'https://cdn.test/wood.jpg' } }],
  },
  { type: 'Rect', id: 'clipped', clipPath: { type: 'Image', src: 'https://cdn.test/mask.png' } },
  {
    type: 'Textbox',
    id: 'title',
    fontFamily: 'Inter',
    fontWeight: 'bold',
    fontStyle: 'normal',
    styles: [{ start: 0, end: 3, style: { fontFamily: 'Lobster' } }],
  },
  { type: 'IText', id: 'legacy', fontFamily: 'Inter', fontWeight: 400, styles: { 0: { 1: { fontStyle: 'italic' } } } },
];

function documentWith(documentObjects: SerializedFabricObject[]): FabricDocument {
  return {
    schemaVersion: 1,
    id: 'doc',
    createdAt: '',
    updatedAt: '',
    canvas: { width: 10, height: 10 },
    objects: documentObjects,
    metadata: {},
  };
}

describe('asset references', () => {
  it('finds images, pattern sources and clip path images with their owners', () => {
    const found = findImageReferences(objects).map((reference) => [reference.objectId, reference.url]);
    expect(found).toEqual(
      expect.arrayContaining([
        ['photo', 'https://cdn.test/photo.png'],
        ['patterned', 'https://cdn.test/wood.jpg'],
        ['clipped', 'https://cdn.test/mask.png'],
      ]),
    );
  });

  it('finds fonts used by whole objects and by single characters', () => {
    const fonts = findFontReferences(objects).map((font) => `${font.family}/${font.weight}/${font.style}`);
    expect(fonts).toEqual(
      expect.arrayContaining(['Inter/bold/normal', 'Lobster/bold/normal', 'Inter/400/normal', 'Inter/400/italic']),
    );
  });
});

describe('buildAssetManifest', () => {
  it('lists each image once with every object that uses it and skips embedded images', () => {
    const manifest = buildAssetManifest(objects);
    expect(manifest.images.find((image) => image.url.endsWith('photo.png'))?.objectIds.sort()).toEqual(['again', 'photo']);
    expect(manifest.images.some((image) => image.url.startsWith('data:'))).toBe(false);
    expect(manifest.images).toHaveLength(3);
  });

  it('lists each font variant once', () => {
    const manifest = buildAssetManifest(objects);
    expect(manifest.fonts).toHaveLength(4);
  });
});

describe('prepareAssetsForSave', () => {
  it('uploads embedded images once and points the document at the uploaded copy', async () => {
    const uploads: string[] = [];
    const uploaded = new Map<string, Promise<string>>();
    const upload = async ({ url, blob }: { url: string; blob: Blob }) => {
      uploads.push(url);
      expect(blob.size).toBeGreaterThan(0);
      return 'https://cdn.test/uploaded.png';
    };
    const first = await prepareAssetsForSave(documentWith(structuredClone(objects)), { upload }, uploaded);
    await prepareAssetsForSave(documentWith(structuredClone(objects)), { upload }, uploaded);

    expect(uploads).toHaveLength(1);
    expect(first.document.objects[2]?.src).toBe('https://cdn.test/uploaded.png');
    expect(first.document.assets?.images.map((image) => image.url)).toContain('https://cdn.test/uploaded.png');
  });

  it('warns about images that only exist in this tab when nothing can upload them', async () => {
    const prepared = await prepareAssetsForSave(
      documentWith([{ type: 'Image', id: 'local', src: 'blob:https://app.test/1234' }]),
      {},
      new Map(),
    );
    expect(prepared.warnings.map((warning) => warning.code)).toEqual(['ASSET_NOT_PORTABLE']);
  });

  it('reports a failed upload clearly', async () => {
    const upload = async () => {
      throw new Error('bucket is full');
    };
    await expect(
      prepareAssetsForSave(documentWith([{ type: 'Image', src: 'data:image/png;base64,AAAA' }]), { upload }, new Map()),
    ).rejects.toMatchObject({ code: 'ASSET_UPLOAD_FAILED', retryable: true });
  });
});

describe('small helpers', () => {
  it('quotes font families but not generic ones', () => {
    expect(fontDescriptor({ family: 'Open Sans', weight: 'bold', style: 'italic' })).toBe('italic bold 32px "Open Sans"');
    expect(fontDescriptor({ family: 'serif', weight: 'normal', style: 'normal' })).toBe('normal normal 32px serif');
  });

  it('treats URLs as same-origin when there is no browser location', () => {
    expect(isCrossOriginUrl('https://elsewhere.test/a.png')).toBe(false);
  });
});
