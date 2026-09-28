import type { FabricDocument } from '../document/document-format';
import { DocumentEngineError, createConflictError } from '../engine/errors';
import type { DocumentStorage } from './storage-contract';

export interface KeyValueStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

export interface ManagedDocumentStorage extends DocumentStorage {
  listDocuments(): Promise<string[]>;
  deleteDocument(id: string): Promise<void>;
}

function readRevision(json: string | null): number {
  if (json === null) return 0;
  const revision = (JSON.parse(json) as { revision?: unknown }).revision;
  return typeof revision === 'number' ? revision : 0;
}

export function createKeyValueStorage(store: KeyValueStore, prefix: string): ManagedDocumentStorage {
  const keyFor = (id: string): string => `${prefix}${id}`;

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
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    },
    async deleteDocument(id) {
      store.remove(keyFor(id));
    },
  };
}
