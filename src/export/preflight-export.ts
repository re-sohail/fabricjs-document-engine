import type { FabricObject, StaticCanvas } from 'fabric';
import type { FontAsset } from '../assets/asset-manifest';
import type { AssetOptions, AssetWarning } from '../assets/asset-pipeline';
import { findUnavailableFonts } from '../assets/font-check';
import { isCrossOriginUrl, isPortableUrl } from '../assets/image-check';
import { readObjectId } from '../fabric/object-ids';
import { childrenOf } from '../fabric/walk-objects';
import type { ExportFormat } from './export-options';
import { isRasterFormat } from './export-options';

export type ExportProblemCode = 'MISSING_IMAGE' | 'CROSS_ORIGIN_IMAGE' | 'MISSING_FONT';

export interface ExportProblem {
  code: ExportProblemCode;
  message: string;
  url?: string;
  family?: string;
  objectIds: string[];
}

export interface ExportPreflight {
  ok: boolean;
  problems: ExportProblem[];
  warnings: AssetWarning[];
}

interface ImageUse {
  element: HTMLImageElement;
  objectIds: Set<string>;
}

function imageElementsOf(object: FabricObject): HTMLImageElement[] {
  const elements: unknown[] = [];
  const withElement = object as unknown as { getElement?: () => unknown };
  if (typeof withElement.getElement === 'function') elements.push(withElement.getElement());
  for (const paint of [object.fill, object.stroke]) {
    const source = (paint as { source?: unknown } | null | undefined)?.source;
    if (source !== undefined) elements.push(source);
  }
  return elements.filter((element): element is HTMLImageElement => typeof HTMLImageElement !== 'undefined' && element instanceof HTMLImageElement);
}

function collectImageUses(objects: readonly FabricObject[]): Map<string, ImageUse> {
  const uses = new Map<string, ImageUse>();
  const pending: Array<{ object: FabricObject; ownerId: string | undefined }> = objects.map((object) => ({
    object,
    ownerId: readObjectId(object),
  }));
  while (pending.length > 0) {
    const { object, ownerId } = pending.pop()!;
    const id = readObjectId(object) ?? ownerId;
    for (const element of imageElementsOf(object)) {
      const url = element.currentSrc || element.src;
      const use = uses.get(url) ?? { element, objectIds: new Set<string>() };
      if (id !== undefined) use.objectIds.add(id);
      uses.set(url, use);
    }
    childrenOf(object).forEach((child) => pending.push({ object: child, ownerId: id }));
    if (object.clipPath) pending.push({ object: object.clipPath as FabricObject, ownerId: id });
  }
  return uses;
}

function isBroken(element: HTMLImageElement): boolean {
  return element.complete && element.naturalWidth === 0;
}

function shortUrl(url: string): string {
  return url.length > 80 ? `${url.slice(0, 77)}...` : url;
}

export async function preflightExport(
  canvas: StaticCanvas,
  format: ExportFormat,
  fonts: readonly FontAsset[],
  assetOptions: AssetOptions,
): Promise<ExportPreflight> {
  const problems: ExportProblem[] = [];
  const warnings: AssetWarning[] = [];
  if (format === 'json') return { ok: true, problems, warnings };

  for (const [url, use] of collectImageUses(canvas.getObjects())) {
    const objectIds = [...use.objectIds];
    if (isBroken(use.element)) {
      problems.push({ code: 'MISSING_IMAGE', message: `The image ${shortUrl(url)} did not load`, url, objectIds });
    } else if (isRasterFormat(format) && isCrossOriginUrl(url) && !use.element.crossOrigin) {
      problems.push({
        code: 'CROSS_ORIGIN_IMAGE',
        message: `The image ${shortUrl(url)} comes from another site without crossOrigin, so the browser blocks exporting it. Load it with crossOrigin: 'anonymous' from a server that allows CORS.`,
        url,
        objectIds,
      });
    } else if (format === 'svg' && !isPortableUrl(url)) {
      warnings.push({
        code: 'ASSET_NOT_PORTABLE',
        message: `The SVG links to ${shortUrl(url)}, which only exists in this tab`,
        url,
        objectIds,
      });
    }
  }

  const fontSet = typeof document === 'undefined' ? undefined : document.fonts;
  if (fontSet) await fontSet.ready;
  for (const font of await findUnavailableFonts(fonts, assetOptions.loadFont)) {
    const message = `The font "${font.family}" (${font.weight}, ${font.style}) is not available`;
    if (assetOptions.requireFonts) {
      problems.push({ code: 'MISSING_FONT', message, family: font.family, objectIds: font.objectIds });
    } else {
      warnings.push({ code: 'FONT_UNAVAILABLE', message: `${message}, text will use a fallback font`, family: font.family, objectIds: font.objectIds });
    }
  }
  return { ok: problems.length === 0, problems, warnings };
}
