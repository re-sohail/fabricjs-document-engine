/** Page sizes in PDF points (1/72 inch), portrait. */
export const PAGE_SIZES: Readonly<Record<NamedPageSize, readonly [number, number]>> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
};

export type NamedPageSize = 'A3' | 'A4' | 'A5' | 'Letter' | 'Legal' | 'Tabloid';

/** A named size, `canvas` for a page the size of the canvas, or `[width, height]` in points. */
export type PdfPageSize = NamedPageSize | 'canvas' | readonly [number, number];

export type PdfOrientation = 'portrait' | 'landscape' | 'auto';

export type PdfFit = 'contain' | 'cover' | 'none';

export interface PdfMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** One CSS pixel is 1/96 inch, and a PDF point 1/72 inch. */
export const POINTS_PER_PIXEL = 0.75;

export interface PageLayoutOptions {
  page?: PdfPageSize;
  orientation?: PdfOrientation;
  margin?: number | Partial<PdfMargin>;
  fit?: PdfFit;
}

export interface PageLayout {
  pageWidth: number;
  pageHeight: number;
  orientation: 'portrait' | 'landscape';
  /** Where the canvas is drawn, in points. It can be larger than the page with `cover`. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Points per canvas pixel. */
  scale: number;
  /** The box inside the margins, set when the drawing must be clipped to it. */
  clip?: { x: number; y: number; width: number; height: number };
}

export function normalizeMargin(margin: number | Partial<PdfMargin> | undefined): PdfMargin {
  if (margin === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof margin === 'number') return { top: margin, right: margin, bottom: margin, left: margin };
  return { top: margin.top ?? 0, right: margin.right ?? 0, bottom: margin.bottom ?? 0, left: margin.left ?? 0 };
}

function pageSizeFor(page: PdfPageSize, content: { width: number; height: number }, margin: PdfMargin): [number, number] {
  if (page === 'canvas') {
    return [content.width * POINTS_PER_PIXEL + margin.left + margin.right, content.height * POINTS_PER_PIXEL + margin.top + margin.bottom];
  }
  if (Array.isArray(page)) return [page[0], page[1]];
  return [...PAGE_SIZES[page as NamedPageSize]];
}

/**
 * Where a canvas of `content` pixels goes on the page. `contain` shows all of
 * it as large as fits, `cover` fills the box and crops, and `none` prints it
 * at its real size (96 pixels to the inch) from the top-left of the box.
 */
export function layoutPage(content: { width: number; height: number }, options: PageLayoutOptions = {}): PageLayout {
  const margin = normalizeMargin(options.margin);
  const page = options.page ?? 'canvas';
  let [pageWidth, pageHeight] = pageSizeFor(page, content, margin);
  const wantsLandscape =
    options.orientation === 'landscape' || (options.orientation !== 'portrait' && page !== 'canvas' && !Array.isArray(page) && content.width > content.height);
  if (page !== 'canvas' && !Array.isArray(page) && wantsLandscape !== pageWidth > pageHeight) {
    [pageWidth, pageHeight] = [pageHeight, pageWidth];
  }
  const box = {
    x: margin.left,
    y: margin.top,
    width: Math.max(0, pageWidth - margin.left - margin.right),
    height: Math.max(0, pageHeight - margin.top - margin.bottom),
  };
  const fit = options.fit ?? 'contain';
  const scaleX = content.width > 0 ? box.width / content.width : 1;
  const scaleY = content.height > 0 ? box.height / content.height : 1;
  const scale = fit === 'none' ? POINTS_PER_PIXEL : fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  const width = content.width * scale;
  const height = content.height * scale;
  const centered = fit !== 'none';
  const layout: PageLayout = {
    pageWidth,
    pageHeight,
    orientation: pageWidth > pageHeight ? 'landscape' : 'portrait',
    x: centered ? box.x + (box.width - width) / 2 : box.x,
    y: centered ? box.y + (box.height - height) / 2 : box.y,
    width,
    height,
    scale,
  };
  if (width > box.width + 0.01 || height > box.height + 0.01) layout.clip = box;
  return layout;
}
