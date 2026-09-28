import { util } from 'fabric';

export interface ImageToCheck {
  url: string;
  crossOrigin: string | null | undefined;
}

export function isCrossOriginUrl(url: string): boolean {
  const location = (globalThis as { location?: Location }).location;
  if (!location || url.startsWith('data:') || url.startsWith('blob:')) return false;
  try {
    const parsed = new URL(url, location.href);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin !== location.origin;
  } catch {
    return false;
  }
}

export function isPortableUrl(url: string): boolean {
  return !url.startsWith('blob:');
}

export function isSameUrl(first: string, second: string): boolean {
  if (first === second) return true;
  const location = (globalThis as { location?: Location }).location;
  try {
    return new URL(first, location?.href).href === new URL(second, location?.href).href;
  } catch {
    return false;
  }
}

export async function findMissingImages(images: readonly ImageToCheck[], signal: AbortSignal): Promise<string[]> {
  const results = await Promise.allSettled(
    images.map((image) => util.loadImage(image.url, { signal, crossOrigin: (image.crossOrigin ?? null) as never })),
  );
  return images.filter((_, index) => results[index]!.status === 'rejected').map((image) => image.url);
}
