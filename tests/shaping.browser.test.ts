import { afterEach, describe, expect, it } from 'vitest';
import { Canvas, IText } from 'fabric';
import type { ITextProps } from 'fabric';
import { BoundedTextbox, ShapedIText, ShapedTextbox } from '../src/text';

const ARABIC = 'مرحبا بالعالم العربي الجميل';
const open: Canvas[] = [];

afterEach(async () => {
  for (const canvas of open.splice(0)) await canvas.dispose();
});

const options: Partial<ITextProps> = { fontSize: 40, fontFamily: 'sans-serif', direction: 'rtl' as const, textAlign: 'right', originX: 'right' as const, originY: 'top' as const, left: 560, top: 20 };

function wordEnds(text: string): number[] {
  return [...text].flatMap((letter, index) => (letter === ' ' ? [index] : []));
}

function inkColumns(image: ImageData, red: boolean): boolean[] {
  const columns = new Array<boolean>(image.width).fill(false);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4;
      const inked = image.data[at + 3]! > 100 && (!red || (image.data[at]! > 150 && image.data[at + 1]! < 100));
      if (inked) columns[x] = true;
    }
  }
  return columns;
}

function cursorsInGaps(make: (text: string) => IText): Array<{ index: number; middle: number; inked: boolean }> {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 600, height: 100, enableRetinaScaling: false });
  open.push(canvas);
  const text = make(ARABIC);
  text.set({ cursorColor: 'rgb(255,0,0)', cursorWidth: 1 });
  canvas.add(text);
  canvas.renderAll();
  const ink = inkColumns(canvas.getContext().getImageData(0, 0, 600, 100), false);
  text.enterEditing();
  const caretAt = (index: number): number => {
    text.setSelectionStart(index);
    text.setSelectionEnd(index);
    (text as unknown as { cursorOffsetCache: object; _currentCursorOpacity: number }).cursorOffsetCache = {};
    (text as unknown as { _currentCursorOpacity: number })._currentCursorOpacity = 1;
    canvas.clearContext(canvas.contextTop);
    text.renderCursorOrSelection();
    const columns = inkColumns(canvas.contextTop.getImageData(0, 0, 600, 100), true);
    const xs = columns.flatMap((on, x) => (on ? [x] : []));
    return (xs[0]! + xs[xs.length - 1]!) / 2;
  };
  const result = [...ARABIC].flatMap((letter, index) => {
    if (letter !== ' ') return [];
    const middle = Math.round((caretAt(index) + caretAt(index + 1)) / 2);
    return [{ index, middle, inked: ink[middle - 1]! || ink[middle]! || ink[middle + 1]! }];
  });
  text.exitEditing();
  return result;
}

describe('cursor positions follow joined letters (fabric.js #4815)', () => {
  it('reproduces: IText letter positions drift from the drawn Arabic text', () => {
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = 'normal normal 400px sans-serif';
    const text = new IText(ARABIC, { fontSize: 40, fontFamily: 'sans-serif' });
    text.getLineWidth(0);
    const bounds = (text as unknown as { __charBounds: Array<Array<{ left: number }>> }).__charBounds[0]!;
    const letters = [...ARABIC];
    const drift = letters.map((_, index) => Math.abs(bounds[index]!.left - context.measureText(letters.slice(0, index).join('')).width / 10));
    expect(Math.max(...drift)).toBeGreaterThan(5);
  });

  it.runIf(!navigator.userAgent.includes('Firefox'))('reproduces: the IText cursor around a space lands inside a word', () => {
    expect(cursorsInGaps((text) => new IText(text, options)).some((gap) => gap.inked)).toBe(true);
  });

  it('ShapedIText puts the cursors around each space in the gap between words', () => {
    expect(cursorsInGaps((text) => new ShapedIText(text, options))).toEqual(
      wordEnds(ARABIC).map((index) => expect.objectContaining({ index, inked: false })),
    );
  });

  it('measures lines as the browser draws them', () => {
    const context = document.createElement('canvas').getContext('2d')!;
    for (const [text, fontFamily] of [
      [ARABIC, 'sans-serif'],
      ['office affluent fifty AVATAR', 'serif'],
    ] as const) {
      const shaped = new ShapedIText(text, { fontSize: 40, fontFamily });
      context.font = `normal normal 400px ${fontFamily}`;
      expect(Math.abs(shaped.getLineWidth(0) - context.measureText(text).width / 10)).toBeLessThan(0.5);
    }
  });

  it('keeps per-letter positions increasing and styles in separate runs', () => {
    const shaped = new ShapedIText('ffi ffi', { fontSize: 40, fontFamily: 'serif', styles: { 0: { 4: { fill: 'red' } } } });
    shaped.getLineWidth(0);
    const bounds = (shaped as unknown as { __charBounds: Array<Array<{ left: number }>> }).__charBounds[0]!;
    for (let index = 1; index < bounds.length; index += 1) expect(bounds[index]!.left).toBeGreaterThanOrEqual(bounds[index - 1]!.left);
  });

  it('leaves text with letter spacing, justify or a path as Fabric measures it', () => {
    for (const extra of [{ charSpacing: 200 }, { textAlign: 'justify' }] as Array<Partial<ITextProps>>) {
      const plain = new IText(ARABIC, { fontSize: 40, ...extra });
      const shaped = new ShapedIText(ARABIC, { fontSize: 40, ...extra });
      expect(shaped.getLineWidth(0)).toBeCloseTo(plain.getLineWidth(0), 5);
    }
  });

  it('wraps a ShapedTextbox by the shaped width', () => {
    const shaped = new ShapedTextbox(ARABIC, { width: 200, fontSize: 40, direction: 'rtl' });
    for (let line = 0; line < shaped.textLines.length; line += 1) expect(shaped.getLineWidth(line)).toBeLessThanOrEqual(200.5);
  });

  it('is an option on BoundedTextbox and survives saving', async () => {
    const bounded = new BoundedTextbox(ARABIC, { width: 900, fontSize: 40, shaping: true });
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = 'normal normal 40px Times New Roman';
    expect(Math.abs(bounded.getLineWidth(0) - context.measureText(ARABIC).width)).toBeLessThan(0.5);
    const copy = (await BoundedTextbox.fromObject(bounded.toObject())) as BoundedTextbox;
    expect(copy.shaping).toBe(true);
    const shaped = await ShapedIText.fromObject(new ShapedIText('x').toObject());
    expect(shaped).toBeInstanceOf(ShapedIText);
  });
});
