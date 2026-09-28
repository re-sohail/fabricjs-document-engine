import { createKeyValueStorage } from './key-value-storage';
import type { ManagedDocumentStorage } from './key-value-storage';

export function createMemoryStorage(): ManagedDocumentStorage {
  const records = new Map<string, string>();
  return createKeyValueStorage(
    {
      read: (key) => records.get(key) ?? null,
      write: (key, value) => {
        records.set(key, value);
      },
      remove: (key) => {
        records.delete(key);
      },
      keys: () => [...records.keys()],
    },
    '',
  );
}
