import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Rect } from 'fabric';
import { bindUnsavedChangesWarning, createDocumentEngine } from '../src';
import type { DocumentEngine, DocumentEngineOptions, DocumentStorage, FabricDocument } from '../src';
import { createLocalStorage, createMemoryStorage, verifyStorageAdapter } from '../src/storage';

const openCanvases: Canvas[] = [];
const openEngines: DocumentEngine[] = [];

function createEngine(options: Omit<DocumentEngineOptions, 'canvas'> = {}): DocumentEngine {
  const element = document.createElement('canvas');
  document.body.append(element);
  const canvas = new Canvas(element, { width: 300, height: 200 });
  openCanvases.push(canvas);
  const engine = createDocumentEngine({ canvas, ...options });
  openEngines.push(engine);
  return engine;
}

function nextTick(milliseconds = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function addRect(engine: DocumentEngine, fill = 'red'): Promise<void> {
  engine.canvas.add(new Rect({ width: 10, height: 10, fill }));
  await nextTick();
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`safe saving on Fabric ${fabric.version}`, () => {
  it('marks the document dirty after edits, undo and metadata changes', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    expect(engine.isDirty()).toBe(false);
    await addRect(engine);
    expect(engine.isDirty()).toBe(true);
    await engine.save();
    expect(engine.isDirty()).toBe(false);
    await engine.undo();
    expect(engine.isDirty()).toBe(true);
    await engine.save();
    engine.updateMetadata({ title: 'Renamed' });
    expect(engine.getSaveState().status).toBe('unsaved');
  });

  it('counts revisions and loads the saved revision back', async () => {
    const storage = createMemoryStorage();
    const engine = createEngine({ storage });
    await addRect(engine);
    await engine.save();
    await addRect(engine);
    const saved = await engine.save();
    expect(saved.revision).toBe(2);

    const reopened = createEngine({ storage });
    await reopened.load(saved.id);
    expect(reopened.getSaveState()).toMatchObject({ revision: 2, isDirty: false, status: 'saved' });
    expect(reopened.canUndo()).toBe(false);
  });

  it('detects a second tab saving the same document', async () => {
    const storage = createMemoryStorage();
    const firstTab = createEngine({ storage });
    await addRect(firstTab);
    const original = await firstTab.save();

    const secondTab = createEngine({ storage });
    await secondTab.load(original.id);
    await addRect(secondTab, 'blue');
    await secondTab.save();

    await addRect(firstTab, 'green');
    await expect(firstTab.save()).rejects.toMatchObject({ code: 'SAVE_CONFLICT' });
    expect(firstTab.getSaveState().status).toBe('conflict');

    await firstTab.save({ overwrite: true });
    expect(firstTab.getSaveState().status).toBe('saved');
  });

  it('never lets a slow older save overwrite newer work', async () => {
    const stored: FabricDocument[] = [];
    const releases: Array<() => void> = [];
    const storage: DocumentStorage = {
      loadDocument: async () => undefined,
      saveDocument: (document) =>
        new Promise((resolve) => {
          releases.push(() => {
            stored.push(document);
            resolve();
          });
        }),
    };
    const engine = createEngine({ storage });
    await addRect(engine, 'red');
    const older = engine.save();
    await addRect(engine, 'blue');
    const newer = engine.save();
    await nextTick();
    expect(releases).toHaveLength(1);

    releases[0]!();
    await older;
    await nextTick();
    releases[1]!();
    await newer;

    const lastWritten = stored[stored.length - 1]!;
    expect(lastWritten.objects.map((object) => object.fill)).toEqual(['red', 'blue']);
    expect(engine.isDirty()).toBe(false);
  });

  it('autosaves after edits settle', async () => {
    const storage = createMemoryStorage();
    const engine = createEngine({ storage, autosave: { delay: 100, maxWait: 2000 } });
    const saved = vi.fn();
    engine.on('save:success', saved);
    await addRect(engine);
    await addRect(engine);
    expect(saved).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(saved).toHaveBeenCalled(), { timeout: 3000 });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(engine.isDirty()).toBe(false);
    expect(await storage.listDocuments()).toEqual([engine.getDocumentInfo().id]);
  });

  it('passes the storage contract with the real localStorage adapter', async () => {
    const report = await verifyStorageAdapter(createLocalStorage({ prefix: `contract-${Date.now()}:` }));
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
  });

  it('refuses autosave without storage', () => {
    expect(() => createEngine({ autosave: true })).toThrow(/storage/);
  });

  it('emits save status changes in order', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    const statuses: string[] = [];
    engine.on('save:status', (state) => statuses.push(state.status));
    await addRect(engine);
    await engine.save();
    expect(statuses).toEqual(['unsaved', 'saving', 'saved']);
  });

  it('retries a flaky backend and then succeeds', async () => {
    let failuresLeft = 2;
    const memory = createMemoryStorage();
    const storage: DocumentStorage = {
      loadDocument: (id) => memory.loadDocument(id),
      saveDocument: async (document, context) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('503 Service Unavailable');
        }
        return memory.saveDocument(document, context);
      },
    };
    const engine = createEngine({ storage, saveRetry: { attempts: 3, baseDelay: 1, maxDelay: 4 } });
    const retries = vi.fn();
    engine.on('save:retry', retries);
    await addRect(engine);
    await engine.save();
    expect(retries).toHaveBeenCalledTimes(2);
    expect(engine.getSaveState().status).toBe('saved');
  });

  it('starts clean when a new document is created, but only after unsaved work is dealt with', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    await addRect(engine);
    expect(() => engine.newDocument()).toThrow(expect.objectContaining({ code: 'UNSAVED_CHANGES' }));
    expect(engine.canvas.getObjects()).toHaveLength(1);
    engine.newDocument({ discardUnsavedChanges: true });
    expect(engine.getSaveState()).toMatchObject({ isDirty: false, revision: 0 });
  });

  it('refuses to replace unsaved work when loading, importing or restoring', async () => {
    const storage = createMemoryStorage();
    const other = createEngine({ storage });
    await addRect(other);
    const saved = await other.save();

    const engine = createEngine({ storage });
    await addRect(engine);
    await expect(engine.load(saved.id)).rejects.toMatchObject({ code: 'UNSAVED_CHANGES' });
    await expect(engine.loadDocument(saved)).rejects.toMatchObject({ code: 'UNSAVED_CHANGES' });
    await expect(engine.importFabricJson({ objects: [] })).rejects.toMatchObject({ code: 'UNSAVED_CHANGES' });
    expect(engine.canvas.getObjects()).toHaveLength(1);

    await engine.save();
    await engine.load(saved.id);
    expect(engine.getDocumentInfo().id).toBe(saved.id);
  });

  it('lets apps without storage manage saving themselves', async () => {
    const engine = createEngine();
    await addRect(engine);
    const snapshot = engine.toDocument();
    await engine.loadDocument(snapshot);
    engine.newDocument();
    expect(engine.canvas.getObjects()).toHaveLength(0);
  });

  it('warns before leaving the page with unsaved work', async () => {
    const engine = createEngine({ storage: createMemoryStorage() });
    const unbind = bindUnsavedChangesWarning(engine);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await addRect(engine);
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    unbind();
  });
});
