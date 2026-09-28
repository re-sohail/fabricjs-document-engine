import { describe, expect, it } from 'vitest';
import { createKeyValueStorage, createLocalStorage, createMemoryStorage } from '../src/storage';
import type { FabricDocument } from '../src/document/document-format';
import { isRetryable, retryDelay } from '../src/save/retry';

function documentWith(id: string, revision: number): FabricDocument {
  return {
    schemaVersion: 1,
    id,
    createdAt: '',
    updatedAt: '',
    revision,
    canvas: { width: 1, height: 1 },
    objects: [],
    metadata: {},
  };
}

const signal = new AbortController().signal;

describe('memory storage', () => {
  it('saves, loads, lists and deletes documents', async () => {
    const storage = createMemoryStorage();
    await storage.saveDocument(documentWith('a', 1), { expectedRevision: 0, signal });
    expect(await storage.loadDocument('a')).toMatchObject({ id: 'a', revision: 1 });
    expect(await storage.listDocuments()).toEqual(['a']);
    await storage.deleteDocument('a');
    await expect(storage.loadDocument('a')).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('refuses a save based on an old revision', async () => {
    const storage = createMemoryStorage();
    await storage.saveDocument(documentWith('a', 1), { expectedRevision: 0, signal });
    await storage.saveDocument(documentWith('a', 2), { expectedRevision: 1, signal });
    await expect(storage.saveDocument(documentWith('a', 2), { expectedRevision: 1, signal })).rejects.toMatchObject({
      code: 'SAVE_CONFLICT',
    });
  });

  it('overwrites when no revision is expected', async () => {
    const storage = createMemoryStorage();
    await storage.saveDocument(documentWith('a', 1), { expectedRevision: 0, signal });
    const result = await storage.saveDocument(documentWith('a', 1), { expectedRevision: null, signal });
    expect(result).toEqual({ revision: 2 });
  });
});

describe('local storage', () => {
  function fakeLocalStorage(): Storage {
    const values = new Map<string, string>();
    return {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => {
        values.delete(key);
      },
      setItem: (key, value) => {
        if (value.length > 10_000) throw new Error('QuotaExceededError');
        values.set(key, value);
      },
    };
  }

  it('keeps only its own prefix when listing', async () => {
    const browserStorage = fakeLocalStorage();
    browserStorage.setItem('unrelated', 'x');
    const storage = createLocalStorage({ storage: browserStorage, prefix: 'docs:' });
    await storage.saveDocument(documentWith('plan', 1), { expectedRevision: 0, signal });
    expect(await storage.listDocuments()).toEqual(['plan']);
  });

  it('explains a full browser storage and does not retry it', async () => {
    const storage = createLocalStorage({ storage: fakeLocalStorage() });
    const huge = { ...documentWith('big', 1), metadata: { text: 'x'.repeat(20_000) } };
    await expect(storage.saveDocument(huge, { expectedRevision: 0, signal })).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      retryable: false,
    });
  });

  it('builds on any key value store', async () => {
    const values: Record<string, string> = {};
    const storage = createKeyValueStorage(
      {
        read: (key) => values[key] ?? null,
        write: (key, value) => {
          values[key] = value;
        },
        remove: (key) => {
          delete values[key];
        },
        keys: () => Object.keys(values),
      },
      'p:',
    );
    await storage.saveDocument(documentWith('x', 1), { expectedRevision: 0, signal });
    expect(Object.keys(values)).toEqual(['p:x']);
  });
});

describe('retry helpers', () => {
  it('keeps the delay between half and all of the capped backoff', () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ceiling = Math.min(1000, 100 * 2 ** attempt);
      const delay = retryDelay(attempt, { baseDelay: 100, maxDelay: 1000 });
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('never retries conflicts or errors marked as final', () => {
    expect(isRetryable(new Error('timeout'))).toBe(true);
    expect(isRetryable({ code: 'SAVE_CONFLICT' })).toBe(false);
    expect(isRetryable({ retryable: false })).toBe(false);
  });
});
