export const PIXEL_FILTERS: ReadonlySet<string> = new Set([
  'Brightness',
  'Contrast',
  'Saturation',
  'Vibrance',
  'Grayscale',
  'Invert',
  'Gamma',
  'Noise',
  'RemoveColor',
  'BlendColor',
  'HueRotation',
  'ColorMatrix',
  'Sepia',
  'Brownie',
  'Vintage',
  'Kodachrome',
  'Technicolor',
  'Polaroid',
  'BlackWhite',
]);

export const WORKER_FILTERS: ReadonlySet<string> = new Set([...PIXEL_FILTERS, 'Blur', 'Convolute', 'Pixelate']);

export interface PipelineFilter {
  type: string;
  applyTo2d(state: PipelineState): void;
  isNeutralState?(): boolean;
  subFilters?: PipelineFilter[];
}

export interface PipelineState {
  sourceWidth: number;
  sourceHeight: number;
  imageData: ImageData;
  originalImageData: ImageData;
  originalEl: unknown;
  canvasEl: unknown;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  filterBackend: unknown;
}

export interface PipelineOptions {
  bandRows?: number;
  onProgress?: (done: number) => void;
  isCancelled?: () => boolean;
  pause?: () => Promise<void>;
}

function typeOf(filter: { type?: unknown; constructor?: { type?: unknown } }): string {
  const own = filter.type ?? filter.constructor?.type;
  return typeof own === 'string' ? own : '';
}

export function flattenFilters<Filter extends { type?: unknown; subFilters?: Filter[] }>(filters: readonly Filter[]): Filter[] {
  const flat: Filter[] = [];
  const visit = (filter: Filter): void => {
    if (typeOf(filter as never) === 'Composed') (filter.subFilters ?? []).forEach(visit);
    else flat.push(filter);
  };
  filters.forEach(visit);
  return flat;
}

export function canRunInWorker(filters: ReadonlyArray<{ type?: unknown; subFilters?: unknown[] }>): boolean {
  return flattenFilters(filters as Array<{ type?: unknown; subFilters?: never[] }>).every((filter) => WORKER_FILTERS.has(typeOf(filter as never)));
}

export async function runFilterPipeline(filters: readonly PipelineFilter[], state: PipelineState, options: PipelineOptions = {}): Promise<ImageData | undefined> {
  const steps: PipelineFilter[][] = [];
  for (const filter of flattenFilters(filters)) {
    if (filter.isNeutralState?.()) continue;
    const last = steps[steps.length - 1];
    const pixelwise = PIXEL_FILTERS.has(typeOf(filter as never));
    if (pixelwise && last && PIXEL_FILTERS.has(typeOf(last[0] as never))) last.push(filter);
    else steps.push([filter]);
  }
  const bandRows = Math.max(1, Math.floor(options.bandRows ?? 64));
  const units = steps.reduce((sum, step) => sum + (PIXEL_FILTERS.has(typeOf(step[0] as never)) ? Math.ceil(state.imageData.height / bandRows) : 1), 0);
  let done = 0;
  const advance = async (): Promise<boolean> => {
    done += 1;
    options.onProgress?.(units === 0 ? 1 : done / units);
    if (options.isCancelled?.()) return false;
    await options.pause?.();
    return !options.isCancelled?.();
  };

  for (const step of steps) {
    if (!PIXEL_FILTERS.has(typeOf(step[0] as never))) {
      step[0]!.applyTo2d(state);
      if (!(await advance())) return undefined;
      continue;
    }
    const whole = state.imageData;
    const rowBytes = whole.width * 4;
    for (let row = 0; row < whole.height; row += bandRows) {
      const rows = Math.min(bandRows, whole.height - row);
      const band = new ImageData(new Uint8ClampedArray(whole.data.buffer, whole.data.byteOffset + row * rowBytes, rows * rowBytes), whole.width, rows);
      const bandState: PipelineState = { ...state, imageData: band, sourceHeight: rows };
      for (const filter of step) filter.applyTo2d(bandState);
      if (!(await advance())) return undefined;
    }
  }
  if (units === 0) options.onProgress?.(1);
  return state.imageData;
}
