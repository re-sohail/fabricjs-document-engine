import type { FabricDocument } from '../document/document-format';
import { DocumentEngineError, createConflictError } from '../engine/errors';
import { newestFirst, summarize } from '../versions/document-version';
import type { DocumentVersion, VersionStorage, VersionSummary } from '../versions/document-version';
import type { DocumentStorage } from './storage-contract';

export interface KeyValueStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

export interface ManagedDocumentStorage extends DocumentStorage, VersionStorage {
  listDocuments(): Promise<string[]>;
  deleteDocument(id: string): Promise<void>;
}

function readRevision(json: string | null): number {
  if (json === null) return 0;
  const revision = (JSON.parse(json) as { revision?: unknown }).revision;
  return typeof revision === 'number' ? revision : 0;
}

export function createKeyValueStorage(store: KeyValueStore, prefix: string): ManagedDocumentStorage {
  const versionMarker = '::version::';
  const keyFor = (id: string): string => `${prefix}${id}`;
  const versionPrefixFor = (documentId: string): string => `${keyFor(documentId)}${versionMarker}`;
  const versionKeyFor = (documentId: string, versionId: string): string => `${versionPrefixFor(documentId)}${versionId}`;

  function readVersion(documentId: string, versionId: string): DocumentVersion {
    const json = store.read(versionKeyFor(documentId, versionId));
    if (json === null) {
      throw new DocumentEngineError('VERSION_NOT_FOUND', `Document "${documentId}" has no version "${versionId}"`);
    }
    return JSON.parse(json) as DocumentVersion;
  }

  function versionKeysOf(documentId: string): string[] {
    const versionPrefix = versionPrefixFor(documentId);
    return store.keys().filter((key) => key.startsWith(versionPrefix));
  }

  return {
    async loadDocument(id) {
      const json = store.read(keyFor(id));
      if (json === null) throw new DocumentEngineError('DOCUMENT_NOT_FOUND', `No document is stored with id "${id}"`);
      return JSON.parse(json);
    },
    async saveDocument(document: FabricDocument, { expectedRevision }) {
      const storedRevision = readRevision(store.read(keyFor(document.id)));
      if (expectedRevision !== null && storedRevision !== expectedRevision) {
        throw createConflictError(document.id, expectedRevision, storedRevision);
      }
      const revision = expectedRevision === null ? storedRevision + 1 : (document.revision ?? storedRevision + 1);
      store.write(keyFor(document.id), JSON.stringify({ ...document, revision }));
      return { revision };
    },
    async listDocuments() {
      return store
        .keys()
        .filter((key) => key.startsWith(prefix) && !key.includes(versionMarker))
        .map((key) => key.slice(prefix.length));
    },
    async deleteDocument(id) {
      versionKeysOf(id).forEach((key) => store.remove(key));
      store.remove(keyFor(id));
    },
    async saveVersion(version) {
      store.write(versionKeyFor(version.documentId, version.id), JSON.stringify(version));
    },
    async listVersions(documentId): Promise<VersionSummary[]> {
      return versionKeysOf(documentId)
        .map((key) => summarize(JSON.parse(store.read(key) ?? 'null') as DocumentVersion))
        .sort(newestFirst);
    },
    async loadVersion(documentId, versionId) {
      return readVersion(documentId, versionId);
    },
    async deleteVersion(documentId, versionId) {
      store.remove(versionKeyFor(documentId, versionId));
    },
  };
}
