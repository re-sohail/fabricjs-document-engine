import type { FabricDocument } from '../document/document-format';
import { DocumentEngineError, isDocumentEngineError } from '../engine/errors';
import { buildAssetManifest, isEmbeddedUrl } from './asset-manifest';
import type { AssetManifest, FontAsset, ImageAsset } from './asset-manifest';
import { findImageReferences } from './asset-references';
import type { ImageReference } from './asset-references';
import { findUnavailableFonts } from './font-check';
import type { FontLoader } from './font-check';
import { refuseUnsafeImageUrls } from '../security/content-limits';
import { findMissingImages, isCrossOriginUrl, isPortableUrl } from './image-check';

export type AssetWarningCode = 'IMAGE_CROSS_ORIGIN' | 'FONT_UNAVAILABLE' | 'ASSET_NOT_PORTABLE' | 'IMAGE_REPLACED';

export interface AssetWarning {
  code: AssetWarningCode;
  message: string;
  url?: string;
  family?: string;
  objectIds: string[];
}

export interface UploadRequest {
  url: string;
  blob: Blob;
  objectIds: string[];
}

export interface AssetOptions {
  resolveUrl?: (url: string) => string | Promise<string>;
  replaceMissingImage?: (image: ImageAsset) => string | null | undefined | Promise<string | null | undefined>;
  upload?: (request: UploadRequest) => Promise<string>;
  loadFont?: FontLoader;
  checkImages?: boolean;
  requireFonts?: boolean;
}

export interface AssetReport {
  manifest: AssetManifest;
  missingImages: ImageAsset[];
  unavailableFonts: FontAsset[];
  warnings: AssetWarning[];
}

export interface PreparedDocument {
  document: FabricDocument;
  warnings: AssetWarning[];
}

function cloneDocument(document: FabricDocument): FabricDocument {
  return JSON.parse(JSON.stringify(document)) as FabricDocument;
}

function groupByUrl(references: readonly ImageReference[]): Map<string, ImageReference[]> {
  const groups = new Map<string, ImageReference[]>();
  for (const reference of references) {
    const group = groups.get(reference.url) ?? [];
    group.push(reference);
    groups.set(reference.url, group);
  }
  return groups;
}

function objectIdsOf(references: readonly ImageReference[]): string[] {
  return [...new Set(references.map((reference) => reference.objectId).filter((id): id is string => id !== undefined))];
}

function pointTo(references: readonly ImageReference[], url: string): void {
  for (const reference of references) {
    reference.holder[reference.key] = url;
    reference.url = url;
  }
}

export async function rewriteUrls(document: FabricDocument, rewrite: (url: string, references: ImageReference[]) => Promise<string>): Promise<void> {
  const groups = groupByUrl(findImageReferences(document.objects));
  await Promise.all(
    [...groups].map(async ([url, references]) => {
      const next = await rewrite(url, references);
      if (next !== url) pointTo(references, next);
    }),
  );
}

function crossOriginWarnings(document: FabricDocument): AssetWarning[] {
  const warnings: AssetWarning[] = [];
  for (const [url, references] of groupByUrl(findImageReferences(document.objects))) {
    if (!isCrossOriginUrl(url) || references.every((reference) => reference.crossOrigin)) continue;
    warnings.push({
      code: 'IMAGE_CROSS_ORIGIN',
      message: `The image ${url} comes from another site without crossOrigin set, so exporting the canvas will fail`,
      url,
      objectIds: objectIdsOf(references),
    });
  }
  return warnings;
}

function fontWarnings(fonts: readonly FontAsset[]): AssetWarning[] {
  return fonts.map((font) => ({
    code: 'FONT_UNAVAILABLE',
    message: `The font "${font.family}" (${font.weight}, ${font.style}) is not available, text will use a fallback font`,
    family: font.family,
    objectIds: font.objectIds,
  }));
}

export async function inspectAssets(document: FabricDocument, options: AssetOptions, signal: AbortSignal): Promise<AssetReport> {
  const manifest = buildAssetManifest(document.objects);
  const imagesToCheck = findImageReferences(document.objects).filter((reference) => !isEmbeddedUrl(reference.url));
  const uniqueImages = [...groupByUrl(imagesToCheck)].map(([url, references]) => ({ url, crossOrigin: references[0]!.crossOrigin }));

  const [missingUrls, unavailableFonts] = await Promise.all([
    options.checkImages === false ? Promise.resolve<string[]>([]) : findMissingImages(uniqueImages, signal),
    findUnavailableFonts(manifest.fonts, options.loadFont),
  ]);
  const missing = new Set(missingUrls);
  return {
    manifest,
    missingImages: manifest.images.filter((image) => missing.has(image.url)),
    unavailableFonts,
    warnings: [...crossOriginWarnings(document), ...fontWarnings(unavailableFonts)],
  };
}

async function replaceMissingImages(
  document: FabricDocument,
  missingImages: readonly ImageAsset[],
  options: AssetOptions,
  signal: AbortSignal,
): Promise<{ stillMissing: ImageAsset[]; warnings: AssetWarning[] }> {
  const replace = options.replaceMissingImage;
  if (!replace || missingImages.length === 0) return { stillMissing: [...missingImages], warnings: [] };

  const replacements = new Map<string, string>();
  for (const image of missingImages) {
    const replacement = await replace(image);
    if (typeof replacement === 'string' && replacement.length > 0) replacements.set(image.url, replacement);
  }
  const brokenReplacements = new Set(
    await findMissingImages(
      [...replacements.values()].map((url) => ({ url, crossOrigin: null })),
      signal,
    ),
  );

  const stillMissing: ImageAsset[] = [];
  const warnings: AssetWarning[] = [];
  const groups = groupByUrl(findImageReferences(document.objects));
  for (const image of missingImages) {
    const replacement = replacements.get(image.url);
    if (replacement === undefined || brokenReplacements.has(replacement)) {
      stillMissing.push(image);
      continue;
    }
    pointTo(groups.get(image.url) ?? [], replacement);
    warnings.push({
      code: 'IMAGE_REPLACED',
      message: `The missing image ${image.url} was replaced with ${replacement}`,
      url: image.url,
      objectIds: image.objectIds,
    });
  }
  return { stillMissing, warnings };
}

export async function prepareAssetsForLoad(
  input: FabricDocument,
  options: AssetOptions,
  signal: AbortSignal,
  isAllowedUrl?: (url: string) => boolean,
): Promise<PreparedDocument> {
  const document = cloneDocument(input);
  const { resolveUrl } = options;
  if (resolveUrl) await rewriteUrls(document, async (url) => resolveUrl(url));
  refuseUnsafeImageUrls(document.objects, isAllowedUrl);

  const report = await inspectAssets(document, options, signal);
  if (options.requireFonts && report.unavailableFonts.length > 0) {
    const families = report.unavailableFonts.map((font) => font.family).join(', ');
    throw new DocumentEngineError('MISSING_FONTS', `These fonts are not available: ${families}`, {
      missingFonts: report.unavailableFonts,
    });
  }

  const { stillMissing, warnings } = await replaceMissingImages(document, report.missingImages, options, signal);
  if (stillMissing.length > 0) {
    const urls = stillMissing.map((image) => image.url).join(', ');
    throw new DocumentEngineError('MISSING_ASSETS', `These images could not be loaded: ${urls}`, {
      missingAssets: stillMissing,
    });
  }
  return { document, warnings: [...report.warnings, ...warnings] };
}

async function uploadOnce(url: string, references: ImageReference[], upload: NonNullable<AssetOptions['upload']>): Promise<string> {
  try {
    const blob = await (await fetch(url)).blob();
    return await upload({ url, blob, objectIds: objectIdsOf(references) });
  } catch (error) {
    if (isDocumentEngineError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new DocumentEngineError('ASSET_UPLOAD_FAILED', `Could not upload the image ${url.slice(0, 60)}: ${reason}`, {
      cause: error,
      retryable: true,
    });
  }
}

export async function prepareAssetsForSave(
  document: FabricDocument,
  options: AssetOptions,
  uploadedUrls: Map<string, Promise<string>>,
): Promise<PreparedDocument> {
  const { upload } = options;
  const warnings: AssetWarning[] = [];

  await rewriteUrls(document, async (url, references) => {
    const needsUpload = url.startsWith('blob:') || url.startsWith('data:');
    if (!needsUpload) return url;
    if (!upload) {
      if (!isPortableUrl(url)) {
        warnings.push({
          code: 'ASSET_NOT_PORTABLE',
          message: `The image ${url} only exists in this browser tab. Pass assets.upload to store it before saving.`,
          url,
          objectIds: objectIdsOf(references),
        });
      }
      return url;
    }
    let uploading = uploadedUrls.get(url);
    if (!uploading) {
      uploading = uploadOnce(url, references, upload);
      uploadedUrls.set(url, uploading);
      uploading.catch(() => uploadedUrls.delete(url));
    }
    return uploading;
  });

  document.assets = buildAssetManifest(document.objects);
  return { document, warnings };
}
