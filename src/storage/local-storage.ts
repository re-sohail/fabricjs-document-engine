import { DocumentEngineError } from '../engine/errors';
import { createKeyValueStorage } from './key-value-storage';
import type { ManagedDocumentStorage } from './key-value-storage';

export interface LocalStorageOptions {
  prefix?: string;
  storage?: Storage;
}

function writeOrExplain(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch (error) {
    throw new DocumentEngineError('SAVE_FAILED', 'The browser refused to store the document, it may be out of space', {
      cause: error,
      retryable: false,
    });
  }
}

export function createLocalStorage(options: LocalStorageOptions = {}): ManagedDocumentStorage {
  const storage = options.storage ?? globalThis.localStorage;
  return createKeyValueStorage(
    {
      read: (key) => storage.getItem(key),
      write: (key, value) => writeOrExplain(storage, key, value),
      remove: (key) => storage.removeItem(key),
      keys: () => Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? ''),
    },
    options.prefix ?? 'fabric-document:',
  );
}
