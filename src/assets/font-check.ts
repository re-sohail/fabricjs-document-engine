import type { FontAsset } from './asset-manifest';

const genericFamilies = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

const fallbackFamilies = ['monospace', 'serif', 'sans-serif'];
const sampleText = 'mmmmmmmmmmlli WwQq 0123456789';

export type FontLoader = (font: FontAsset) => void | Promise<void>;

function firstFamily(family: string): string {
  return (family.split(',')[0] ?? family).trim().replace(/^["']|["']$/g, '');
}

function cssFamily(family: string): string {
  return genericFamilies.has(family.toLowerCase()) ? family : `"${family.replace(/"/g, '\\"')}"`;
}

export function fontDescriptor(font: Pick<FontAsset, 'family' | 'weight' | 'style'>, size = 32): string {
  return `${font.style} ${font.weight} ${size}px ${cssFamily(firstFamily(font.family))}`;
}

function createMeasuringContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  return document.createElement('canvas').getContext('2d');
}

export function isFontRenderable(font: Pick<FontAsset, 'family' | 'weight' | 'style'>, context: CanvasRenderingContext2D | null = createMeasuringContext()): boolean {
  const family = firstFamily(font.family);
  if (context === null || genericFamilies.has(family.toLowerCase())) return true;
  return fallbackFamilies.some((fallback) => {
    context.font = `${font.style} ${font.weight} 72px ${fallback}`;
    const fallbackWidth = context.measureText(sampleText).width;
    context.font = `${font.style} ${font.weight} 72px ${cssFamily(family)}, ${fallback}`;
    return context.measureText(sampleText).width !== fallbackWidth;
  });
}

async function prepareFont(font: FontAsset, loadFont: FontLoader | undefined): Promise<void> {
  if (loadFont) await loadFont(font);
  const fontSet = typeof document === 'undefined' ? undefined : document.fonts;
  if (fontSet) await fontSet.load(fontDescriptor(font), sampleText);
}

export async function findUnavailableFonts(fonts: readonly FontAsset[], loadFont?: FontLoader): Promise<FontAsset[]> {
  await Promise.allSettled(fonts.map((font) => prepareFont(font, loadFont)));
  const context = createMeasuringContext();
  return fonts.filter((font) => !isFontRenderable(font, context));
}
