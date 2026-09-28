export { createMemoryStorage } from './storage/memory-storage';
export { createLocalStorage } from './storage/local-storage';
export type { LocalStorageOptions } from './storage/local-storage';
export { createKeyValueStorage } from './storage/key-value-storage';
export type { KeyValueStore, ManagedDocumentStorage } from './storage/key-value-storage';
export type { DocumentStorage, SaveContext, SaveResult } from './storage/storage-contract';
export type { DocumentVersion, VersionStorage, VersionSummary } from './versions/document-version';
export { verifyStorageAdapter } from './storage/verify-storage-adapter';
export type { AdapterCheck, AdapterReport } from './storage/verify-storage-adapter';
