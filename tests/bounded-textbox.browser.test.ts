import { afterEach, describe, expect, it } from 'vitest';
import { StaticCanvas, Textbox, classRegistry } from 'fabric';
import { BoundedTextbox, registerTextObjects } from '../src/text';
import { replaceTextRange } from '../src';
import { inkDifference, rasterizeCanvas, rasterizeSvg } from './support/pixels';

const LONG_WORD = 'https://example.com/a/very/long/path/that/never/ends';
const canvases: StaticCanvas[] = [];

function canvasWith(...objects: Textbox[]): StaticCanvas {
  const canvas = new StaticCanvas(undefined, { width: 300, height: 300, enableRetinaScaling: false, renderOnAddRemove: false });
  canvases.push(canvas);
  canvas.add(...objects);
  canvas.renderAll();
  return canvas;
}

afterEach(async () => {
  for (const canvas of canvases.splice(0)) await canvas.dispose();
});

function inkRows(image: ImageData): [number, number] {
  let first = -1;
  let last = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4;
      if (image.data[index]! < 200) {
        if (first === -1) first = y;
        last = y;
        break;
      }
    }
  }
  return [first, last];
}

describe('BoundedTextbox keeps its width (fabric.js #2376)', () => {
  it('reproduces: a Textbox grows to its longest word', () => {
    const box = new Textbox(LONG_WORD, { width: 100, fontSize: 20 });
    expect(box.width).toBeGreaterThan(100);
  });

  it('breaks a long word between letters and keeps the width', () => {
    const box = new BoundedTextbox(`see ${LONG_WORD} here`, { width: 100, fontSize: 20 });
    expect(box.width).toBe(100);
    expect(box.textLines.length).toBeGreaterThan(3);
    for (let line = 0; line < box.textLines.length; line += 1) expect(box.getLineWidth(line)).toBeLessThanOrEqual(100.5);
    expect(box.textLines.join('').replace(/ /g, '')).toBe(`see${LONG_WORD}here`);
  });

  it('wraps Chinese and Japanese text without spaces inside the width', () => {
    const box = new BoundedTextbox('这是一个没有空格的很长很长的中文句子用来测试换行', { width: 120, fontSize: 20 });
    expect(box.width).toBe(120);
    for (let line = 0; line < box.textLines.length; line += 1) expect(box.getLineWidth(line)).toBeLessThanOrEqual(120.5);
  });

  it('maps every cursor index to the right letter across breaks inside a word', () => {
    const text = `ab ${LONG_WORD} cd\nnext ${LONG_WORD}`;
    const box = new BoundedTextbox(text, { width: 90, fontSize: 18 });
    const graphemes = [...text];
    for (let index = 0; index < graphemes.length; index += 1) {
      const { lineIndex, charIndex } = box.get2DCursorLocation(index);
      const letter = graphemes[index]!;
      if (letter === '\n' || letter === ' ') continue;
      const line = box.textLines[lineIndex]!;
      const shown = charIndex === line.length ? box.textLines[lineIndex + 1]![0] : line[charIndex];
      expect(shown).toBe(letter);
    }
  });

  it('keeps per-letter styles on the right letters after breaking', () => {
    const box = new BoundedTextbox(`x ${LONG_WORD}`, { width: 90, fontSize: 18, styles: { 0: { 30: { fill: 'red' } } } });
    const target = [...`x ${LONG_WORD}`][30];
    const { lineIndex, charIndex } = box.get2DCursorLocation(30);
    expect(box.textLines[lineIndex]![charIndex]).toBe(target);
    expect(box.getValueOfPropertyAt(lineIndex, charIndex, 'fill')).toBe('red');
    replaceTextRange(box, 0, 0, 'yy ');
    const moved = box.get2DCursorLocation(33);
    expect(box.getValueOfPropertyAt(moved.lineIndex, moved.charIndex, 'fill')).toBe('red');
  });

  it('acts like a Textbox with breakWords: never', () => {
    const box = new BoundedTextbox(LONG_WORD, { width: 100, fontSize: 20, breakWords: 'never' });
    expect(box.width).toBeGreaterThan(100);
  });

  it('shrinks text to fit maxHeight and saves the size you set', async () => {
    const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.';
    const box = new BoundedTextbox(text, { width: 160, fontSize: 40, maxHeight: 80, fit: 'shrink', minFontSize: 8 });
    expect(box.calcTextHeight()).toBeLessThanOrEqual(80);
    expect(box.fitScale).toBeLessThan(1);
    expect(box.getBaseFontSize()).toBe(40);
    const tooBig = new BoundedTextbox(text, { width: 160, fontSize: box.fontSize + 0.5 });
    expect(tooBig.calcTextHeight()).toBeGreaterThan(80);

    const saved = box.toObject();
    expect(saved.fontSize).toBe(40);
    expect(saved.type).toBe('BoundedTextbox');
    const copy = (await BoundedTextbox.fromObject(saved)) as BoundedTextbox;
    expect(copy).toBeInstanceOf(BoundedTextbox);
    expect(copy.fontSize).toBeCloseTo(box.fontSize, 5);
    expect(copy.maxHeight).toBe(80);
  });

  it('shrinks letters with their own size in step', () => {
    const box = new BoundedTextbox('big small big small big small big small', {
      width: 120,
      fontSize: 30,
      maxHeight: 60,
      fit: 'shrink',
      styles: { 0: { 0: { fontSize: 60 } } },
    });
    expect(box.fitScale).toBeLessThan(1);
    expect(box.getValueOfPropertyAt(0, 0, 'fontSize')).toBeCloseTo(60 * box.fitScale, 5);
    expect(box.calcTextHeight()).toBeLessThanOrEqual(60);
  });

  it('clips lines past maxHeight', () => {
    const box = new BoundedTextbox('one two three four five six seven eight nine ten', {
      left: 10,
      top: 10,
      originX: 'left',
      originY: 'top',
      width: 80,
      fontSize: 20,
      maxHeight: 50,
      overflow: 'clip',
    });
    expect(box.height).toBe(50);
    const [, last] = inkRows(rasterizeCanvas(canvasWith(box)));
    expect(last).toBeLessThanOrEqual(10 + 50 + 1);
  });

  it('ends the last visible line with an ellipsis, on canvas and in SVG', async () => {
    const box = new BoundedTextbox('one two three four five six seven eight nine ten', {
      left: 10,
      top: 10,
      originX: 'left',
      originY: 'top',
      width: 120,
      fontSize: 20,
      maxHeight: 50,
      overflow: 'ellipsis',
    });
    const canvas = canvasWith(box);
    const drawn = rasterizeCanvas(canvas);
    const [, last] = inkRows(drawn);
    expect(last).toBeLessThanOrEqual(10 + 50 + 1);
    const svg = canvas.toSVG();
    expect(svg).toContain('…');
    expect(svg).toContain('<clipPath id="fde-bounded-text-');
    const fromSvg = await rasterizeSvg(svg, 300, 300);
    expect(inkDifference(drawn, fromSvg)).toBeLessThan(0.08);
  });

  it('registers for loading from JSON', async () => {
    registerTextObjects();
    expect(classRegistry.getClass('BoundedTextbox')).toBe(BoundedTextbox);
    const canvas = canvasWith();
    await canvas.loadFromJSON({ objects: [new BoundedTextbox(LONG_WORD, { width: 100 }).toObject()] });
    expect(canvas.getObjects()[0]).toBeInstanceOf(BoundedTextbox);
    expect(canvas.getObjects()[0]!.width).toBe(100);
  });
});
