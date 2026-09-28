import { describe, expect, it } from 'vitest';
import { detectSchemaVersion, migrateDocument } from '../src/migrations/migrate-document';
import type { Migration } from '../src/migrations/migrate-document';
import { validateDocument } from '../src/document/validate-document';
import { versionsToPrune } from '../src/versions/document-version';
import type { DocumentVersion, VersionSummary } from '../src/versions/document-version';
import { createMemoryStorage } from '../src/storage';
import type { FabricDocument } from '../src/document/document-format';

const context = { canvasWidth: 800, canvasHeight: 600 };

const fabricJson = {
  version: '5.3.0',
  background: '#fafafa',
  objects: [
    { type: 'rect', left: 10, top: 20, width: 30, height: 40, fill: 'red' },
    { type: 'i-text', text: 'Hello', left: 50, top: 60 },
  ],
};

describe('detectSchemaVersion', () => {
  it('recognises documents, plain Fabric JSON and everything else', () => {
    expect(detectSchemaVersion({ schemaVersion: 1, objects: [] })).toBe(1);
    expect(detectSchemaVersion(fabricJson)).toBe(0);
    expect(detectSchemaVersion({ hello: 'world' })).toBeUndefined();
    expect(detectSchemaVersion('text')).toBeUndefined();
  });
});

describe('migrateDocument', () => {
  it('turns plain Fabric JSON into a valid document', () => {
    const { document, migratedFrom } = migrateDocument(fabricJson, context);
    expect(migratedFrom).toBe(0);
    expect(validateDocument(document)).toEqual([]);
    expect(document).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      fabricVersion: '5.3.0',
      canvas: { width: 800, height: 600, background: '#fafafa' },
      objects: fabricJson.objects,
      metadata: {},
    });
  });

  it('uses the size, id and metadata it is given', () => {
    const { document } = migrateDocument(
      { ...fabricJson, width: 1200, height: 900 },
      { ...context, id: 'imported', metadata: { source: 'legacy editor' } },
    );
    expect(document).toMatchObject({ id: 'imported', canvas: { width: 1200, height: 900 }, metadata: { source: 'legacy editor' } });
  });

  it('never changes the input', () => {
    const input = structuredClone(fabricJson);
    migrateDocument(input, context);
    expect(input).toEqual(fabricJson);
  });

  it('leaves current and unknown documents alone', () => {
    const current = { schemaVersion: 1, objects: [] };
    expect(migrateDocument(current, context)).toEqual({ document: current, migratedFrom: undefined });
    const newer = { schemaVersion: 99, objects: [] };
    expect(migrateDocument(newer, context).document).toBe(newer);
  });

  it('runs every step in order', () => {
    const steps: Record<number, Migration> = {
      0: (document) => ({ ...document, schemaVersion: 1, trail: ['one'] }),
      1: (document) => ({ ...document, schemaVersion: 2, trail: [...(document.trail as string[]), 'two'] }),
    };
    const { document, migratedFrom } = migrateDocument({ objects: [] }, context, steps, 2);
    expect(migratedFrom).toBe(0);
    expect(document).toMatchObject({ schemaVersion: 2, trail: ['one', 'two'] });
  });

  it('explains which step failed', () => {
    const steps: Record<number, Migration> = {
      0: () => {
        throw new Error('objects are corrupt');
      },
    };
    expect(() => migrateDocument({ objects: [] }, context, steps, 1)).toThrow(
      expect.objectContaining({ code: 'MIGRATION_FAILED', migrationFrom: 0, message: expect.stringContaining('objects are corrupt') }),
    );
  });

  it('refuses a missing step or a step that lands on the wrong version', () => {
    expect(() => migrateDocument({ objects: [] }, context, {}, 1)).toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED' }));
    const skipping: Record<number, Migration> = { 0: (document) => ({ ...document, schemaVersion: 3 }) };
    expect(() => migrateDocument({ objects: [] }, context, skipping, 1)).toThrow(
      expect.objectContaining({ code: 'MIGRATION_FAILED', message: expect.stringContaining('produced version 3') }),
    );
  });
});

describe('version retention', () => {
  const summary = (id: string, kind: 'named' | 'auto', minute: number): VersionSummary => ({
    id,
    documentId: 'doc',
    name: id,
    kind,
    createdAt: `2026-01-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
    revision: minute,
  });

  it('keeps every named version and the newest automatic ones', () => {
    const versions = [summary('a1', 'auto', 1), summary('n1', 'named', 2), summary('a2', 'auto', 3), summary('a3', 'auto', 4)];
    expect(versionsToPrune(versions, 2).map((version) => version.id)).toEqual(['a1']);
    expect(versionsToPrune(versions, 0).map((version) => version.id)).toEqual(['a3', 'a2', 'a1']);
  });
});

describe('versions in key value storage', () => {
  function versionOf(id: string, minute: number): DocumentVersion {
    return {
      id,
      documentId: 'doc',
      name: `Version ${id}`,
      kind: 'named',
      createdAt: `2026-01-01T10:0${minute}:00.000Z`,
      revision: minute,
      document: { schemaVersion: 1, id: 'doc' } as FabricDocument,
    };
  }

  it('saves, lists newest first, loads and deletes versions', async () => {
    const storage = createMemoryStorage();
    await storage.saveVersion(versionOf('first', 1));
    await storage.saveVersion(versionOf('second', 2));
    const listed = await storage.listVersions('doc');
    expect(listed.map((version) => version.id)).toEqual(['second', 'first']);
    expect(listed[0]).not.toHaveProperty('document');
    expect((await storage.loadVersion('doc', 'first')).document.id).toBe('doc');
    await storage.deleteVersion('doc', 'first');
    await expect(storage.loadVersion('doc', 'first')).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
  });

  it('keeps versions out of the document list and deletes them with their document', async () => {
    const storage = createMemoryStorage();
    await storage.saveDocument({ ...versionOf('x', 1).document, revision: 1 } as FabricDocument, {
      expectedRevision: 0,
      signal: new AbortController().signal,
    });
    await storage.saveVersion(versionOf('first', 1));
    expect(await storage.listDocuments()).toEqual(['doc']);
    await storage.deleteDocument('doc');
    expect(await storage.listVersions('doc')).toEqual([]);
  });
});
