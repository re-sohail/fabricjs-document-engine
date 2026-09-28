import { rewriteUrls } from '../assets/asset-pipeline';
import type { FabricDocument } from '../document/document-format';
import type { RecoveryStore } from './recovery-store';

export interface RecoveryOptions {
  store: RecoveryStore;
  interval?: number;
}

export interface RecoveryRecord {
  documentId: string;
  savedAt: string;
  baseRevision: number;
  document: FabricDocument;
  files: Record<string, Blob>;
}

export interface InterruptedLoad {
  documentId: string | undefined;
  startedAt: string;
}

export interface RecoveryController {
  schedule(): void;
  flush(): Promise<void>;
  cancel(): void;
  remove(documentId: string): Promise<void>;
  read(documentId: string): Promise<RecoveryRecord | undefined>;
  list(): Promise<RecoveryRecord[]>;
  markLoadStarted(documentId: string | undefined): Promise<void>;
  markLoadFinished(): Promise<void>;
  interruptedLoad(): Promise<InterruptedLoad | undefined>;
  destroy(): void;
}

interface RecoveryControllerOptions extends RecoveryOptions {
  createDocument: () => FabricDocument;
  shouldWrite: () => boolean;
  onCheckpoint: (record: RecoveryRecord) => void;
  onError: (error: unknown) => void;
}

const documentKeyPrefix = 'document:';
const unloadKeyPrefix = 'unload:';
const loadingKey = 'loading';

function documentKey(documentId: string): string {
  return `${documentKeyPrefix}${documentId}`;
}

function unloadKey(documentId: string): string {
  return `${unloadKeyPrefix}${documentId}`;
}

function newerRecord(checkpoint: RecoveryRecord | undefined, unloadCopy: RecoveryRecord | undefined): RecoveryRecord | undefined {
  if (!unloadCopy) return checkpoint;
  if (!checkpoint || unloadCopy.savedAt > checkpoint.savedAt) {
    return { ...unloadCopy, files: { ...checkpoint?.files, ...unloadCopy.files } };
  }
  return checkpoint;
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  const record = value as Partial<RecoveryRecord> | undefined;
  return typeof record?.documentId === 'string' && typeof record.document === 'object' && record.document !== null;
}

export async function restoreRecordedFiles(record: RecoveryRecord): Promise<FabricDocument> {
  const document = JSON.parse(JSON.stringify(record.document)) as FabricDocument;
  const recreatedUrls = new Map<string, string>();
  await rewriteUrls(document, async (url) => {
    const blob = record.files[url];
    if (!blob) return url;
    const recreated = recreatedUrls.get(url) ?? URL.createObjectURL(blob);
    recreatedUrls.set(url, recreated);
    return recreated;
  });
  return document;
}

export function createRecoveryController(options: RecoveryControllerOptions): RecoveryController {
  const { store } = options;
  const interval = options.interval ?? 2000;
  const capturedFiles = new Map<string, Promise<Blob>>();
  const readyFiles = new Map<string, Blob>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let checkpointWaiting: Promise<void> | undefined;

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = queue.then(task).catch(options.onError);
    queue = run;
    return run;
  }

  async function captureTabOnlyFiles(document: FabricDocument): Promise<Record<string, Blob>> {
    const files: Record<string, Blob> = {};
    await rewriteUrls(document, async (url) => {
      if (!url.startsWith('blob:')) return url;
      let capturing = capturedFiles.get(url);
      if (!capturing) {
        capturing = fetch(url).then((response) => response.blob());
        capturedFiles.set(url, capturing);
        capturing.then((blob) => readyFiles.set(url, blob), () => undefined);
        capturing.catch(() => capturedFiles.delete(url));
      }
      files[url] = await capturing;
      return url;
    });
    return files;
  }

  function createRecord(document: FabricDocument, files: Record<string, Blob>): RecoveryRecord {
    return {
      documentId: document.id,
      savedAt: new Date().toISOString(),
      baseRevision: document.revision ?? 0,
      document,
      files,
    };
  }

  async function writeCheckpoint(): Promise<void> {
    checkpointWaiting = undefined;
    if (!options.shouldWrite()) return;
    const document = options.createDocument();
    const record = createRecord(document, await captureTabOnlyFiles(document));
    await store.set(documentKey(document.id), record);
    options.onCheckpoint(record);
  }

  function writeCheckpointBeforeThePageCloses(): void {
    cancel();
    if (!options.shouldWrite()) return;
    const document = options.createDocument();
    if (store.setNow) {
      store.setNow(unloadKey(document.id), createRecord(document, {}));
      return;
    }
    const record = createRecord(document, Object.fromEntries(readyFiles));
    store.set(documentKey(document.id), record).then(() => options.onCheckpoint(record), options.onError);
  }

  async function read(documentId: string): Promise<RecoveryRecord | undefined> {
    await queue;
    const [checkpoint, unloadCopy] = await Promise.all([store.get(documentKey(documentId)), store.get(unloadKey(documentId))]);
    return newerRecord(
      isRecoveryRecord(checkpoint) ? checkpoint : undefined,
      isRecoveryRecord(unloadCopy) ? unloadCopy : undefined,
    );
  }

  function cancel(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function flush(): Promise<void> {
    cancel();
    checkpointWaiting ??= enqueue(writeCheckpoint);
    return checkpointWaiting;
  }

  const handlePageHidden = (): void => writeCheckpointBeforeThePageCloses();
  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') writeCheckpointBeforeThePageCloses();
  };
  const pageEvents = typeof window === 'undefined' ? undefined : window;
  pageEvents?.addEventListener('pagehide', handlePageHidden);
  pageEvents?.document.addEventListener('visibilitychange', handleVisibilityChange);

  return {
    schedule() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, interval);
    },
    flush,
    cancel,
    remove: (documentId) =>
      enqueue(async () => {
        await store.delete(unloadKey(documentId));
        await store.delete(documentKey(documentId));
      }),
    read,
    async list() {
      await queue;
      const documentIds = new Set<string>();
      for (const key of await store.keys()) {
        if (key.startsWith(documentKeyPrefix)) documentIds.add(key.slice(documentKeyPrefix.length));
        if (key.startsWith(unloadKeyPrefix)) documentIds.add(key.slice(unloadKeyPrefix.length));
      }
      const records = await Promise.all([...documentIds].map(read));
      return records
        .filter((record): record is RecoveryRecord => record !== undefined)
        .sort((first, second) => second.savedAt.localeCompare(first.savedAt));
    },
    markLoadStarted: (documentId) =>
      store.set(loadingKey, { documentId, startedAt: new Date().toISOString() }).catch(options.onError),
    markLoadFinished: () => store.delete(loadingKey).catch(options.onError),
    async interruptedLoad() {
      const marker = (await store.get(loadingKey)) as InterruptedLoad | undefined;
      return marker && typeof marker.startedAt === 'string' ? marker : undefined;
    },
    destroy() {
      cancel();
      pageEvents?.removeEventListener('pagehide', handlePageHidden);
      pageEvents?.document.removeEventListener('visibilitychange', handleVisibilityChange);
    },
  };
}
