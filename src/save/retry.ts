export interface RetryOptions {
  attempts?: number;
  baseDelay?: number;
  maxDelay?: number;
}

interface ErrorWithSaveHints {
  code?: unknown;
  retryable?: unknown;
}

export function isRetryable(error: unknown): boolean {
  const hints = (error ?? {}) as ErrorWithSaveHints;
  if (hints.code === 'SAVE_CONFLICT' || hints.code === 'SAVE_CANCELLED') return false;
  return hints.retryable !== false;
}

export function retryDelay(attempt: number, options: RetryOptions = {}): number {
  const baseDelay = options.baseDelay ?? 500;
  const maxDelay = options.maxDelay ?? 8000;
  const ceiling = Math.min(maxDelay, baseDelay * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

export function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', stop, { once: true });
  });
}
