import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSaveController } from '../src/save/save-controller';
import type { SaveController, SaveState } from '../src/save/save-controller';
import type { FabricDocument } from '../src/document/document-format';
import type { DocumentStorage, SaveContext } from '../src/storage/storage-contract';
import { DocumentEngineError } from '../src/engine/errors';

interface PendingSave {
  document: FabricDocument;
  context: SaveContext;
  succeed(revision?: number): void;
  fail(error: unknown): void;
}

function createControlledStorage() {
  const pending: PendingSave[] = [];
  const storage: DocumentStorage = {
    loadDocument: async () => undefined,
    saveDocument: (document, context) =>
      new Promise((resolve, reject) => {
        pending.push({
          document,
          context,
          succeed: (revision) => resolve(revision === undefined ? undefined : { revision }),
          fail: reject,
        });
      }),
  };
  return { storage, pending };
}

function createHarness(storage: DocumentStorage, overrides: Partial<Parameters<typeof createSaveController>[0]> = {}) {
  let content = 'first';
  const states: SaveState[] = [];
  const onRetry = vi.fn();
  const controller: SaveController = createSaveController({
    getStorage: () => storage,
    createDocument: () =>
      ({
        schemaVersion: 1,
        id: 'doc',
        createdAt: '',
        updatedAt: '',
        canvas: { width: 1, height: 1 },
        objects: [],
        metadata: { content },
      }) as FabricDocument,
    retry: { attempts: 2, baseDelay: 1, maxDelay: 2 },
    onStateChange: (state) => states.push(state),
    onStart: () => undefined,
    onSuccess: () => undefined,
    onError: () => undefined,
    onRetry,
    ...overrides,
  });
  return {
    controller,
    states,
    onRetry,
    edit(next: string) {
      content = next;
      controller.noteContentChange();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe('save controller', () => {
  it('tracks dirty state across a save', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit } = createHarness(storage);
    expect(controller.state().status).toBe('saved');
    edit('second');
    expect(controller.state()).toMatchObject({ status: 'unsaved', isDirty: true });

    const saving = controller.save();
    expect(controller.state().status).toBe('saving');
    await flushMicrotasks();
    pending[0]!.succeed();
    await saving;
    expect(controller.state()).toMatchObject({ status: 'saved', isDirty: false, revision: 1 });
  });

  it('stays dirty when an edit happens while saving', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit } = createHarness(storage);
    edit('second');
    const saving = controller.save();
    edit('third');
    await flushMicrotasks();
    pending[0]!.succeed();
    await saving;
    expect(controller.state().isDirty).toBe(true);
  });

  it('runs one save at a time and merges waiting saves into one', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit } = createHarness(storage);
    edit('second');
    const first = controller.save();
    edit('third');
    const second = controller.save();
    edit('fourth');
    const third = controller.save();
    expect(second).toBe(third);
    await flushMicrotasks();
    expect(pending).toHaveLength(1);

    await flushMicrotasks();
    pending[0]!.succeed();
    await first;
    await settle();
    await flushMicrotasks();
    expect(pending).toHaveLength(2);
    await flushMicrotasks();
    expect(pending[1]!.document.metadata.content).toBe('fourth');
    await flushMicrotasks();
    expect(pending[1]!.context.expectedRevision).toBe(1);
    await flushMicrotasks();
    pending[1]!.succeed();
    await third;
    expect(controller.state()).toMatchObject({ isDirty: false, revision: 2 });
  });

  it('ignores a slow response that belongs to a previous document', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit } = createHarness(storage);
    edit('old document');
    const oldSave = controller.save();
    controller.startSession(7);
    await flushMicrotasks();
    pending[0]!.succeed(99);
    await oldSave;
    expect(controller.state()).toMatchObject({ revision: 7, status: 'saved', isSaving: false });
  });

  it('cancels a waiting save when another document is opened', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit } = createHarness(storage);
    edit('a');
    const running = controller.save();
    const waiting = controller.save();
    controller.startSession(0);
    await flushMicrotasks();
    pending[0]!.succeed();
    await running;
    await expect(waiting).rejects.toMatchObject({ code: 'SAVE_CANCELLED' });
    await flushMicrotasks();
    expect(pending).toHaveLength(1);
  });

  it('reports conflicts without retrying and can overwrite on request', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit, onRetry } = createHarness(storage);
    edit('mine');
    const conflicted = controller.save();
    await flushMicrotasks();
    pending[0]!.fail(new DocumentEngineError('SAVE_CONFLICT', 'someone else saved'));
    await expect(conflicted).rejects.toMatchObject({ code: 'SAVE_CONFLICT' });
    expect(onRetry).not.toHaveBeenCalled();
    expect(controller.state().status).toBe('conflict');

    const overwrite = controller.save({ overwrite: true });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(pending[1]!.context.expectedRevision).toBeNull();
    await flushMicrotasks();
    pending[1]!.succeed(5);
    await overwrite;
    expect(controller.state()).toMatchObject({ status: 'saved', revision: 5 });
  });

  it('retries temporary failures with backoff', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit, onRetry } = createHarness(storage);
    edit('second');
    const saving = controller.save();
    await flushMicrotasks();
    pending[0]!.fail(new Error('network down'));
    await settle();
    await flushMicrotasks();
    pending[1]!.fail(new Error('still down'));
    await settle();
    await flushMicrotasks();
    pending[2]!.succeed();
    await saving;
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(controller.state().status).toBe('saved');
  });

  it('gives up after the last attempt and keeps the error', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit } = createHarness(storage, { retry: { attempts: 0 } });
    edit('second');
    const saving = controller.save();
    await flushMicrotasks();
    pending[0]!.fail(new Error('server exploded'));
    await expect(saving).rejects.toMatchObject({ code: 'SAVE_FAILED', retryable: true });
    expect(controller.state()).toMatchObject({ status: 'error', isDirty: true });
  });

  it('does not retry errors marked as not retryable', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit, onRetry } = createHarness(storage);
    edit('second');
    const saving = controller.save();
    await flushMicrotasks();
    pending[0]!.fail(Object.assign(new Error('forbidden'), { retryable: false }));
    await expect(saving).rejects.toMatchObject({ code: 'SAVE_FAILED', retryable: false });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('turns a plain error with a SAVE_CONFLICT code into a conflict', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit } = createHarness(storage);
    edit('second');
    const saving = controller.save();
    await flushMicrotasks();
    pending[0]!.fail(Object.assign(new Error('409'), { code: 'SAVE_CONFLICT' }));
    await expect(saving).rejects.toMatchObject({ code: 'SAVE_CONFLICT' });
  });
});

describe('autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves after a quiet period', async () => {
    const { storage, pending } = createControlledStorage();
    const { edit } = createHarness(storage, { autosave: { delay: 100, maxWait: 1000 } });
    edit('a');
    vi.advanceTimersByTime(99);
    await flushMicrotasks();
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(pending).toHaveLength(1);
  });

  it('saves at the maximum wait even while editing never stops', async () => {
    const { storage, pending } = createControlledStorage();
    const { edit } = createHarness(storage, { autosave: { delay: 100, maxWait: 300 } });
    for (let elapsed = 0; elapsed < 300; elapsed += 50) {
      edit(`edit ${elapsed}`);
      vi.advanceTimersByTime(50);
    }
    await flushMicrotasks();
    expect(pending).toHaveLength(1);
  });

  it('stops the timer when another document is opened', async () => {
    const { storage, pending } = createControlledStorage();
    const { controller, edit } = createHarness(storage, { autosave: { delay: 100 } });
    edit('a');
    controller.startSession(0);
    vi.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(pending).toHaveLength(0);
  });
});
