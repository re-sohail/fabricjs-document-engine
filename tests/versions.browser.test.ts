import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, IText, Rect, StaticCanvas } from 'fabric';
import { createDocumentEngine } from '../src';
import type { DocumentEngine, DocumentEngineOptions, DocumentStorage, FabricDocument } from '../src';
import { createMemoryStorage } from '../src/storage';

const openCanvases: StaticCanvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(options: Omit<DocumentEngineOptions, 'canvas'> = {}): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 400, height: 300 });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas, ...options });
  openEngines.push(engine);
  return engine;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function idOf(object: unknown): string | undefined {
  return (object as { id?: string }).id;
}

const legacyFabricFiveJson = {
  version: '5.3.0',
  background: '#fafafa',
  objects: [
    { type: 'rect', originX: 'left', originY: 'top', left: 10, top: 20, width: 30, height: 40, fill: 'red' },
    { type: 'i-text', originX: 'left', originY: 'top', left: 50, top: 60, text: 'Hello', fontFamily: 'sans-serif' },
    {
      type: 'group',
      originX: 'left',
      originY: 'top',
      left: 100,
      top: 100,
      width: 40,
      height: 20,
      objects: [
        { type: 'circle', originX: 'left', originY: 'top', left: -20, top: -10, radius: 10 },
        { type: 'rect', originX: 'left', originY: 'top', left: 0, top: -10, width: 20, height: 20 },
      ],
    },
  ],
};

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`migration and versions on Fabric ${fabric.version}`, () => {
  it('imports plain Fabric JSON as an editable document with ids', async () => {
    const engine = createEngine();
    const loaded = vi.fn();
    engine.on('load:success', loaded);
    const document = await engine.importFabricJson(JSON.stringify(legacyFabricFiveJson), {
      id: 'imported-plan',
      metadata: { source: 'old editor' },
    });

    expect(document.schemaVersion).toBe(1);
    expect(loaded.mock.calls[0]![0].migratedFrom).toBe(0);
    expect(engine.getDocumentInfo()).toMatchObject({ id: 'imported-plan', metadata: { source: 'old editor' } });
    const [rect, text, group] = engine.canvas.getObjects();
    expect(rect).toBeInstanceOf(Rect);
    expect(text).toBeInstanceOf(IText);
    expect((group as fabric.Group).getObjects()).toHaveLength(2);
    expect(rect!.getBoundingRect().left).toBeCloseTo(10, 0);
    expect(engine.canvas.getObjects().every((object) => typeof idOf(object) === 'string')).toBe(true);
    expect(engine.toDocument()).toMatchObject({ schemaVersion: 1, id: 'imported-plan' });
  });

  it('opens a document stored by an older app straight from storage', async () => {
    const storage = createMemoryStorage();
    const olderApp: DocumentStorage = {
      loadDocument: async () => structuredClone(legacyFabricFiveJson),
      saveDocument: storage.saveDocument,
    };
    const engine = createEngine({ storage: olderApp });
    await engine.load('from-before');
    expect(engine.canvas.getObjects()).toHaveLength(3);
    expect(engine.getDocumentInfo().id).toBe('from-before');
    const saved = await engine.save();
    expect(saved).toMatchObject({ id: 'from-before', schemaVersion: 1, revision: 1 });
  });

  it('explains when the imported text is not JSON', async () => {
    const engine = createEngine();
    await expect(engine.importFabricJson('{ not json')).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
  });

  it('creates named versions and restores one as a new unsaved revision', async () => {
    const storage = createMemoryStorage();
    const engine = createEngine({ storage });
    engine.canvas.add(new Rect({ width: 10, height: 10, fill: 'red' }));
    await nextTick();
    await engine.save();
    const created = vi.fn();
    engine.on('version:created', created);
    const firstDraft = await engine.createVersion('First draft');
    expect(created).toHaveBeenCalledWith(firstDraft);
    const firstIds = engine.canvas.getObjects().map(idOf);

    engine.canvas.add(new Rect({ width: 20, height: 20, fill: 'blue' }));
    await nextTick();
    await engine.save();
    await engine.save();
    const revisionBeforeRestore = engine.getSaveState().revision;

    const restored = vi.fn();
    engine.on('version:restored', restored);
    await engine.restoreVersion(firstDraft.id);
    expect(engine.canvas.getObjects().map(idOf)).toEqual(firstIds);
    expect(engine.isDirty()).toBe(true);
    expect(engine.getDocumentInfo().id).toBe(firstDraft.documentId);
    expect(restored.mock.calls[0]![0].version.name).toBe('First draft');

    const versions = await engine.listVersions();
    expect(versions.map((version) => [version.kind, version.name])).toEqual([
      ['auto', 'Before restoring "First draft"'],
      ['named', 'First draft'],
    ]);

    const saved = await engine.save();
    expect(saved.revision).toBe(revisionBeforeRestore + 1);
  });

  it('can undo a restore by restoring the automatic version made before it', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    const early = await engine.createVersion('Early');
    engine.canvas.add(new Rect({ width: 10, height: 10 }), new Rect({ width: 10, height: 10 }));
    await nextTick();
    const latestIds = engine.canvas.getObjects().map(idOf);

    await engine.restoreVersion(early.id);
    const [beforeRestoring] = await engine.listVersions();
    await engine.restoreVersion(beforeRestoring!.id);
    expect(engine.canvas.getObjects().map(idOf)).toEqual(latestIds);
  });

  it('keeps automatic versions every few saves within the limit', async () => {
    const engine = createEngine({ storage: createMemoryStorage(), versions: { autoEvery: 2, keepAuto: 2 } });
    await engine.createVersion('Pinned');
    for (let index = 0; index < 8; index += 1) {
      engine.canvas.add(new Rect({ width: 5, height: 5 }));
      await nextTick();
      await engine.save();
      await nextTick();
    }
    const versions = await engine.listVersions();
    expect(versions.filter((version) => version.kind === 'auto')).toHaveLength(2);
    expect(versions.filter((version) => version.kind === 'named').map((version) => version.name)).toEqual(['Pinned']);
  });

  it('deletes a version', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    const version = await engine.createVersion('Throwaway');
    await engine.deleteVersion(version.id);
    expect(await engine.listVersions()).toEqual([]);
    await expect(engine.restoreVersion(version.id)).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
  });

  it('explains when the storage cannot keep versions', async () => {
    const storage: DocumentStorage = {
      loadDocument: async () => undefined,
      saveDocument: async () => undefined,
    };
    const engine = createEngine({ storage });
    await expect(engine.createVersion('Nope')).rejects.toMatchObject({ code: 'VERSIONS_UNSUPPORTED' });
    const withoutStorage = createEngine();
    await expect(withoutStorage.listVersions()).rejects.toMatchObject({ code: 'VERSIONS_UNSUPPORTED' });
  });

  it('restores versions that were saved in the old plain Fabric format', async () => {
    const storage = createMemoryStorage();
    const engine = createEngine({ storage });
    await storage.saveVersion({
      id: 'legacy',
      documentId: engine.getDocumentInfo().id,
      name: 'From the old editor',
      kind: 'named',
      createdAt: new Date().toISOString(),
      revision: 0,
      document: structuredClone(legacyFabricFiveJson) as unknown as FabricDocument,
    });
    await engine.restoreVersion('legacy');
    expect(engine.canvas.getObjects()).toHaveLength(3);
    expect(engine.toDocument().id).toBe(engine.getDocumentInfo().id);
  });
});
