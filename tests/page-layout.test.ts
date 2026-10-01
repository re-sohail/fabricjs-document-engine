import { describe, expect, it } from 'vitest';
import { PAGE_SIZES, layoutPage, normalizeMargin } from '../src/pdf/page-layout';

describe('PDF page layout', () => {
  it('makes a page the size of the canvas at 96 pixels to the inch', () => {
    const layout = layoutPage({ width: 800, height: 600 });
    expect(layout).toMatchObject({ pageWidth: 600, pageHeight: 450, x: 0, y: 0, width: 600, height: 450, scale: 0.75, orientation: 'landscape' });
    expect(layout.clip).toBeUndefined();
  });

  it('adds margins around a canvas-sized page', () => {
    const layout = layoutPage({ width: 400, height: 400 }, { margin: { top: 10, left: 20 } });
    expect([layout.pageWidth, layout.pageHeight, layout.x, layout.y]).toEqual([320, 310, 20, 10]);
  });

  it('turns named pages to match the drawing unless told otherwise', () => {
    expect(layoutPage({ width: 300, height: 200 }, { page: 'A4' }).orientation).toBe('landscape');
    expect(layoutPage({ width: 200, height: 300 }, { page: 'A4' }).orientation).toBe('portrait');
    expect(layoutPage({ width: 300, height: 200 }, { page: 'A4', orientation: 'portrait' }).pageWidth).toBe(PAGE_SIZES.A4[0]);
    expect(layoutPage({ width: 200, height: 300 }, { page: 'Letter', orientation: 'landscape' }).pageWidth).toBe(792);
  });

  it('keeps custom sizes exactly as given', () => {
    const layout = layoutPage({ width: 300, height: 200 }, { page: [100, 400] });
    expect([layout.pageWidth, layout.pageHeight]).toEqual([100, 400]);
  });

  it('centres a contained drawing in the box', () => {
    const layout = layoutPage({ width: 200, height: 100 }, { page: [300, 300], margin: 50 });
    expect(layout).toMatchObject({ scale: 1, width: 200, height: 100, x: 50, y: 100 });
  });

  it('covers the box and clips to it', () => {
    const layout = layoutPage({ width: 200, height: 100 }, { page: [300, 300], margin: 50, fit: 'cover' });
    expect(layout).toMatchObject({ scale: 2, width: 400, height: 200, x: -50, y: 50 });
    expect(layout.clip).toEqual({ x: 50, y: 50, width: 200, height: 200 });
  });

  it('prints at real size from the top-left of the box', () => {
    const layout = layoutPage({ width: 96, height: 96 }, { page: 'A4', fit: 'none', margin: 36 });
    expect(layout).toMatchObject({ scale: 0.75, width: 72, height: 72, x: 36, y: 36 });
  });

  it('accepts margins as one number or per side', () => {
    expect(normalizeMargin(12)).toEqual({ top: 12, right: 12, bottom: 12, left: 12 });
    expect(normalizeMargin({ right: 5 })).toEqual({ top: 0, right: 5, bottom: 0, left: 0 });
    expect(normalizeMargin(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('survives a drawing with no size', () => {
    const layout = layoutPage({ width: 0, height: 0 }, { page: 'A4' });
    expect(Number.isFinite(layout.x)).toBe(true);
    expect(layout.width).toBe(0);
  });
});
