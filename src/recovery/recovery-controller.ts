import { rewriteUrls } from '../assets/asset-pipeline';
import type { FabricDocument } from '../document/document-format';
import { createId } from '../document/ids';
import type { RecoveryStore } from './recovery-store';

export interface RecoveryOptions {
  store: RecoveryStore;
  interval?: number;
}

export interface RecoveryRecord {
  documentId: string;
  /**
   * The editor session (one per engine, so one per tab) that wrote this copy.
   * Two tabs editing the same document keep separate copies. `legacy` marks
   * a copy written before 1.2.
   */
  sessionId: string;
  /** True while the session that wrote the copy is still open in a tab, when the browser can tell. */
  active: boolean;
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
  writeNow(): void;
  cancel(): void;
  /** Removes this session's copy of a document, after a save covered it. */
  remove(documentId: string): Promise<void>;
  /** Removes one session's copy, or every copy of the document. */
  discard(documentId: string, sessionId?: string): Promise<void>;
  /** The newest copy of a document, or the copy from one session. */
  read(documentId: string, sessionId?: string): Promise<RecoveryRecord | undefined>;
  readonly sessionId: string;
  /** Marks another session's copy as taken over by this session, so this session's next save removes it too. */
  adopt(documentId: string, sessionId: string): void;
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

interface StoredFile {
  type: string;
  bytes: ArrayBuffer;
}

type StoredRecord = Omit<RecoveryRecord, 'files' | 'active' | 'sessionId'> & {
  sessionId?: string;
  files: Record<string, StoredFile | Blob>;
};

async function toStoredFiles(files: Record<string, Blob>): Promise<Record<string, StoredFile>> {
  const entries = await Promise.all(
    Object.entries(files).map(async ([url, blob]) => [url, { type: blob.type, bytes: await blob.arrayBuffer() }] as const),
  );
  return Object.fromEntries(entries);
}

function fromStoredFiles(files: Record<string, StoredFile | Blob> | undefined): Record<string, Blob> {
  const restored: Record<string, Blob> = {};
  for (const [url, file] of Object.entries(files ?? {})) {
    restored[url] = file instanceof Blob ? file : new Blob([file.bytes], { type: file.type });
  }
  return restored;
}

function fromStoredRecord(value: unknown, sessionId: string, active: boolean): RecoveryRecord | undefined {
  if (!isRecoveryRecord(value)) return undefined;
  const stored = value as unknown as StoredRecord;
  return { ...stored, sessionId, active, files: fromStoredFiles(stored.files) };
}

/*
 * Keys. A copy belongs to a branch, the pair (session, document), so each
 * key is built and read in O(1). Session ids come from `createId` and never
 * contain `:`; document ids are encoded, so they may contain anything.
 *
 *   checkpoint:<session>:<document>   regular copy
 *   closing:<session>:<document>      quick copy written as the page closes
 *   loading:<session>                 a load in progress
 *
 * Copies from before 1.2 used `document:<id>`, `unload:<id>` and `loading`.
 * They are still read, as the `legacy` session, and removed on save.
 */
const LEGACY_SESSION = 'legacy';
const checkpointPrefix = 'checkpoint:';
const closingPrefix = 'closing:';
const loadingPrefix = 'loading:';
const legacyDocumentPrefix = 'document:';
const legacyUnloadPrefix = 'unload:';
const legacyLoadingKey = 'loading';

interface Branch {
  sessionId: string;
  documentId: string;
}

function branchKeys({ sessionId, documentId }: Branch): { checkpoint: string; closing: string } {
  if (sessionId === LEGACY_SESSION) {
    return { checkpoint: `${legacyDocumentPrefix}${documentId}`, closing: `${legacyUnloadPrefix}${documentId}` };
  }
  const document = encodeURIComponent(documentId);
  return { checkpoint: `${checkpointPrefix}${sessionId}:${document}`, closing: `${closingPrefix}${sessionId}:${document}` };
}

/** The branch a key belongs to, or undefined for keys that are not copies. */
function parseBranch(key: string): Branch | undefined {
  for (const prefix of [checkpointPrefix, closingPrefix]) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const separator = rest.indexOf(':');
    if (separator <= 0) return undefined;
    return { sessionId: rest.slice(0, separator), documentId: decodeURIComponent(rest.slice(separator + 1)) };
  }
  for (const prefix of [legacyDocumentPrefix, legacyUnloadPrefix]) {
    if (key.startsWith(prefix)) return { sessionId: LEGACY_SESSION, documentId: key.slice(prefix.length) };
  }
  return undefined;
}

const LOCK_PREFIX = 'fabricjs-document-engine/recovery/';

interface LockManagerLike {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: Array<{ name?: string }> }>;
}

function lockManager(): LockManagerLike | undefined {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return typeof locks?.request === 'function' && typeof locks.query === 'function' ? locks : undefined;
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
  const sessionId = createId();
  const own = (documentId: string): Branch => ({ sessionId, documentId });
  // Copies restored from other sessions, by document: a save covers them too.
  const adopted = new Map<string, Set<string>>();

  // Holding a lock for the life of this session lets other tabs see it is
  // still open (Web Locks API). Without the API every other session counts
  // as closed.
  const locks = lockManager();
  let releaseLock: (() => void) | undefined;
  locks
    ?.request(`${LOCK_PREFIX}${sessionId}`, () => new Promise<void>((resolve) => (releaseLock = resolve)))
    .catch(() => undefined);

  async function liveSessions(): Promise<Set<string>> {
    const live = new Set([sessionId]);
    if (!locks) return live;
    try {
      const { held = [] } = await locks.query();
      for (const lock of held) if (lock.name?.startsWith(LOCK_PREFIX)) live.add(lock.name.slice(LOCK_PREFIX.length));
    } catch {
      // Treat other sessions as closed.
    }
    return live;
  }
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
      sessionId,
      active: true,
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
    await store.set(branchKeys(own(document.id)).checkpoint, { ...record, files: await toStoredFiles(record.files) });
    options.onCheckpoint(record);
  }

  function writeCheckpointBeforeThePageCloses(): void {
    cancel();
    if (!options.shouldWrite()) return;
    const document = options.createDocument();
    const keys = branchKeys(own(document.id));
    if (store.setNow) {
      store.setNow(keys.closing, createRecord(document, {}));
      return;
    }
    const record = createRecord(document, Object.fromEntries(readyFiles));
    toStoredFiles(record.files)
      .then((files) => store.set(keys.checkpoint, { ...record, files }))
      .then(() => options.onCheckpoint(record), options.onError);
  }

  async function readBranch(branch: Branch, live: Set<string>): Promise<RecoveryRecord | undefined> {
    const keys = branchKeys(branch);
    const [checkpoint, closing] = await Promise.all([store.get(keys.checkpoint), store.get(keys.closing)]);
    const active = live.has(branch.sessionId);
    return newerRecord(fromStoredRecord(checkpoint, branch.sessionId, active), fromStoredRecord(closing, branch.sessionId, active));
  }

  /** Every branch in the store, de-duplicated, in one pass over the keys. */
  async function branches(documentId?: string): Promise<Branch[]> {
    const found = new Map<string, Branch>();
    for (const key of await store.keys()) {
      const branch = parseBranch(key);
      if (!branch || (documentId !== undefined && branch.documentId !== documentId)) continue;
      found.set(`${branch.sessionId}\u0000${branch.documentId}`, branch);
    }
    return [...found.values()];
  }

  async function readAll(documentId?: string): Promise<RecoveryRecord[]> {
    await queue;
    const live = await liveSessions();
    const records = await Promise.all((await branches(documentId)).map((branch) => readBranch(branch, live)));
    return records
      .filter((record): record is RecoveryRecord => record !== undefined)
      .sort((first, second) => second.savedAt.localeCompare(first.savedAt));
  }

  async function read(documentId: string, branchSession?: string): Promise<RecoveryRecord | undefined> {
    if (branchSession !== undefined) {
      await queue;
      return readBranch({ sessionId: branchSession, documentId }, await liveSessions());
    }
    return (await readAll(documentId))[0];
  }

  async function deleteBranch(branch: Branch): Promise<void> {
    const keys = branchKeys(branch);
    await store.delete(keys.closing);
    await store.delete(keys.checkpoint);
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
    writeNow: writeCheckpointBeforeThePageCloses,
    cancel,
    sessionId,
    // After a save: only this session's copy is covered by it. Copies from
    // before 1.2 had no session, so they go too.
    remove: (documentId) =>
      enqueue(async () => {
        await deleteBranch(own(documentId));
        await deleteBranch({ sessionId: LEGACY_SESSION, documentId });
        for (const other of adopted.get(documentId) ?? []) await deleteBranch({ sessionId: other, documentId });
        adopted.delete(documentId);
      }),
    adopt(documentId, other) {
      if (other === sessionId) return;
      const sessions = adopted.get(documentId) ?? new Set<string>();
      sessions.add(other);
      adopted.set(documentId, sessions);
    },
    discard: (documentId, branchSession) =>
      enqueue(async () => {
        const targets = branchSession === undefined ? await branches(documentId) : [{ sessionId: branchSession, documentId }];
        for (const branch of targets) await deleteBranch(branch);
      }),
    read,
    list: () => readAll(),
    markLoadStarted: (documentId) =>
      store.set(`${loadingPrefix}${sessionId}`, { documentId, startedAt: new Date().toISOString() }).catch(options.onError),
    // A finished load also clears markers left by sessions that are closed:
    // they were reported already, and a later load supersedes them.
    markLoadFinished: async () => {
      try {
        await store.delete(`${loadingPrefix}${sessionId}`);
        const live = await liveSessions();
        for (const key of await store.keys()) {
          const markerSession =
            key === legacyLoadingKey ? LEGACY_SESSION : key.startsWith(loadingPrefix) ? key.slice(loadingPrefix.length) : undefined;
          if (markerSession !== undefined && !live.has(markerSession)) await store.delete(key);
        }
      } catch (error) {
        options.onError(error);
      }
    },
    // A load counts as interrupted only when its session is no longer open.
    async interruptedLoad() {
      const live = await liveSessions();
      let newest: InterruptedLoad | undefined;
      for (const key of await store.keys()) {
        const markerSession =
          key === legacyLoadingKey ? LEGACY_SESSION : key.startsWith(loadingPrefix) ? key.slice(loadingPrefix.length) : undefined;
        if (markerSession === undefined || live.has(markerSession)) continue;
        const marker = (await store.get(key)) as InterruptedLoad | undefined;
        if (marker && typeof marker.startedAt === 'string' && (!newest || marker.startedAt > newest.startedAt)) newest = marker;
      }
      return newest;
    },
    destroy() {
      cancel();
      releaseLock?.();
      pageEvents?.removeEventListener('pagehide', handlePageHidden);
      pageEvents?.document.removeEventListener('visibilitychange', handleVisibilityChange);
    },
  };
}
