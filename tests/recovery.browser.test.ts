import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, FabricImage, Rect } from 'fabric';
import { createDocumentEngine } from '../src';
import type { DocumentEngine, DocumentEngineOptions, FabricDocument } from '../src';
import { createIndexedDbRecovery, createMemoryRecovery } from '../src/recovery';
import type { RecoveryStore } from '../src/recovery';
import { createMemoryStorage } from '../src/storage';

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

function uniqueDatabase(): RecoveryStore {
  return createIndexedDbRecovery({ databaseName: `recovery-test-${Math.random().toString(36).slice(2)}` });
}

function idsOn(engine: DocumentEngine): Array<string | undefined> {
  return engine.canvas.getObjects().map((object) => (object as typeof object & { id?: string }).id);
}

afterEach(async () => {
  openEngines.splice(0).forEach((engine) => engine.destroy());
  await Promise.all(openCanvases.splice(0).map((canvas) => canvas.dispose()));
  document.body.innerHTML = '';
});

describe(`recovery on Fabric ${fabric.version}`, () => {
  it('stores values, bytes and keys in IndexedDB', async () => {
    const store = uniqueDatabase();
    const bytes = new TextEncoder().encode('hello').buffer;
    await store.set('document:a', { name: 'A', bytes });
    const value = (await store.get('document:a')) as { name: string; bytes: ArrayBuffer };
    expect(value.name).toBe('A');
    expect(new TextDecoder().decode(value.bytes)).toBe('hello');
    expect(await store.keys()).toEqual(['document:a']);
    await store.delete('document:a');
    expect(await store.get('document:a')).toBeUndefined();
  });

  it('keeps an emergency copy in localStorage and reads it back', async () => {
    const store = uniqueDatabase();
    store.setNow!('unload:a', { name: 'emergency' });
    expect(await store.get('unload:a')).toEqual({ name: 'emergency' });
    expect(await store.keys()).toContain('unload:a');
    await store.delete('unload:a');
    expect(await store.get('unload:a')).toBeUndefined();
  });

  it('brings back unsaved work after a refresh', async () => {
    const store = uniqueDatabase();
    const storage = createMemoryStorage();
    const beforeRefresh = createEngine({ storage, recovery: { store } });
    beforeRefresh.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    const saved = await beforeRefresh.save();
    beforeRefresh.canvas.add(new Rect({ width: 20, height: 20, fill: 'blue' }));
    await nextTick();
    await beforeRefresh.flushRecovery();
    const idsBeforeRefresh = idsOn(beforeRefresh);
    beforeRefresh.destroy();

    const afterRefresh = createEngine({ storage, recovery: { store } });
    const recoverable = await afterRefresh.getRecoverableDocuments();
    expect(recoverable.map((record) => [record.documentId, record.baseRevision])).toEqual([[saved.id, 1]]);

    const restored = vi.fn();
    afterRefresh.on('recovery:restored', restored);
    await afterRefresh.restoreRecovery(saved.id);
    expect(idsOn(afterRefresh)).toEqual(idsBeforeRefresh);
    expect(afterRefresh.isDirty()).toBe(true);
    expect(afterRefresh.getSaveState().revision).toBe(1);
    expect(restored).toHaveBeenCalledOnce();

    await afterRefresh.save();
    expect(await afterRefresh.getRecovery(saved.id)).toBeUndefined();
  });

  it('keeps recovered work safe when the server moved on meanwhile', async () => {
    const store = createMemoryRecovery();
    const storage = createMemoryStorage();
    const first = createEngine({ storage, recovery: { store } });
    first.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    const saved = await first.save();
    first.canvas.add(new Rect({ width: 5, height: 5 }));
    await nextTick();
    await first.flushRecovery();

    const otherDevice = createEngine({ storage });
    await otherDevice.load(saved.id);
    otherDevice.canvas.add(new Rect({ width: 7, height: 7 }));
    await nextTick();
    await otherDevice.save();

    const restoredTab = createEngine({ storage, recovery: { store } });
    await restoredTab.restoreRecovery(saved.id);
    await expect(restoredTab.save()).rejects.toMatchObject({ code: 'SAVE_CONFLICT' });
  });

  it('writes checkpoints on its own while editing', async () => {
    const engine = createEngine({ storage: createMemoryStorage(), recovery: { store: createMemoryRecovery(), interval: 20 } });
    const checkpoints = vi.fn();
    engine.on('recovery:checkpoint', checkpoints);
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick(60);
    expect(checkpoints).toHaveBeenCalledTimes(1);
    expect(checkpoints.mock.calls[0]![0].documentId).toBe(engine.getDocumentInfo().id);
  });

  it('removes the copy once a save covers all changes', async () => {
    const engine = createEngine({ storage: createMemoryStorage(), recovery: { store: createMemoryRecovery() } });
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    await engine.flushRecovery();
    expect(await engine.getRecovery()).toBeDefined();
    await engine.save();
    await nextTick();
    expect(await engine.getRecovery()).toBeUndefined();
  });

  it('can discard a copy the user does not want', async () => {
    const engine = createEngine({ recovery: { store: createMemoryRecovery() } });
    engine.canvas.add(new Rect({ width: 10, height: 10 }));
    await nextTick();
    await engine.flushRecovery();
    await engine.discardRecovery();
    expect(await engine.getRecoverableDocuments()).toEqual([]);
  });

  it('restores images that only existed in the old tab', async () => {
    const store = uniqueDatabase();
    const picture = document.createElement('canvas');
    picture.width = 4;
    picture.height = 4;
    picture.getContext('2d')!.fillRect(0, 0, 4, 4);
    const blob = await new Promise<Blob>((resolve) => picture.toBlob((value) => resolve(value!)));
    const tabOnlyUrl = URL.createObjectURL(blob);

    const beforeRefresh = createEngine({ recovery: { store } });
    beforeRefresh.canvas.add(await FabricImage.fromURL(tabOnlyUrl));
    await nextTick();
    await beforeRefresh.flushRecovery();
    const documentId = beforeRefresh.getDocumentInfo().id;
    beforeRefresh.destroy();
    URL.revokeObjectURL(tabOnlyUrl);

    const afterRefresh = createEngine({ recovery: { store } });
    await afterRefresh.restoreRecovery(documentId);
    const image = afterRefresh.canvas.getObjects()[0] as FabricImage;
    expect(image).toBeInstanceOf(FabricImage);
    expect(image.getSrc()).not.toBe(tabOnlyUrl);
    expect((image.getElement() as HTMLImageElement).naturalWidth).toBe(4);
  });

  it('remembers a load that never finished', async () => {
    const store = createMemoryRecovery();
    await store.set('loading', { documentId: 'crashy', startedAt: new Date().toISOString() });
    const engine = createEngine({ recovery: { store } });
    expect(await engine.getInterruptedLoad()).toMatchObject({ documentId: 'crashy' });

    const document: FabricDocument = { ...engine.toDocument(), id: 'fine' };
    await engine.loadDocument(document);
    expect(await engine.getInterruptedLoad()).toBeUndefined();
  });

  it('explains when recovery is used without a store', async () => {
    const engine = createEngine();
    await expect(engine.flushRecovery()).rejects.toMatchObject({ code: 'RECOVERY_MISSING' });
    const withStore = createEngine({ recovery: { store: createMemoryRecovery() } });
    await expect(withStore.restoreRecovery('nothing-here')).rejects.toMatchObject({ code: 'RECOVERY_NOT_FOUND' });
  });
});
