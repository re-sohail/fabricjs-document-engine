export interface AutosaveOptions {
  delay?: number;
  maxWait?: number;
}

export interface AutosaveScheduler {
  schedule(): void;
  cancel(): void;
}

export function createAutosaveScheduler(run: () => void, options: AutosaveOptions = {}): AutosaveScheduler {
  const delay = options.delay ?? 1000;
  const maxWait = Math.max(delay, options.maxWait ?? 10000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstRequestAt: number | undefined;

  function cancel(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    firstRequestAt = undefined;
  }

  function fire(): void {
    cancel();
    run();
  }

  return {
    schedule() {
      const now = Date.now();
      firstRequestAt ??= now;
      const timeLeftBeforeMaxWait = maxWait - (now - firstRequestAt);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(delay, timeLeftBeforeMaxWait)));
    },
    cancel,
  };
}
