import { describe, expect, it } from 'vitest';
import { createMemoryStorage, verifyStorageAdapter } from '../src/storage';
import type { DocumentStorage } from '../src/storage';

describe('verifyStorageAdapter', () => {
  it('passes the built-in memory storage', async () => {
    const report = await verifyStorageAdapter(createMemoryStorage());
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toContain('keeps, lists, loads and deletes versions');
  });

  it('catches an adapter that ignores revisions', async () => {
    const records = new Map<string, unknown>();
    const careless: DocumentStorage = {
      loadDocument: async (id) => {
        if (!records.has(id)) throw new Error('missing');
        return records.get(id);
      },
      saveDocument: async (document) => {
        records.set(document.id, structuredClone(document));
      },
    };
    const report = await verifyStorageAdapter(careless);
    expect(report.ok).toBe(false);
    const failed = report.checks.find((check) => !check.passed);
    expect(failed?.name).toBe('refuses a save based on an old revision with code SAVE_CONFLICT');
    expect(failed?.message).toContain('older tab could overwrite newer work');
  });

  it('catches an adapter that resolves missing documents with nothing', async () => {
    const memory = createMemoryStorage();
    const quiet: DocumentStorage = {
      loadDocument: async (id) => memory.loadDocument(id).catch(() => undefined),
      saveDocument: memory.saveDocument,
    };
    const report = await verifyStorageAdapter(quiet);
    expect(report.checks.find((check) => check.name.startsWith('rejects loading'))?.passed).toBe(false);
  });
});
