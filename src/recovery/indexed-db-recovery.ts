import type { RecoveryStore } from './recovery-store';

export interface IndexedDbRecoveryOptions {
  databaseName?: string;
  storeName?: string;
}

function requestToPromise<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function createIndexedDbRecovery(options: IndexedDbRecoveryOptions = {}): RecoveryStore {
  const databaseName = options.databaseName ?? 'fabricjs-document-engine';
  const storeName = options.storeName ?? 'recovery';
  let opening: Promise<IDBDatabase> | undefined;
  let database: IDBDatabase | undefined;
  const emergencyPrefix = `${databaseName}/${storeName}:`;
  const emergencyStorage = browserStorage();

  function readEmergency(key: string): unknown {
    const json = emergencyStorage?.getItem(`${emergencyPrefix}${key}`);
    return json === null || json === undefined ? undefined : JSON.parse(json);
  }

  function emergencyKeys(): string[] {
    if (!emergencyStorage) return [];
    return Array.from({ length: emergencyStorage.length }, (_, index) => emergencyStorage.key(index) ?? '')
      .filter((key) => key.startsWith(emergencyPrefix))
      .map((key) => key.slice(emergencyPrefix.length));
  }

  function openDatabase(): Promise<IDBDatabase> {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
      };
      request.onsuccess = () => {
        database = request.result;
        resolve(request.result);
      };
      request.onerror = () => {
        opening = undefined;
        reject(request.error);
      };
    });
    return opening;
  }

  async function run<Result>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<Result>): Promise<Result> {
    const openDatabaseNow = database ?? (await openDatabase());
    const transaction = openDatabaseNow.transaction(storeName, mode);
    const result = requestToPromise(work(transaction.objectStore(storeName)));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return result;
  }

  return {
    get: async (key) => (await run('readonly', (store) => store.get(key))) ?? readEmergency(key),
    set: async (key, value) => {
      await run('readwrite', (store) => store.put(value, key));
    },
    setNow(key, value) {
      try {
        emergencyStorage?.setItem(`${emergencyPrefix}${key}`, JSON.stringify(value));
      } catch {
        return;
      }
    },
    delete: async (key) => {
      emergencyStorage?.removeItem(`${emergencyPrefix}${key}`);
      await run('readwrite', (store) => store.delete(key));
    },
    keys: async () => {
      const stored = (await run('readonly', (store) => store.getAllKeys())).map(String);
      return [...new Set([...stored, ...emergencyKeys()])];
    },
  };
}
