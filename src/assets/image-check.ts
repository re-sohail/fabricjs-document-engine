import { util } from 'fabric';
import { mapWithConcurrency } from '../util/concurrency';

export interface ImageToCheck {
  url: string;
  crossOrigin: string | null | undefined;
}

/**
 * Why an image could not be loaded. Browsers hide some details on purpose:
 * a server on another site that sends no CORS headers looks the same as a
 * network failure unless the image asked for CORS.
 */
export type ImageFailureReason = 'NOT_FOUND' | 'HTTP_ERROR' | 'CORS' | 'NETWORK' | 'TIMEOUT' | 'DECODE' | 'ABORTED';

export interface ImageLoadFailure {
  url: string;
  reason: ImageFailureReason;
  message: string;
  /** The HTTP status, when the browser lets the page read it. */
  status?: number;
  /** The time limit that ran out, for `TIMEOUT`. */
  timeoutMs?: number;
}

export interface ImageCheckOptions {
  /** Milliseconds to wait for each image. `0` waits forever. */
  timeoutMs?: number;
  /** How many images load at the same time. */
  concurrency?: number;
  /** Called after each image finishes, loaded or not. */
  onProgress?: (done: number, total: number) => void;
}

export const DEFAULT_IMAGE_TIMEOUT_MS = 30_000;
export const DEFAULT_IMAGE_CONCURRENCY = 6;

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

function shortUrl(url: string): string {
  return url.length > 80 ? `${url.slice(0, 77)}...` : url;
}

function failure(url: string, reason: ImageFailureReason, message: string, extra: Partial<ImageLoadFailure> = {}): ImageLoadFailure {
  return { url, reason, message: `The image ${shortUrl(url)} ${message}`, ...extra };
}

async function fetchHeaders(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  // Only the status matters here, so do not download the body.
  void response.body?.cancel().catch(() => undefined);
  return response;
}

/** Works out why an image failed to load, after it already failed. */
async function explainFailure(image: ImageToCheck, signal: AbortSignal): Promise<ImageLoadFailure> {
  const { url } = image;
  if (url.startsWith('data:')) return failure(url, 'DECODE', 'is embedded data the browser cannot decode as a picture');
  if (typeof fetch !== 'function') return failure(url, 'NETWORK', 'could not be loaded');

  const credentials: RequestCredentials = image.crossOrigin === 'use-credentials' ? 'include' : 'same-origin';
  try {
    const response = await fetchHeaders(url, { mode: 'cors', credentials, signal });
    if (response.ok) {
      return failure(url, 'DECODE', 'downloaded, but the browser could not decode it as a picture', {
        status: response.status,
      });
    }
    if (response.status === 404 || response.status === 410) {
      return failure(url, 'NOT_FOUND', `was not found (HTTP ${response.status})`, { status: response.status });
    }
    return failure(url, 'HTTP_ERROR', `could not be downloaded (HTTP ${response.status})`, { status: response.status });
  } catch {
    if (signal.aborted) return failure(url, 'ABORTED', 'stopped loading because the work was cancelled');
  }

  // A CORS request failed. Ask again without CORS: an answer means the
  // server is there but does not allow this page to read the image.
  if (isCrossOriginUrl(url)) {
    try {
      await fetchHeaders(url, { mode: 'no-cors', signal });
      if (image.crossOrigin) {
        return failure(
          url,
          'CORS',
          'comes from another site that does not send CORS headers (Access-Control-Allow-Origin) for this page',
        );
      }
      return failure(
        url,
        'NETWORK',
        'comes from another site that answered, but the browser hides the reason it failed. Check the URL and the server.',
      );
    } catch {
      if (signal.aborted) return failure(url, 'ABORTED', 'stopped loading because the work was cancelled');
    }
  }
  return failure(url, 'NETWORK', 'could not be reached. Check the URL and the network connection.');
}

async function checkImage(image: ImageToCheck, signal: AbortSignal, timeoutMs: number): Promise<ImageLoadFailure | undefined> {
  const attempt = new AbortController();
  let timedOut = false;
  const stop = (): void => attempt.abort();
  signal.addEventListener('abort', stop, { once: true });
  const timer =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          timedOut = true;
          attempt.abort();
        }, timeoutMs)
      : undefined;
  try {
    if (signal.aborted) attempt.abort();
    await util.loadImage(image.url, { signal: attempt.signal, crossOrigin: (image.crossOrigin ?? null) as never });
    return undefined;
  } catch {
    if (timedOut) {
      return failure(image.url, 'TIMEOUT', `did not finish loading within ${timeoutMs} ms`, { timeoutMs });
    }
    if (signal.aborted) return failure(image.url, 'ABORTED', 'stopped loading because the work was cancelled');
    return explainFailure(image, signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

/** Loads every image, a few at a time, and returns the ones that failed. */
export async function findMissingImages(
  images: readonly ImageToCheck[],
  signal: AbortSignal,
  options: ImageCheckOptions = {},
): Promise<ImageLoadFailure[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  let done = 0;
  options.onProgress?.(0, images.length);
  const results = await mapWithConcurrency(images, options.concurrency ?? DEFAULT_IMAGE_CONCURRENCY, async (image) => {
    const result = await checkImage(image, signal, timeoutMs);
    done += 1;
    options.onProgress?.(done, images.length);
    return result;
  });
  return results.filter((result): result is ImageLoadFailure => result !== undefined);
}
