import type { FabricDocument } from '../document/document-format';
import { DocumentEngineError, isDocumentEngineError } from '../engine/errors';
import type { DocumentStorage, SaveResult } from '../storage/storage-contract';
import { createAutosaveScheduler } from './autosave-scheduler';
import type { AutosaveOptions } from './autosave-scheduler';
import { isRetryable, retryDelay, wait } from './retry';
import type { RetryOptions } from './retry';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';

export interface SaveState {
  status: SaveStatus;
  isDirty: boolean;
  isSaving: boolean;
  revision: number;
  lastSavedAt: string | undefined;
  error: DocumentEngineError | undefined;
}

export interface SaveOptions {
  overwrite?: boolean;
}

export interface SaveRetryEvent {
  attempt: number;
  delay: number;
  error: unknown;
}

export interface SaveController {
  save(options?: SaveOptions): Promise<FabricDocument>;
  noteContentChange(): void;
  startSession(revision: number): void;
  state(): SaveState;
  destroy(): void;
}

interface SaveControllerOptions {
  getStorage: () => DocumentStorage;
  createDocument: () => FabricDocument;
  retry?: RetryOptions;
  autosave?: AutosaveOptions | false;
  onStateChange: (state: SaveState) => void;
  onStart: (document: FabricDocument) => void;
  onSuccess: (document: FabricDocument) => void;
  onError: (error: DocumentEngineError) => void;
  onRetry: (event: SaveRetryEvent) => void;
}

function cancelledError(): DocumentEngineError {
  return new DocumentEngineError('SAVE_CANCELLED', 'The save was cancelled because another document was opened');
}

function toSaveError(error: unknown, signal: AbortSignal): DocumentEngineError {
  if (isDocumentEngineError(error)) return error;
  if (signal.aborted) return cancelledError();
  const hints = (error ?? {}) as { code?: unknown; message?: unknown };
  const reason = typeof hints.message === 'string' ? hints.message : String(error);
  if (hints.code === 'SAVE_CONFLICT') return new DocumentEngineError('SAVE_CONFLICT', reason, { cause: error });
  return new DocumentEngineError('SAVE_FAILED', `Storage could not save the document: ${reason}`, {
    cause: error,
    retryable: isRetryable(error),
  });
}

export function createSaveController(options: SaveControllerOptions): SaveController {
  const attempts = Math.max(0, options.retry?.attempts ?? 3);
  let contentVersion = 0;
  let savedVersion = 0;
  let revision = 0;
  let lastSavedAt: string | undefined;
  let lastError: DocumentEngineError | undefined;
  let saving = false;
  let session = 0;
  let sessionAbort = new AbortController();
  let inFlight: Promise<FabricDocument> | null = null;
  let queued: Promise<FabricDocument> | null = null;

  const isDirty = (): boolean => contentVersion !== savedVersion;

  function state(): SaveState {
    let status: SaveStatus = isDirty() ? 'unsaved' : 'saved';
    if (lastError) status = lastError.code === 'SAVE_CONFLICT' ? 'conflict' : 'error';
    if (saving) status = 'saving';
    return { status, isDirty: isDirty(), isSaving: saving, revision, lastSavedAt, error: lastError };
  }

  const publish = (): void => options.onStateChange(state());

  const autosave =
    options.autosave === false || options.autosave === undefined
      ? null
      : createAutosaveScheduler(() => {
          if (isDirty()) save().catch(() => undefined);
        }, options.autosave);

  async function sendWithRetries(
    storage: DocumentStorage,
    document: FabricDocument,
    expectedRevision: number | null,
    signal: AbortSignal,
  ): Promise<void | SaveResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await storage.saveDocument(document, { expectedRevision, signal });
      } catch (error) {
        if (signal.aborted || !isRetryable(error) || attempt >= attempts) throw error;
        const delay = retryDelay(attempt, options.retry);
        options.onRetry({ attempt: attempt + 1, delay, error });
        await wait(delay, signal);
      }
    }
  }

  async function runSave(saveOptions: SaveOptions): Promise<FabricDocument> {
    const storage = options.getStorage();
    const sessionAtStart = session;
    const { signal } = sessionAbort;
    const versionAtSnapshot = contentVersion;
    const document: FabricDocument = { ...options.createDocument(), revision: revision + 1 };
    const expectedRevision = saveOptions.overwrite === true ? null : revision;

    saving = true;
    lastError = undefined;
    publish();
    options.onStart(document);
    try {
      const result = await sendWithRetries(storage, document, expectedRevision, signal);
      if (sessionAtStart !== session) return document;
      revision = result?.revision ?? document.revision!;
      document.revision = revision;
      savedVersion = versionAtSnapshot;
      lastSavedAt = new Date().toISOString();
      options.onSuccess(document);
      return document;
    } catch (error) {
      const saveError = toSaveError(error, signal);
      if (sessionAtStart === session) {
        lastError = saveError;
        options.onError(saveError);
      }
      throw saveError;
    } finally {
      if (sessionAtStart === session) {
        saving = false;
        publish();
      }
    }
  }

  function save(saveOptions: SaveOptions = {}): Promise<FabricDocument> {
    if (inFlight === null) {
      inFlight = runSave(saveOptions).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
    if (queued === null) {
      const sessionWhenQueued = session;
      queued = inFlight
        .catch(() => undefined)
        .then(() => {
          queued = null;
          if (sessionWhenQueued !== session) throw cancelledError();
          return save(saveOptions);
        });
    }
    return queued;
  }

  return {
    save,
    noteContentChange() {
      contentVersion += 1;
      autosave?.schedule();
      publish();
    },
    startSession(newRevision) {
      session += 1;
      sessionAbort.abort();
      sessionAbort = new AbortController();
      autosave?.cancel();
      saving = false;
      savedVersion = contentVersion;
      revision = newRevision;
      lastSavedAt = undefined;
      lastError = undefined;
      publish();
    },
    state,
    destroy() {
      session += 1;
      sessionAbort.abort();
      autosave?.cancel();
    },
  };
}
