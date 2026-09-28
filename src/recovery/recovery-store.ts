export interface RecoveryStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  setNow?(key: string, value: unknown): void;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export function createMemoryRecovery(): RecoveryStore {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    setNow: (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
    keys: async () => [...values.keys()],
  };
}
