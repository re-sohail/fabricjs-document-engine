import { afterEach, describe, expect, it } from 'vitest';
import { Canvas, IText, Point, StaticCanvas, util } from 'fabric';
import { Orientation, VerticalText, orientationOf, registerTextObjects } from '../src/text';
import { inkDifference, rasterizeCanvas, rasterizeSvg } from './support/pixels';

const open: Array<StaticCanvas | Canvas> = [];

afterEach(async () => {
  for (const canvas of open.splice(0)) await canvas.dispose();
});

function staticCanvas(...objects: IText[]): StaticCanvas {
  const canvas = new StaticCanvas(undefined, { width: 300, height: 300, enableRetinaScaling: false, renderOnAddRemove: false });
  open.push(canvas);
  canvas.add(...objects);
  canvas.renderAll();
  return canvas;
}

function interactive(text: IText): Canvas {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 300, height: 300, enableRetinaScaling: false });
  open.push(canvas);
  canvas.add(text);
  canvas.setActiveObject(text);
  return canvas;
}

const LINE_BOX = 40 * 1.13;

function inkBox(image: ImageData, byAlpha = false): { left: number; top: number; right: number; bottom: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4;
      if (byAlpha ? image.data[at + 3]! > 100 : image.data[at]! < 200) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return { left, top, right, bottom };
}

const placed = { left: 20, top: 20, originX: 'left' as const, originY: 'top' as const, fontSize: 40, fill: '#000' };

describe('vertical text (fabric.js #511)', () => {
  it('reproduces: Fabric lays CJK text out in a row only', () => {
    const text = new IText('縦書きの文章', { fontSize: 40 });
    expect(text.width).toBeGreaterThan(text.height * 3);
  });

  it('stands CJK characters in a column, one square each', () => {
    const text = new VerticalText('縦書きの文章', { fontSize: 40 });
    expect(text.height).toBeCloseTo(240, 5);
    expect(text.width).toBeCloseTo(LINE_BOX, 5);
    const ink = inkBox(rasterizeCanvas(staticCanvas(new VerticalText('縦書きの文章', placed))));
    expect(ink.bottom - ink.top).toBeGreaterThan(200);
    expect(ink.right - ink.left).toBeLessThan(LINE_BOX);
  });

  it('places lines as columns from right to left', () => {
    const text = new VerticalText('一二三\n四五', { ...placed, lineHeight: 1.5 });
    expect(text.width).toBeCloseTo(LINE_BOX * 1.5 + LINE_BOX, 5);
    expect(text.height).toBeCloseTo(120, 5);
    const first = inkBox(rasterizeCanvas(staticCanvas(new VerticalText('一二三\n', { ...placed, lineHeight: 1.5 }))));
    expect(first.left).toBeGreaterThan(20 + LINE_BOX * 1.5);
  });

  it('turns Latin runs and keeps their measured width', () => {
    const text = new VerticalText('ABCあ', { fontSize: 40 });
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = 'normal normal 400px Times New Roman';
    expect(text.height).toBeCloseTo(context.measureText('ABC').width / 10 + 40, 0);
    const upright = new VerticalText('ABCあ', { fontSize: 40, textOrientation: 'upright' });
    expect(upright.height).toBeCloseTo(160, 5);
  });

  it('classifies characters by UAX #50', () => {
    expect(orientationOf('あ')).toBe(Orientation.Upright);
    expect(orientationOf('漢')).toBe(Orientation.Upright);
    expect(orientationOf('한')).toBe(Orientation.Upright);
    expect(orientationOf('😀')).toBe(Orientation.Upright);
    expect(orientationOf('𠀋')).toBe(Orientation.Upright);
    expect(orientationOf('A')).toBe(Orientation.Rotated);
    expect(orientationOf('「')).toBe(Orientation.Rotated);
    expect(orientationOf('ー')).toBe(Orientation.Rotated);
    expect(orientationOf('（')).toBe(Orientation.Rotated);
    expect(orientationOf('、')).toBe(Orientation.UprightShifted);
    expect(orientationOf('。')).toBe(Orientation.UprightShifted);
    expect(orientationOf('ゃ')).toBe(Orientation.Upright);
  });

  it('sets two digits side by side in one square with combineUpright', () => {
    const text = new VerticalText('令和12年', { fontSize: 40, combineUpright: 'digits2' });
    expect(text.height).toBeCloseTo(40 * 4, 5);
    const long = new VerticalText('令和123年', { fontSize: 40, combineUpright: 'digits2' });
    expect(long.height).toBeLessThan(40 * 5);
  });

  it('exports SVG that looks like the canvas', async () => {
    const text = new VerticalText('縦書き、ABCの「文章」。\n二行目です', { ...placed, fontSize: 30, styles: { 1: { 0: { fill: 'red', underline: true } } } });
    const canvas = staticCanvas(text);
    const drawn = rasterizeCanvas(canvas);
    const svg = canvas.toSVG();
    expect(svg).toContain('rotate(90)');
    const fromSvg = await rasterizeSvg(svg, 300, 300);
    expect(inkDifference(drawn, fromSvg)).toBeLessThan(0.06);
  });

  it('finds the character under the pointer, by column and then down it', () => {
    const text = new VerticalText('一二三四\n五六七', { ...placed, lineHeight: 1.2 });
    const canvas = interactive(text);
    const rect = canvas.upperCanvasEl.getBoundingClientRect();
    const matrix = text.calcTransformMatrix();
    const boundsOf = (text as unknown as { __charBounds: Array<Array<{ left: number }>> }).__charBounds;
    const columnCenters = [text.width / 2 - LINE_BOX / 2, text.width / 2 - LINE_BOX * 1.2 - LINE_BOX / 2];
    let index = 0;
    text.textLines.forEach((line, lineIndex) => {
      for (let char = 0; char <= line.length; char += 1) {
        const local = new Point(columnCenters[lineIndex]!, -text.height / 2 + boundsOf[lineIndex]![char]!.left + 3);
        const scene = local.transform(matrix);
        const event = new MouseEvent('mousedown', { clientX: rect.left + scene.x, clientY: rect.top + scene.y });
        expect(text.getSelectionStartFromPointer(event)).toBe(index + char);
      }
      index += line.length + 1;
    });
  });

  it('moves the cursor down with ↓ and to the next column with ←', () => {
    const text = new VerticalText('一二三\n四五六', placed);
    interactive(text);
    text.enterEditing();
    text.setSelectionStart(1);
    text.setSelectionEnd(1);
    const press = (keyCode: number): void => text.onKeyDown(new KeyboardEvent('keydown', { keyCode } as KeyboardEventInit));
    press(40);
    expect(text.selectionStart).toBe(2);
    press(38);
    expect(text.selectionStart).toBe(1);
    press(37);
    expect(text.selectionStart).toBe(5);
    press(39);
    expect(text.selectionStart).toBe(1);
    text.exitEditing();
  });

  it('draws the cursor as a bar across the column', () => {
    const text = new VerticalText('一二三', { ...placed, cursorColor: 'rgb(255,0,0)', cursorWidth: 2 });
    const canvas = interactive(text);
    text.enterEditing();
    text.setSelectionStart(1);
    text.setSelectionEnd(1);
    (text as unknown as { _currentCursorOpacity: number })._currentCursorOpacity = 1;
    canvas.clearContext(canvas.contextTop);
    text.renderCursorOrSelection();
    const box = inkBox(canvas.contextTop.getImageData(0, 0, 300, 300), true);
    expect(box.right - box.left).toBeGreaterThan(30);
    expect(box.bottom - box.top).toBeLessThan(4);
    expect((box.top + box.bottom) / 2).toBeCloseTo(20 + 40, -1);
    text.exitEditing();
  });

  it('takes typing from the keyboard and IME like any IText', () => {
    const text = new VerticalText('一三', placed);
    interactive(text);
    text.enterEditing();
    text.setSelectionStart(1);
    text.setSelectionEnd(1);
    const textarea = text.hiddenTextarea!;
    textarea.value = '一二三';
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }));
    expect(text.text).toBe('一二三');
    expect(text.height).toBeCloseTo(120, 5);
    text.exitEditing();
  });

  it('saves and loads', async () => {
    registerTextObjects();
    const text = new VerticalText('縦書き', { fontSize: 30, combineUpright: 'digits2', textOrientation: 'upright' });
    const saved = text.toObject();
    expect(saved.type).toBe('VerticalText');
    const copy = (await util.enlivenObjects([saved]))[0] as VerticalText;
    expect(copy).toBeInstanceOf(VerticalText);
    expect(copy.combineUpright).toBe('digits2');
    expect(copy.textOrientation).toBe('upright');
    expect(copy.height).toBeCloseTo(90, 5);
  });
});
