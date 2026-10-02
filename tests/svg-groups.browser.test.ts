import { afterEach, describe, expect, it } from 'vitest';
import { Canvas, Group, loadSVGFromString } from 'fabric';
import type { FabricObject } from 'fabric';
import { createDocumentEngine } from '../src';
import type { DocumentEngine } from '../src';
import { inkDifference, rasterizeCanvas, rasterizeSvg } from './support/pixels';

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(width = 200, height = 200): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width, height, backgroundColor: 'white' });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas });
  openEngines.push(engine);
  return engine;
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

const nested = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <defs><clipPath id="half"><rect x="0" y="0" width="100" height="200"/></clipPath></defs>
  <g id="layer" class="artboard" data-role="background" transform="translate(20 10)">
    <g id="icon" opacity="0.5" transform="rotate(10 50 50) scale(1.2)">
      <rect x="10" y="10" width="60" height="40" fill="teal"/>
      <circle id="dot" cx="80" cy="80" r="20" fill="orange"/>
    </g>
    <g id="clipped" clip-path="url(#half)">
      <rect x="40" y="110" width="120" height="50" fill="purple"/>
      <rect x="60" y="165" width="100" height="20" fill="navy"/>
    </g>
  </g>
  <path d="M150 20 L190 60 L150 60 Z" fill="crimson"/>
</svg>`;

function tree(object: FabricObject): unknown {
  const named = object as FabricObject & { svgId?: string };
  return object instanceof Group ? { group: named.svgId ?? '?', children: object.getObjects().map(tree) } : (named.svgId ?? object.type);
}

describe('SVG import keeps groups (fabric.js #899)', () => {
  it('reproduces: Fabric flattens every group and leaves inherit the group id', async () => {
    const { objects } = await loadSVGFromString(nested);
    expect(objects.every((object) => !(object instanceof Group))).toBe(true);
    expect((objects[0] as FabricObject & { id?: string }).id).toBe('icon');
  });

  it('rebuilds the group tree in document order', async () => {
    const engine = createEngine();
    const { objects } = await engine.importSvg(nested, { as: 'objects', preserveGroups: true });
    expect(objects.map(tree)).toEqual([
      { group: 'layer', children: [{ group: 'icon', children: ['rect', 'dot'] }, { group: 'clipped', children: ['rect', 'rect'] }] },
      'path',
    ]);
  });

  it('keeps ids, classes and data attributes, and takes inherited ids off the objects', async () => {
    const engine = createEngine();
    const { objects } = await engine.importSvg(nested, { as: 'objects', preserveGroups: true });
    const layer = objects[0] as Group & { svgClass?: string; svgData?: Record<string, string> };
    expect(layer.svgClass).toBe('artboard');
    expect(layer.svgData).toEqual({ role: 'background' });
    expect(engine.getObjectById('layer')).toBe(layer);
    const icon = layer.getObjects()[0] as Group;
    expect(engine.getObjectById('icon')).toBe(icon);
    const teal = icon.getObjects()[0] as FabricObject & { svgId?: string; id?: string };
    expect(teal.svgId).toBeUndefined();
    expect(teal.id).not.toBe('icon');
  });

  it('moves group opacity and clip paths onto the groups', async () => {
    const engine = createEngine();
    const { objects } = await engine.importSvg(nested, { as: 'objects', preserveGroups: true });
    const [icon, clipped] = (objects[0] as Group).getObjects() as Group[];
    expect(icon!.opacity).toBeCloseTo(0.5, 5);
    expect(icon!.getObjects().every((object) => object.opacity === 1)).toBe(true);
    expect(clipped!.clipPath).toBeDefined();
    expect(clipped!.getObjects().every((object) => object.clipPath === undefined)).toBe(true);
  });

  it('looks the same as the SVG drawn by the browser', async () => {
    for (const preserveGroups of [false, true]) {
      const engine = createEngine();
      await engine.importSvg(nested, { preserveGroups });
      engine.canvas.renderAll();
      const difference = inkDifference(rasterizeCanvas(engine.canvas), await rasterizeSvg(nested, 200, 200));
      expect(difference).toBeLessThan(0.03);
    }
  });

  it('saves and loads the groups with their metadata', async () => {
    const engine = createEngine();
    await engine.importSvg(nested, { as: 'objects', preserveGroups: true });
    const saved = engine.toDocument();
    const layer = saved.objects[0]!;
    expect(layer.svgId).toBe('layer');
    expect(layer.svgData).toEqual({ role: 'background' });
    const other = createEngine();
    await other.loadDocument(saved);
    expect((other.canvas.getObjects()[0] as Group).getObjects()).toHaveLength(2);
  });

  it('undoes the whole import in one step', async () => {
    const engine = createEngine();
    await engine.importSvg(nested, { preserveGroups: true });
    expect(engine.canvas.getObjects()).toHaveLength(1);
    await engine.undo();
    expect(engine.canvas.getObjects()).toHaveLength(0);
  });
});

describe('<use> after a broken link', () => {
  const uses = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">
    <defs><rect id="box" width="20" height="20" fill="green"/></defs>
    <use href="#missing" x="0" y="0"/>
    <use href="#box" x="10" y="10"/>
    <use xlink:href="#box" x="50" y="50"/>
  </svg>`;

  it('reproduces: Fabric stops expanding <use> at the first broken one', async () => {
    const { objects } = await loadSVGFromString(uses);
    expect(objects.filter(Boolean)).toHaveLength(0);
  });

  it('draws every <use> that points somewhere', async () => {
    const engine = createEngine(100, 100);
    const { objects } = await engine.importSvg(uses, { as: 'objects' });
    expect(objects).toHaveLength(2);
  });
});
