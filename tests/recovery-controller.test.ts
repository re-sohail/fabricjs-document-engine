import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecoveryController } from '../src/recovery/recovery-controller';
import { createMemoryRecovery } from '../src/recovery/recovery-store';
import type { RecoveryStore } from '../src/recovery/recovery-store';
import type { FabricDocument } from '../src/document/document-format';

function createHarness(store: RecoveryStore = createMemoryRecovery()) {
  let dirty = true;
  let content = 'first';
  const onCheckpoint = vi.fn();
  const onError = vi.fn();
  const controller = createRecoveryController({
    store,
    interval: 100,
    createDocument: () =>
      ({
        schemaVersion: 1,
        id: 'doc',
        createdAt: '',
        updatedAt: '',
        revision: 3,
        canvas: { width: 1, height: 1 },
        objects: [],
        metadata: { content },
      }) as FabricDocument,
    shouldWrite: () => dirty,
    onCheckpoint,
    onError,
  });
  return {
    store,
    controller,
    onCheckpoint,
    onError,
    setDirty(value: boolean) {
      dirty = value;
    },
    setContent(value: string) {
      content = value;
    },
  };
}

const listeners = new Map<string, Set<() => void>>();
if (typeof window === 'undefined') {
  Object.assign(globalThis, {
    window: {
      addEventListener: (name: string, handler: () => void) => {
        const set = listeners.get(name) ?? new Set();
        set.add(handler);
        listeners.set(name, set);
      },
      removeEventListener: (name: string, handler: () => void) => listeners.get(name)?.delete(handler),
      dispatchEvent: (event: Event) => {
        listeners.get(event.type)?.forEach((handler) => handler());
        return true;
      },
      document: { addEventListener: () => undefined, removeEventListener: () => undefined },
    },
  });
}

describe('recovery controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes at most one checkpoint per interval with the latest content', async () => {
    const { controller, onCheckpoint, setContent } = createHarness();
    controller.schedule();
    setContent('second');
    controller.schedule();
    setContent('third');
    await vi.advanceTimersByTimeAsync(100);
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    const record = await controller.read('doc');
    expect(record?.document.metadata.content).toBe('third');
    expect(record?.baseRevision).toBe(3);
  });

  it('skips checkpoints when nothing is unsaved', async () => {
    const { controller, onCheckpoint, setDirty } = createHarness();
    setDirty(false);
    await controller.flush();
    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it('removes a copy only after a checkpoint that was already running', async () => {
    const { controller } = createHarness();
    const writing = controller.flush();
    const removing = controller.remove('doc');
    await Promise.all([writing, removing]);
    expect(await controller.read('doc')).toBeUndefined();
  });

  it('lists copies newest first', async () => {
    const store = createMemoryRecovery();
    await store.set('document:old', { documentId: 'old', savedAt: '2026-01-01', document: {}, files: {} });
    await store.set('document:new', { documentId: 'new', savedAt: '2026-02-01', document: {}, files: {} });
    await store.set('loading', { startedAt: '2026-02-01' });
    const { controller } = createHarness(store);
    expect((await controller.list()).map((record) => record.documentId)).toEqual(['new', 'old']);
  });

  it('reports a load another session never finished, until a later load finishes', async () => {
    // Without Web Locks every other session counts as closed, which is what
    // a crashed tab looks like. The browser tests cover the locks.
    vi.stubGlobal('navigator', {});
    const crashed = createHarness();
    await crashed.controller.markLoadStarted('doc');
    // The session's own load in progress is not an interruption.
    expect(await crashed.controller.interruptedLoad()).toBeUndefined();
    crashed.controller.destroy();

    const { controller } = createHarness(crashed.store);
    expect(await controller.interruptedLoad()).toMatchObject({ documentId: 'doc' });
    await controller.markLoadStarted('next');
    await controller.markLoadFinished();
    expect(await controller.interruptedLoad()).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('keeps one copy per session and removes only what a save covers', async () => {
    const store = createMemoryRecovery();
    const first = createHarness(store);
    const second = createHarness(store);
    first.setContent('from first');
    second.setContent('from second');
    await first.controller.flush();
    await second.controller.flush();
    const copies = await first.controller.list();
    expect(copies.map((copy) => copy.document.metadata.content).sort()).toEqual(['from first', 'from second']);
    expect(new Set(copies.map((copy) => copy.sessionId)).size).toBe(2);

    await first.controller.remove('doc');
    expect((await first.controller.list()).map((copy) => copy.document.metadata.content)).toEqual(['from second']);

    first.controller.adopt('doc', second.controller.sessionId);
    await first.controller.remove('doc');
    expect(await first.controller.list()).toEqual([]);
  });

  it('still reads and removes copies written before sessions existed', async () => {
    const store = createMemoryRecovery();
    const { controller } = createHarness(store);
    await store.set('document:doc', { documentId: 'doc', savedAt: '2026-01-01T00:00:00.000Z', baseRevision: 1, document: { id: 'doc' }, files: {} });
    expect(await controller.read('doc')).toMatchObject({ sessionId: 'legacy', active: false });
    await controller.remove('doc');
    expect(await store.keys()).toEqual([]);
  });

  it('keeps document ids with any characters apart', async () => {
    const { controller, store } = createHarness();
    await store.set(`checkpoint:other:${encodeURIComponent('a:b/c d')}`, {
      documentId: 'a:b/c d',
      savedAt: '2026-01-01T00:00:00.000Z',
      baseRevision: 0,
      document: { id: 'a:b/c d' },
      files: {},
    });
    expect((await controller.list()).map((copy) => [copy.documentId, copy.sessionId])).toEqual([['a:b/c d', 'other']]);
  });

  it('writes an emergency copy at once when the page is closing', async () => {
    const { controller, store } = createHarness();
    window.dispatchEvent(new Event('pagehide'));
    expect(await store.keys()).toEqual([`closing:${controller.sessionId}:doc`]);
    expect((await controller.read('doc'))?.document.metadata.content).toBe('first');
    controller.destroy();
  });

  it('prefers the newer copy and keeps images from the older checkpoint', async () => {
    const store = createMemoryRecovery();
    const picture = new Blob(['png']);
    await store.set('document:doc', { documentId: 'doc', savedAt: '2026-01-01T10:00:00Z', document: { v: 'old' }, files: { 'blob:a': picture } });
    await store.set('unload:doc', { documentId: 'doc', savedAt: '2026-01-01T10:05:00Z', document: { v: 'new' }, files: {} });
    const { controller } = createHarness(store);
    const record = await controller.read('doc');
    expect(record?.document).toEqual({ v: 'new' });
    expect(record?.files['blob:a']).toBe(picture);
    expect(await controller.list()).toHaveLength(1);

    await controller.remove('doc');
    expect(await store.keys()).toEqual([]);
  });

  it('reports storage failures instead of throwing', async () => {
    const failing: RecoveryStore = {
      ...createMemoryRecovery(),
      set: async () => {
        throw new Error('quota exceeded');
      },
    };
    const { controller, onError } = createHarness(failing);
    await controller.flush();
    expect(onError).toHaveBeenCalledOnce();
  });
});
