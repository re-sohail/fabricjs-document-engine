import { DocumentEngineError } from '../engine/errors';

export type PdfFontStyle = 'normal' | 'italic';

export interface PdfFont {
  /** The font family exactly as the canvas uses it, such as `Inter`. */
  family: string;
  /** A TrueType (.ttf) file: its URL, or its bytes. */
  source: string | ArrayBuffer | Uint8Array | Blob;
  /** `normal` or `bold`, or a number such as 700. Weights from 600 count as bold. Default `normal`. */
  weight?: 'normal' | 'bold' | number;
  style?: PdfFontStyle;
}

type JsPdfStyle = 'normal' | 'bold' | 'italic' | 'bolditalic';

const STANDARD: Record<string, string> = {
  helvetica: 'helvetica',
  'helvetica neue': 'helvetica',
  arial: 'helvetica',
  verdana: 'helvetica',
  'sans-serif': 'helvetica',
  'system-ui': 'helvetica',
  times: 'times',
  'times new roman': 'times',
  georgia: 'times',
  serif: 'times',
  courier: 'courier',
  'courier new': 'courier',
  monospace: 'courier',
};

/** Families the built-in PDF fonts can stand in for. They cover Latin-1 letters only. */
export function standardFamily(family: string): string | undefined {
  return STANDARD[family.trim().replace(/^['"]|['"]$/g, '').toLowerCase()];
}

function isBold(weight: unknown): boolean {
  if (weight === 'bold' || weight === 'bolder') return true;
  const number = Number(weight);
  return Number.isFinite(number) && number >= 600;
}

export function jsPdfStyle(weight: unknown, style: unknown): JsPdfStyle {
  const bold = isBold(weight);
  const italic = style === 'italic' || style === 'oblique';
  return bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal';
}

async function bytesOf(source: PdfFont['source'], signal?: AbortSignal): Promise<Uint8Array> {
  if (typeof source === 'string') {
    const response = await fetch(source, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${source}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(await source.arrayBuffer());
}

function binaryString(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return binary;
}

function refuseFormat(family: string, bytes: Uint8Array): void {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  const kind = tag === 'wOF2' ? 'WOFF2' : tag === 'wOFF' ? 'WOFF' : tag === 'OTTO' ? 'OpenType with CFF outlines' : undefined;
  if (kind) {
    throw new DocumentEngineError(
      'PDF_FAILED',
      `The font "${family}" is ${kind}. PDF export needs a TrueType (.ttf) file, which most font sites offer next to the web formats.`,
    );
  }
}

export interface LoadedFont {
  family: string;
  style: JsPdfStyle;
  binary: string;
}

/** Downloads every font once, so each PDF document can register them without fetching again. */
export async function loadFonts(fonts: readonly PdfFont[], signal?: AbortSignal): Promise<LoadedFont[]> {
  return Promise.all(
    fonts.map(async (font) => {
      let bytes: Uint8Array;
      try {
        bytes = await bytesOf(font.source, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new DocumentEngineError('PDF_FAILED', `The font "${font.family}" could not be read: ${reason}`, { cause: error });
      }
      refuseFormat(font.family, bytes);
      return { family: font.family, style: jsPdfStyle(font.weight ?? 'normal', font.style ?? 'normal'), binary: binaryString(bytes) };
    }),
  );
}

export interface RegisteredFonts {
  /** Lower-case family to the name it was registered under. */
  families: Map<string, string>;
  /** Styles that use another style's file, because no file was given for them. */
  substituted: Array<{ family: string; style: JsPdfStyle }>;
}

/**
 * Adds the fonts to a jsPDF document. A style with no file of its own uses
 * the closest one given, so bold text in a family with only a regular file
 * stays in that family instead of falling back to Times.
 */
export function registerFonts(
  document: { addFileToVFS(name: string, data: string): unknown; addFont(file: string, family: string, style: string): unknown },
  fonts: readonly LoadedFont[],
): RegisteredFonts {
  const families = new Map<string, string>();
  const byFamily = new Map<string, Map<JsPdfStyle, LoadedFont>>();
  fonts.forEach((font) => {
    const styles = byFamily.get(font.family) ?? new Map<JsPdfStyle, LoadedFont>();
    styles.set(font.style, font);
    byFamily.set(font.family, styles);
  });
  const substituted: RegisteredFonts['substituted'] = [];
  let fileNumber = 0;
  for (const [family, styles] of byFamily) {
    families.set(family.toLowerCase(), family);
    for (const style of ['normal', 'bold', 'italic', 'bolditalic'] as const) {
      const own = styles.get(style);
      const font =
        own ??
        styles.get(style === 'bolditalic' ? 'bold' : 'normal') ??
        styles.get('normal') ??
        styles.get('bold') ??
        styles.get('italic') ??
        styles.get('bolditalic')!;
      if (!own) substituted.push({ family, style });
      const fileName = `font-${fileNumber++}.ttf`;
      document.addFileToVFS(fileName, font.binary);
      document.addFont(fileName, family, style);
    }
  }
  return { families, substituted };
}
