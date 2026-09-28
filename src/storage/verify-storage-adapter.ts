import { CURRENT_SCHEMA_VERSION } from '../document/document-format';
import type { FabricDocument } from '../document/document-format';
import { createId } from '../document/ids';
import { supportsVersions } from '../versions/document-version';
import type { DocumentVersion } from '../versions/document-version';
import type { DocumentStorage, SaveResult } from './storage-contract';

export interface AdapterCheck {
  name: string;
  passed: boolean;
  message?: string;
}

export interface AdapterReport {
  ok: boolean;
  checks: AdapterCheck[];
}

interface CleanupCapable {
  deleteDocument?: (id: string) => Promise<void>;
}

function sampleDocument(id: string, revision: number, label: string): FabricDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    createdAt: now,
    updatedAt: now,
    revision,
    canvas: { width: 100, height: 100 },
    objects: [{ type: 'Rect', id: `${id}-shape`, width: 10, height: 10, fill: label }],
    metadata: { label },
  };
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

export async function verifyStorageAdapter(storage: DocumentStorage): Promise<AdapterReport> {
  const checks: AdapterCheck[] = [];
  const documentId = `adapter-check-${createId()}`;
  const signal = new AbortController().signal;
  let revision = 0;

  async function check(name: string, work: () => Promise<string | undefined>): Promise<boolean> {
    try {
      const problem = await work();
      checks.push(problem === undefined ? { name, passed: true } : { name, passed: false, message: problem });
      return problem === undefined;
    } catch (error) {
      checks.push({ name, passed: false, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  async function saveAt(expectedRevision: number | null, label: string): Promise<number> {
    const result = (await storage.saveDocument(sampleDocument(documentId, (expectedRevision ?? revision) + 1, label), {
      expectedRevision,
      signal,
    })) as SaveResult | void;
    return result?.revision ?? (expectedRevision ?? revision) + 1;
  }

  const saved = await check('saves a new document when expectedRevision is 0', async () => {
    revision = await saveAt(0, 'first');
    return revision > 0 ? undefined : `returned revision ${revision}, expected a number above 0`;
  });

  if (saved) {
    await check('loads the document it saved', async () => {
      const loaded = (await storage.loadDocument(documentId)) as Partial<FabricDocument> | undefined;
      if (loaded?.id !== documentId) return `loaded id ${String(loaded?.id)}, expected ${documentId}`;
      if (loaded.metadata?.label !== 'first') return 'loaded content differs from what was saved';
      return undefined;
    });

    await check('refuses a save based on an old revision with code SAVE_CONFLICT', async () => {
      try {
        await saveAt(revision - 1, 'stale');
      } catch (error) {
        return codeOf(error) === 'SAVE_CONFLICT' ? undefined : `rejected with code ${String(codeOf(error))} instead of SAVE_CONFLICT`;
      }
      return 'the stale save was accepted, so an older tab could overwrite newer work';
    });

    await check('accepts a save based on the current revision', async () => {
      const next = await saveAt(revision, 'second');
      if (next <= revision) return `revision went from ${revision} to ${next}, it must increase`;
      revision = next;
      const loaded = (await storage.loadDocument(documentId)) as Partial<FabricDocument> | undefined;
      return loaded?.metadata?.label === 'second' ? undefined : 'the newer content was not stored';
    });

    await check('overwrites when expectedRevision is null', async () => {
      revision = await saveAt(null, 'overwritten');
      const loaded = (await storage.loadDocument(documentId)) as Partial<FabricDocument> | undefined;
      return loaded?.metadata?.label === 'overwritten' ? undefined : 'the overwrite was not stored';
    });
  }

  await check('rejects loading a document that does not exist', async () => {
    try {
      const missing = await storage.loadDocument(`adapter-check-missing-${createId()}`);
      return missing === undefined || missing === null
        ? 'resolved with nothing instead of rejecting, which hides a missing document'
        : 'returned a document for an id that was never saved';
    } catch {
      return undefined;
    }
  });

  if (supportsVersions(storage)) {
    const version: DocumentVersion = {
      id: `version-${createId()}`,
      documentId,
      name: 'Adapter check',
      kind: 'named',
      createdAt: new Date().toISOString(),
      revision,
      document: sampleDocument(documentId, revision, 'versioned'),
    };
    await check('keeps, lists, loads and deletes versions', async () => {
      await storage.saveVersion(version);
      const listed = await storage.listVersions(documentId);
      if (!listed.some((summary) => summary.id === version.id)) return 'listVersions did not include the saved version';
      if (listed.some((summary) => 'document' in summary)) return 'listVersions should return summaries without the document';
      const loaded = await storage.loadVersion(documentId, version.id);
      if (loaded.document.metadata.label !== 'versioned') return 'loadVersion returned different content';
      await storage.deleteVersion(documentId, version.id);
      const afterDelete = await storage.listVersions(documentId);
      return afterDelete.some((summary) => summary.id === version.id) ? 'deleteVersion did not remove the version' : undefined;
    });
  }

  await (storage as CleanupCapable).deleteDocument?.(documentId).catch(() => undefined);
  return { ok: checks.every((result) => result.passed), checks };
}
