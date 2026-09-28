import { afterEach, describe, expect, it } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Rect } from 'fabric';
import golden from './fixtures/document-v1.json';
import fabricFive from './fixtures/fabric-v5.json';
import { createDocumentEngine, validateDocument } from '../src';
import type { DocumentEngine, FabricDocument, SerializedFabricObject } from '../src';

class Sticker extends Rect {
  static override type = 'Sticker';
  declare label: string;
}

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element);
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas, customObjects: [{ fabricClass: Sticker, properties: ['label'] }] });
  openEngines.push(engine);
  return engine;
}

function idsIn(objects: readonly SerializedFabricObject[]): string[] {
  const ids: string[] = [];
  const pending = [...objects];
  while (pending.length > 0) {
    const object = pending.shift()!;
    if (object.id) ids.push(object.id);
    pending.push(...(object.objects ?? []));
  }
  return ids;
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose().catch(() => undefined)));
  document.body.innerHTML = '';
});

describe(`frozen format contract on Fabric ${fabric.version}`, () => {
  it('opens the golden 1.0 document with every id, type and custom property', async () => {
    const engine = createEngine();
    await engine.loadDocument(structuredClone(golden));
    const reopened = engine.toDocument();

    expect(idsIn(reopened.objects)).toEqual(idsIn(golden.objects as SerializedFabricObject[]));
    expect(reopened.objects.map((object) => object.type)).toEqual(golden.objects.map((object) => object.type));
    expect(reopened).toMatchObject({ id: 'golden-v1', revision: 3, metadata: golden.metadata });
    expect((engine.canvas.getObjects()[5] as Sticker).label).toBe('Chair');
    expect(engine.canvas.getObjects()[4]?.clipPath).toBeDefined();
    expect(validateDocument(reopened)).toEqual([]);
  });

  it('writes the same object positions it read', async () => {
    const engine = createEngine();
    await engine.loadDocument(structuredClone(golden));
    const reopened = engine.toDocument();
    golden.objects.forEach((object, index) => {
      const written = reopened.objects[index]!;
      expect(written.left).toBeCloseTo(object.left as number, 3);
      expect(written.top).toBeCloseTo(object.top as number, 3);
      expect(written.angle ?? 0).toBeCloseTo((object as { angle?: number }).angle ?? 0, 3);
    });
  });

  it('opens plain Fabric 5 JSON', async () => {
    const engine = createEngine();
    const opened: FabricDocument = await engine.importFabricJson(structuredClone(fabricFive), { id: 'from-fabric-5' });
    expect(opened.schemaVersion).toBe(1);
    expect(engine.canvas.getObjects().map((object) => object.type.toLowerCase())).toEqual(['rect', 'i-text', 'textbox', 'group', 'path']);
    expect(validateDocument(engine.toDocument())).toEqual([]);
  });
});
