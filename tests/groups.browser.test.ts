import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import * as fabric from 'fabric';
import { Canvas, Circle, FixedLayout, Group, LayoutManager, Rect, Textbox } from 'fabric';
import type { FabricObject } from 'fabric';
import { createDocumentEngine } from '../src';
import type { DocumentEngine, FabricDocument } from '../src';

/**
 * Groups saved on one Fabric version must reopen with every object in the
 * same place and with the same visibility, on the same and on the other
 * version, and must stay in place after they are ungrouped (fabric.js #11016).
 *
 * The fixtures in tests/fixtures/groups were written by each Fabric version.
 * Delete one and run that version's project to write it again after
 * changing the scenes.
 */

interface Expected {
  matrix: number[];
  visible: boolean;
  /** Every group above this object is visible too. */
  shown: boolean;
}

interface GroupFixture {
  fabricVersion: string;
  document: FabricDocument;
  expected: Record<string, Expected>;
}

const MAJOR = fabric.version.split('.')[0]!;
const FIXTURE_VERSIONS = ['6', '7'];
const fixturePath = (major: string): string => `tests/fixtures/groups/fabric-${major}.json`;

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 600, height: 400 });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas });
  openEngines.push(engine);
  return engine;
}

function named<Object extends FabricObject>(id: string, object: Object): Object {
  (object as unknown as { id: string }).id = id;
  return object;
}

function idOf(object: FabricObject): string {
  return (object as unknown as { id: string }).id;
}

function childrenOf(object: FabricObject): FabricObject[] {
  return object instanceof Group ? object.getObjects() : [];
}

/** The scenes from the report and the cases around it. */
function buildScenes(): FabricObject[] {
  const deep = named(
    'deep',
    new Group(
      [
        named(
          'deep-middle',
          new Group(
            [
              named(
                'deep-inner',
                new Group(
                  [
                    named('deep-leaf-a', new Rect({ left: 0, top: 0, width: 20, height: 10, fill: 'red', angle: 25 })),
                    named('deep-leaf-b', new Circle({ left: 30, top: 10, radius: 6, fill: 'blue', scaleY: 2 })),
                  ],
                  { angle: 15, skewY: 8 },
                ),
              ),
              named('deep-side', new Rect({ left: 60, top: 40, width: 15, height: 15, fill: 'green', flipY: true })),
            ],
            { scaleX: 1.3, angle: -10 },
          ),
        ),
        named('deep-text', new Textbox('Label', { left: 0, top: 80, width: 80, fontSize: 14 })),
      ],
      { left: 80, top: 60, angle: 35, scaleX: 0.75, scaleY: 1.2, skewX: 12, flipX: true },
    ),
  );

  const hidden = named(
    'hidden',
    new Group(
      [
        named('hidden-shown', new Rect({ left: 0, top: 0, width: 20, height: 20, fill: 'orange' })),
        named('hidden-child', new Rect({ left: 30, top: 0, width: 20, height: 20, fill: 'purple', visible: false })),
        named(
          'hidden-subgroup',
          new Group([named('hidden-subgroup-leaf', new Circle({ left: 0, top: 30, radius: 8 }))], { visible: false }),
        ),
      ],
      { left: 320, top: 40, angle: 90 },
    ),
  );

  const clippedChild = named('clipped-child', new Rect({ left: 0, top: 0, width: 60, height: 40, fill: 'teal' }));
  clippedChild.clipPath = new Circle({ radius: 15, originX: 'center', originY: 'center' });
  const clipped = named(
    'clipped',
    new Group([clippedChild, named('clipped-other', new Rect({ left: 70, top: 0, width: 20, height: 40, fill: 'navy' }))], {
      left: 420,
      top: 200,
      scaleX: 1.5,
      angle: -30,
    }),
  );
  clipped.clipPath = new Rect({ width: 80, height: 30, originX: 'center', originY: 'center' });

  const fixed = named(
    'fixed',
    new Group(
      [
        named('fixed-inside', new Rect({ left: 10, top: 10, width: 20, height: 20, fill: 'gold' })),
        named('fixed-outside', new Rect({ left: 200, top: 150, width: 20, height: 20, fill: 'brown' })),
      ],
      { layoutManager: new LayoutManager(new FixedLayout()), width: 100, height: 100, left: 60, top: 260, angle: 20 },
    ),
  );

  const empty = named('empty', new Group([], { left: 500, top: 30 }));

  return [deep, hidden, clipped, fixed, empty];
}

function describeTree(roots: readonly FabricObject[]): Record<string, Expected> {
  const expected: Record<string, Expected> = {};
  const visit = (object: FabricObject, parentShown: boolean): void => {
    const shown = parentShown && object.visible !== false;
    expected[idOf(object)] = { matrix: object.calcTransformMatrix(), visible: object.visible !== false, shown };
    childrenOf(object).forEach((child) => visit(child, shown));
  };
  roots.forEach((root) => visit(root, true));
  return expected;
}

function expectMatrix(actual: number[], expected: number[], label: string): void {
  // Fabric writes numbers with 4 decimal places, so positions match to a few thousandths of a pixel.
  actual.forEach((value, index) => {
    expect(Math.abs(value - expected[index]!), `${label} matrix[${index}]`).toBeLessThan(0.005);
  });
}

async function readFixture(major: string): Promise<GroupFixture | undefined> {
  try {
    return JSON.parse(await commands.readFile(fixturePath(major))) as GroupFixture;
  } catch {
    return undefined;
  }
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`groups after save and reopen on Fabric ${fabric.version}`, () => {
  it('reopens a document saved on the same version with every object in place', async () => {
    const source = createEngine();
    const scenes = buildScenes();
    source.canvas.add(...scenes);
    const expected = describeTree(scenes);
    const saved = JSON.parse(JSON.stringify(source.toDocument())) as FabricDocument;

    if ((await readFixture(MAJOR)) === undefined) {
      const fixture: GroupFixture = { fabricVersion: fabric.version, document: saved, expected };
      await commands.writeFile(fixturePath(MAJOR), `${JSON.stringify(fixture, null, 2)}\n`);
    }

    const target = createEngine();
    await target.loadDocument(saved);
    const actual = describeTree(target.canvas.getObjects());
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, value] of Object.entries(expected)) {
      expectMatrix(actual[id]!.matrix, value.matrix, id);
      expect(actual[id]!.visible, `${id} visible`).toBe(value.visible);
    }
  });

  for (const major of FIXTURE_VERSIONS) {
    it(`reopens groups saved on Fabric ${major} with every object in place`, async () => {
      const fixture = await readFixture(major);
      expect(fixture, `tests/fixtures/groups/fabric-${major}.json`).toBeDefined();
      if (fixture === undefined) return;
      const engine = createEngine();
      await engine.loadDocument(fixture.document);
      const actual = describeTree(engine.canvas.getObjects());
      expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture.expected).sort());
      for (const [id, value] of Object.entries(fixture.expected)) {
        expectMatrix(actual[id]!.matrix, value.matrix, `${id} from Fabric ${major}`);
        expect(actual[id]!.visible, `${id} visible`).toBe(value.visible);
        expect(actual[id]!.shown, `${id} shown`).toBe(value.shown);
      }
    });

    it(`keeps every child in place when groups saved on Fabric ${major} are ungrouped`, async () => {
      const fixture = await readFixture(major);
      expect(fixture).toBeDefined();
      if (fixture === undefined) return;
      const engine = createEngine();
      await engine.loadDocument(fixture.document);
      const groups = engine.canvas.getObjects().filter((object): object is Group => object instanceof Group);
      expect(groups.length).toBeGreaterThan(3);

      for (const group of groups) {
        const children = group.removeAll();
        engine.canvas.remove(group);
        engine.canvas.add(...children);
        for (const child of children) {
          expectMatrix(child.calcTransformMatrix(), fixture.expected[idOf(child)]!.matrix, `${idOf(child)} after ungroup`);
          expect(child.visible).toBe(fixture.expected[idOf(child)]!.visible);
        }
      }
    });

    it(`saves groups from Fabric ${major} again without moving anything`, async () => {
      const fixture = await readFixture(major);
      expect(fixture).toBeDefined();
      if (fixture === undefined) return;
      const first = createEngine();
      await first.loadDocument(fixture.document);
      const second = createEngine();
      await second.loadDocument(JSON.parse(JSON.stringify(first.toDocument())));
      const actual = describeTree(second.canvas.getObjects());
      for (const [id, value] of Object.entries(fixture.expected)) {
        expectMatrix(actual[id]!.matrix, value.matrix, `${id} saved twice`);
      }
    });
  }

  it('keeps the size of a fixed layout group with a child outside it', async () => {
    const engine = createEngine();
    engine.canvas.add(...buildScenes());
    const saved = engine.toDocument();
    const target = createEngine();
    await target.loadDocument(saved);
    const fixed = target.getObjectById('fixed') as Group;
    expect(fixed.width).toBe(100);
    expect(fixed.height).toBe(100);
  });

  it('undoes an ungroup with every child back in its group', async () => {
    const engine = createEngine();
    engine.canvas.add(...buildScenes());
    engine.clearHistory();
    const deep = engine.getObjectById('deep') as Group;
    const before = describeTree([deep]);
    engine.transaction('Ungroup', () => {
      const children = deep.removeAll();
      engine.canvas.remove(deep);
      engine.canvas.add(...children);
    });
    await engine.undo();
    const restored = engine.getObjectById('deep') as Group;
    const after = describeTree([restored]);
    for (const [id, value] of Object.entries(before)) expectMatrix(after[id]!.matrix, value.matrix, `${id} after undo`);
  });
});
