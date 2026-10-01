import type { FabricObject, StaticCanvas } from 'fabric';
import { buildAssetManifest } from '../assets/asset-manifest';
import type { AssetManifest } from '../assets/asset-manifest';
import { inspectAssets, prepareAssetsForLoad, prepareAssetsForSave } from '../assets/asset-pipeline';
import type { AssetOptions, AssetReport, AssetWarning } from '../assets/asset-pipeline';
import { isSameUrl } from '../assets/image-check';
import { resolveExportArea } from '../export/export-area';
import { normalizeExportOptions } from '../export/export-options';
import type { ExportFormat, ExportOptions } from '../export/export-options';
import { preflightExport } from '../export/preflight-export';
import type { ExportPreflight } from '../export/preflight-export';
import { mimeTypes, renderRaster, renderSvg, withExportView } from '../export/render-export';
import { embedSvgAssets } from '../export/svg/embed-assets';
import { readSvg } from '../import/svg-import';
import type { SvgImportOptions, SvgImportResult } from '../import/svg-import';
import { CURRENT_SCHEMA_VERSION } from '../document/document-format';
import type { DocumentInfo, FabricDocument } from '../document/document-format';
import { createDocumentInfo } from '../document/create-document';
import type { NewDocumentOptions } from '../document/create-document';
import { createId } from '../document/ids';
import { validateDocument } from '../document/validate-document';
import { loadIntoCanvas, serializeCanvas } from '../fabric/fabric-adapter';
import { readObjectId, writeObjectId } from '../fabric/object-ids';
import { createObjectRegistry } from '../fabric/object-registry';
import type { CustomObjectDefinition } from '../fabric/object-registry';
import { collectSerializedTypes, walkObjects } from '../fabric/walk-objects';
import { createHistory } from '../history/create-history';
import type { HistoryOptions, HistoryState } from '../history/create-history';
import { migrateDocument } from '../migrations/migrate-document';
import { isSafeImageUrl, secureDocument } from '../security/content-limits';
import type { ContentLimits } from '../security/content-limits';
import type { MigrationContext } from '../migrations/migrate-document';
import { createRecoveryController, restoreRecordedFiles } from '../recovery/recovery-controller';
import { summarize, supportsVersions, versionsToPrune } from '../versions/document-version';
import type { DocumentVersion, VersionKind, VersionOptions, VersionStorage, VersionSummary } from '../versions/document-version';
import type { InterruptedLoad, RecoveryOptions, RecoveryRecord } from '../recovery/recovery-controller';
import type { AutosaveOptions } from '../save/autosave-scheduler';
import type { RetryOptions } from '../save/retry';
import { createSaveController } from '../save/save-controller';
import type { SaveOptions, SaveRetryEvent, SaveState } from '../save/save-controller';
import type { DocumentStorage } from '../storage/storage-contract';
import { DocumentEngineError, isDocumentEngineError } from './errors';
import { createEventEmitter } from './event-emitter';
import type { Unsubscribe } from './event-emitter';

export interface DocumentEngineOptions {
  canvas: StaticCanvas;
  storage?: DocumentStorage;
  customObjects?: CustomObjectDefinition[];
  document?: NewDocumentOptions;
  history?: HistoryOptions;
  autosave?: boolean | AutosaveOptions;
  saveRetry?: RetryOptions;
  assets?: AssetOptions;
  recovery?: RecoveryOptions;
  versions?: VersionOptions;
  limits?: ContentLimits;
}

export interface LoadOptions {
  restoreCanvasSize?: boolean;
  discardUnsavedChanges?: boolean;
  /** Cancels the load. The canvas keeps its current content and the load rejects with `LOAD_ABORTED`. */
  signal?: AbortSignal;
  /** Called as the load moves through its stages. The `load:progress` event carries the same values. */
  onProgress?: (progress: LoadProgress) => void;
}

/**
 * Where a load is. `prepare` covers validation and migration, `images` counts
 * images checked, `objects` counts top-level objects created, and `done` comes
 * once the canvas shows the document.
 */
export type LoadStage = 'prepare' | 'images' | 'objects' | 'done';

export interface LoadProgress {
  documentId: string | undefined;
  stage: LoadStage;
  done: number;
  total: number;
}

export interface NewDocumentRequest extends NewDocumentOptions {
  discardUnsavedChanges?: boolean;
}

export interface ImportOptions extends LoadOptions {
  id?: string;
  metadata?: Record<string, unknown>;
}

export interface ExportResult {
  format: ExportFormat;
  mimeType: string;
  blob: Blob;
  width: number;
  height: number;
  warnings: AssetWarning[];
  document?: FabricDocument;
}

export interface DocumentEngineEvents {
  'load:start': { documentId: string | undefined };
  'load:progress': LoadProgress;
  'document:change': { documentId: string };
  'load:success': { document: FabricDocument; warnings: AssetWarning[]; migratedFrom: number | undefined };
  'assets:warning': { warnings: AssetWarning[] };
  'load:error': { error: DocumentEngineError };
  'save:start': { document: FabricDocument };
  'save:success': { document: FabricDocument };
  'save:error': { error: DocumentEngineError };
  'save:retry': SaveRetryEvent;
  'save:status': SaveState;
  'history:change': HistoryState;
  'history:error': { error: DocumentEngineError };
  'recovery:checkpoint': { documentId: string; savedAt: string };
  'recovery:restored': { document: FabricDocument };
  'recovery:error': { error: DocumentEngineError };
  'export:success': { format: ExportFormat; width: number; height: number; warnings: AssetWarning[] };
  'export:error': { error: DocumentEngineError };
  'version:created': VersionSummary;
  'version:restored': { version: VersionSummary; document: FabricDocument };
  'version:error': { error: DocumentEngineError };
}

export interface DocumentEngine {
  readonly canvas: StaticCanvas;
  getDocumentInfo(): DocumentInfo;
  updateMetadata(changes: Record<string, unknown>): void;
  newDocument(options?: NewDocumentRequest): void;
  toDocument(): FabricDocument;
  loadDocument(document: unknown, options?: LoadOptions): Promise<FabricDocument>;
  load(documentId: string, options?: LoadOptions): Promise<FabricDocument>;
  importFabricJson(json: string | Record<string, unknown>, options?: ImportOptions): Promise<FabricDocument>;
  importSvg(svg: string, options?: SvgImportOptions): Promise<SvgImportResult>;
  createVersion(name?: string): Promise<VersionSummary>;
  listVersions(documentId?: string): Promise<VersionSummary[]>;
  restoreVersion(versionId: string): Promise<FabricDocument>;
  deleteVersion(versionId: string): Promise<void>;
  save(options?: SaveOptions): Promise<FabricDocument>;
  isDirty(): boolean;
  getSaveState(): SaveState;
  registerObject(definition: CustomObjectDefinition): void;
  transaction<Result>(label: string, work: () => Result): Result;
  commit(label?: string): boolean;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  canUndo(): boolean;
  canRedo(): boolean;
  getHistory(): { undo: string[]; redo: string[] };
  clearHistory(): void;
  getObjectById(id: string): FabricObject | undefined;
  getAssetManifest(): AssetManifest;
  checkAssets(): Promise<AssetReport>;
  replaceImage(oldUrl: string, newUrl: string): Promise<number>;
  export(options: ExportOptions): Promise<ExportResult>;
  preflightExport(options: ExportOptions): Promise<ExportPreflight>;
  flushRecovery(): Promise<void>;
  getRecoverableDocuments(): Promise<RecoveryRecord[]>;
  getRecovery(documentId?: string): Promise<RecoveryRecord | undefined>;
  restoreRecovery(documentId?: string, options?: LoadOptions): Promise<FabricDocument>;
  discardRecovery(documentId?: string): Promise<void>;
  getInterruptedLoad(): Promise<InterruptedLoad | undefined>;
  on<Name extends keyof DocumentEngineEvents>(
    name: Name,
    handler: (payload: DocumentEngineEvents[Name]) => void,
  ): Unsubscribe;
  destroy(): void;
}

interface ObjectEvent {
  target: FabricObject;
}

interface ReplaceableImage {
  getSrc(): string;
  setSrc(url: string, options?: { crossOrigin?: string | null }): Promise<unknown>;
  crossOrigin?: string | null;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

function isReplaceableImage(object: FabricObject): object is FabricObject & ReplaceableImage {
  const candidate = object as unknown as Partial<ReplaceableImage>;
  return typeof candidate.getSrc === 'function' && typeof candidate.setSrc === 'function';
}

function describeDocumentId(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : undefined;
}

export function createDocumentEngine(options: DocumentEngineOptions): DocumentEngine {
  const { canvas, storage } = options;
  if (options.autosave && !storage) {
    throw new DocumentEngineError('STORAGE_MISSING', 'Autosave needs a storage adapter passed to createDocumentEngine');
  }

  const registry = createObjectRegistry(options.customObjects);
  const events = createEventEmitter<DocumentEngineEvents>();
  const objectsById = new Map<string, FabricObject>();
  const assetOptions = options.assets ?? {};
  const uploadedUrls = new Map<string, Promise<string>>();
  let documentInfo = createDocumentInfo(options.document);
  let activeLoad: AbortController | null = null;
  let destroyed = false;

  function ensureUsable(): void {
    if (destroyed) throw new DocumentEngineError('ENGINE_DESTROYED', 'This document engine was destroyed');
  }

  function indexObjectTree(root: FabricObject): void {
    walkObjects([root], (object) => {
      let id = readObjectId(object);
      const owner = id === undefined ? undefined : objectsById.get(id);
      if (id === undefined || (owner !== undefined && owner !== object)) {
        id = createId();
        writeObjectId(object, id);
      }
      objectsById.set(id, object);
    });
  }

  function removeObjectTreeFromIndex(root: FabricObject): void {
    walkObjects([root], (object) => {
      const id = readObjectId(object);
      if (id !== undefined && objectsById.get(id) === object) objectsById.delete(id);
    });
  }

  function rebuildIndex(): void {
    objectsById.clear();
    canvas.getObjects().forEach(indexObjectTree);
  }

  const handleObjectAdded = ({ target }: ObjectEvent): void => indexObjectTree(target);
  const handleObjectRemoved = ({ target }: ObjectEvent): void => removeObjectTreeFromIndex(target);
  canvas.on('object:added', handleObjectAdded);
  canvas.on('object:removed', handleObjectRemoved);
  rebuildIndex();

  const history = createHistory({
    canvas,
    limit: options.history?.limit,
    maxBytes: options.history?.maxBytes,
    serializeObjects: () => {
      rebuildIndex();
      return serializeCanvas(canvas, registry.propertiesToInclude()).objects;
    },
    onChange: (state) => events.emit('history:change', state),
    onContentChange: () => noteContentChange(),
  });

  const saving = createSaveController({
    getStorage: () => requireStorage(),
    createDocument: async () => {
      const prepared = await prepareAssetsForSave(toDocument(), assetOptions, uploadedUrls);
      if (prepared.warnings.length > 0) events.emit('assets:warning', { warnings: prepared.warnings });
      return prepared.document;
    },
    retry: options.saveRetry,
    autosave: options.autosave === true ? {} : (options.autosave ?? false),
    onStateChange: (state) => events.emit('save:status', state),
    onStart: (document) => events.emit('save:start', { document }),
    onSuccess: (document) => {
      if (recovery && !saving.state().isDirty) void recovery.remove(document.id);
      events.emit('save:success', { document });
      createAutomaticVersionAfterSave(document);
    },
    onError: (error) => events.emit('save:error', { error }),
    onRetry: (event) => events.emit('save:retry', event),
  });

  const recovery = options.recovery
    ? createRecoveryController({
        ...options.recovery,
        createDocument: () => toDocument(),
        shouldWrite: () => !destroyed && saving.state().isDirty,
        onCheckpoint: (record) =>
          events.emit('recovery:checkpoint', { documentId: record.documentId, savedAt: record.savedAt }),
        onError: (error) => {
          const reason = error instanceof Error ? error.message : String(error);
          events.emit('recovery:error', {
            error: new DocumentEngineError('RECOVERY_FAILED', `Could not write the recovery copy: ${reason}`, {
              cause: error,
            }),
          });
        },
      })
    : undefined;

  function noteContentChange(): void {
    saving.noteContentChange();
    recovery?.schedule();
  }

  function toDocument(): FabricDocument {
    ensureUsable();
    rebuildIndex();
    const serialized = serializeCanvas(canvas, registry.propertiesToInclude());
    documentInfo = { ...documentInfo, updatedAt: new Date().toISOString() };
    const document: FabricDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: documentInfo.id,
      createdAt: documentInfo.createdAt,
      updatedAt: documentInfo.updatedAt,
      revision: saving.state().revision,
      canvas: { width: canvas.getWidth(), height: canvas.getHeight() },
      objects: serialized.objects,
      assets: buildAssetManifest(serialized.objects),
      metadata: { ...documentInfo.metadata },
    };
    if (serialized.version !== undefined) document.fabricVersion = serialized.version;
    if (serialized.background !== undefined) document.canvas.background = serialized.background;
    return document;
  }

  function toLoadError(error: unknown, controller: AbortController): DocumentEngineError {
    if (controller.signal.aborted) {
      const reason = cancelledByCaller.has(controller)
        ? 'Loading was cancelled'
        : destroyed
          ? 'Loading stopped because the engine was destroyed'
          : 'Loading stopped because a newer load started';
      return new DocumentEngineError('LOAD_ABORTED', reason, { cause: error });
    }
    if (isDocumentEngineError(error)) return error;
    const reason = error instanceof Error ? error.message : String(error);
    return new DocumentEngineError('LOAD_FAILED', `Fabric could not load the document: ${reason}`, { cause: error });
  }

  function checkDocument(input: unknown): FabricDocument {
    const issues = validateDocument(input);
    if (issues.length > 0) {
      const summary = issues.map((issue) => `${issue.path || 'document'} ${issue.message}`).join('; ');
      throw new DocumentEngineError(issues[0]!.code, `The document is not valid: ${summary}`, { issues });
    }
    const document = input as FabricDocument;
    const unknownTypes = registry.findUnknownTypes(collectSerializedTypes(document.objects));
    if (unknownTypes.length > 0) {
      throw new DocumentEngineError(
        'UNKNOWN_OBJECT_TYPE',
        `The document uses object types that are not registered: ${unknownTypes.join(', ')}. ` +
          'Register them with customObjects or engine.registerObject before loading.',
        { unknownTypes },
      );
    }
    return document;
  }

  function loadDocument(input: unknown, loadOptions: LoadOptions = {}): Promise<FabricDocument> {
    return loadMigratedDocument(input, loadOptions, {});
  }

  function protectUnsavedChanges(discardUnsavedChanges: boolean | undefined): void {
    if (!storage || discardUnsavedChanges || !saving.state().isDirty) return;
    throw new DocumentEngineError(
      'UNSAVED_CHANGES',
      'The current document has unsaved changes. Save first, or pass { discardUnsavedChanges: true } to replace it anyway.',
    );
  }

  const cancelledByCaller = new WeakSet<AbortController>();
  const unlinkCallerSignal = new WeakMap<AbortController, () => void>();

  function startLoad(callerSignal?: AbortSignal): AbortController {
    activeLoad?.abort();
    const controller = new AbortController();
    activeLoad = controller;
    if (callerSignal) {
      const cancel = (): void => {
        cancelledByCaller.add(controller);
        controller.abort();
      };
      if (callerSignal.aborted) cancel();
      else {
        callerSignal.addEventListener('abort', cancel, { once: true });
        unlinkCallerSignal.set(controller, () => callerSignal.removeEventListener('abort', cancel));
      }
    }
    return controller;
  }

  function finishLoad(controller: AbortController): void {
    unlinkCallerSignal.get(controller)?.();
    unlinkCallerSignal.delete(controller);
  }

  async function loadMigratedDocument(
    input: unknown,
    loadOptions: LoadOptions,
    importDetails: Pick<MigrationContext, 'id' | 'metadata'>,
    startedLoad?: AbortController,
  ): Promise<FabricDocument> {
    ensureUsable();
    protectUnsavedChanges(loadOptions.discardUnsavedChanges);
    const controller = startedLoad ?? startLoad(loadOptions.signal);
    const documentId = describeDocumentId(input);
    const report = (stage: LoadStage, done: number, total: number): void => {
      if (controller.signal.aborted) return;
      const progress: LoadProgress = { documentId, stage, done, total };
      loadOptions.onProgress?.(progress);
      events.emit('load:progress', progress);
    };
    events.emit('load:start', { documentId });

    try {
      if (controller.signal.aborted) throw new Error('aborted');
      report('prepare', 0, 1);
      await recovery?.markLoadStarted(documentId);
      if (controller.signal.aborted) throw new Error('aborted');
      const { document: migrated, migratedFrom } = migrateDocument(secureDocument(input, options.limits), {
        canvasWidth: canvas.getWidth(),
        canvasHeight: canvas.getHeight(),
        ...importDetails,
      });
      const checked = checkDocument(migrated);
      report('prepare', 1, 1);
      const { document, warnings } = await prepareAssetsForLoad(
        checked,
        assetOptions,
        controller.signal,
        options.limits?.isAllowedUrl,
        (done, total) => report('images', done, total),
      );
      if (controller.signal.aborted) throw new Error('aborted');
      await history.withoutRecording(() =>
        loadIntoCanvas(
          canvas,
          { version: document.fabricVersion, background: document.canvas.background, objects: document.objects },
          { signal: controller.signal, onObjects: (done, total) => report('objects', done, total) },
        ),
      );
      if (controller.signal.aborted) throw new Error('aborted');
      if (loadOptions.restoreCanvasSize ?? true) {
        canvas.setDimensions({ width: document.canvas.width, height: document.canvas.height });
      }
      documentInfo = {
        id: document.id,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        metadata: { ...document.metadata },
      };
      rebuildIndex();
      history.reset();
      recovery?.cancel();
      saving.startSession(document.revision ?? 0);
      canvas.requestRenderAll();
      report('done', 1, 1);
      if (warnings.length > 0) events.emit('assets:warning', { warnings });
      events.emit('document:change', { documentId: document.id });
      events.emit('load:success', { document, warnings, migratedFrom });
      return document;
    } catch (error) {
      const engineError = toLoadError(error, controller);
      events.emit('load:error', { error: engineError });
      throw engineError;
    } finally {
      finishLoad(controller);
      if (activeLoad === controller) {
        activeLoad = null;
        await recovery?.markLoadFinished();
      }
    }
  }

  function importFabricJson(json: string | Record<string, unknown>, importOptions: ImportOptions = {}): Promise<FabricDocument> {
    let parsed: unknown = json;
    if (typeof json === 'string') {
      try {
        parsed = JSON.parse(json);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return Promise.reject(new DocumentEngineError('INVALID_DOCUMENT', `The text is not valid JSON: ${reason}`, { cause: error }));
      }
    }
    const { id, metadata, ...loadOptions } = importOptions;
    return loadMigratedDocument(parsed, loadOptions, { id, metadata });
  }

  async function importSvg(svg: string, importOptions: SvgImportOptions = {}): Promise<SvgImportResult> {
    ensureUsable();
    const result = await readSvg(svg, importOptions, options.limits);
    ensureUsable();
    if (result.objects.length > 0) {
      history.transaction('Import SVG', () => canvas.add(...result.objects));
      canvas.requestRenderAll();
    }
    return result;
  }

  let savesSinceAutomaticVersion = 0;
  let lastVersionTime = 0;

  function nextVersionTimestamp(): string {
    lastVersionTime = Math.max(Date.now(), lastVersionTime + 1);
    return new Date(lastVersionTime).toISOString();
  }

  function requireVersions(): VersionStorage {
    ensureUsable();
    if (!supportsVersions(storage)) {
      throw new DocumentEngineError(
        'VERSIONS_UNSUPPORTED',
        'The storage adapter needs saveVersion, listVersions, loadVersion and deleteVersion to keep versions',
      );
    }
    return storage;
  }

  async function pruneAutomaticVersions(versionStorage: VersionStorage, documentId: string): Promise<void> {
    const keepAuto = options.versions?.keepAuto ?? 20;
    const existing = await versionStorage.listVersions(documentId);
    await Promise.all(versionsToPrune(existing, keepAuto).map((version) => versionStorage.deleteVersion(documentId, version.id)));
  }

  async function storeVersion(name: string, kind: VersionKind, document?: FabricDocument): Promise<VersionSummary> {
    const versionStorage = requireVersions();
    const content = document ?? (await prepareAssetsForSave(toDocument(), assetOptions, uploadedUrls)).document;
    const version: DocumentVersion = {
      id: createId(),
      documentId: content.id,
      name,
      kind,
      createdAt: nextVersionTimestamp(),
      revision: content.revision ?? saving.state().revision,
      document: content,
    };
    await versionStorage.saveVersion(version);
    await pruneAutomaticVersions(versionStorage, content.id);
    const summary = summarize(version);
    events.emit('version:created', summary);
    return summary;
  }

  function reportVersionError(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const engineError = isDocumentEngineError(error)
      ? error
      : new DocumentEngineError('VERSION_FAILED', `Could not keep an automatic version: ${reason}`, { cause: error });
    events.emit('version:error', { error: engineError });
  }

  function createAutomaticVersionAfterSave(document: FabricDocument): void {
    const every = options.versions?.autoEvery ?? 0;
    if (every <= 0 || !supportsVersions(storage)) return;
    savesSinceAutomaticVersion += 1;
    if (savesSinceAutomaticVersion < every) return;
    savesSinceAutomaticVersion = 0;
    storeVersion(`Autosave ${new Date().toLocaleString()}`, 'auto', document).catch(reportVersionError);
  }

  async function restoreVersion(versionId: string): Promise<FabricDocument> {
    const versionStorage = requireVersions();
    const current = documentInfo;
    const version = await versionStorage.loadVersion(current.id, versionId);
    await storeVersion(`Before restoring "${version.name}"`, 'auto');
    const { document: migrated } = migrateDocument(version.document, {
      canvasWidth: canvas.getWidth(),
      canvasHeight: canvas.getHeight(),
    });
    const baseRevision = saving.state().revision;
    const loaded = await loadDocument(
      {
        ...(migrated as FabricDocument),
        id: current.id,
        createdAt: current.createdAt,
        revision: baseRevision,
      },
      { discardUnsavedChanges: true },
    );
    noteContentChange();
    events.emit('version:restored', { version: summarize(version), document: loaded });
    return loaded;
  }

  function requireStorage(): DocumentStorage {
    if (!storage) {
      throw new DocumentEngineError('STORAGE_MISSING', 'Pass a storage adapter to createDocumentEngine to use load and save');
    }
    return storage;
  }

  async function load(documentId: string, loadOptions?: LoadOptions): Promise<FabricDocument> {
    ensureUsable();
    const source = requireStorage();
    protectUnsavedChanges(loadOptions?.discardUnsavedChanges);
    // Claim the load before reading storage, so a slow response for an older
    // id cannot replace a newer load that finished first.
    const controller = startLoad(loadOptions?.signal);
    let stored: unknown;
    try {
      if (controller.signal.aborted) throw new Error('aborted');
      stored = await source.loadDocument(documentId);
      if (controller.signal.aborted) throw new Error('aborted');
    } catch (error) {
      finishLoad(controller);
      if (activeLoad === controller) activeLoad = null;
      if (controller.signal.aborted) {
        const aborted = toLoadError(error, controller);
        events.emit('load:error', { error: aborted });
        throw aborted;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const engineError = isDocumentEngineError(error)
        ? error
        : new DocumentEngineError('LOAD_FAILED', `Storage could not load "${documentId}": ${reason}`, { cause: error });
      events.emit('load:error', { error: engineError });
      throw engineError;
    }
    return loadMigratedDocument(stored, loadOptions ?? {}, { id: documentId }, controller);
  }

  function save(saveOptions?: SaveOptions): Promise<FabricDocument> {
    try {
      ensureUsable();
    } catch (error) {
      return Promise.reject(error);
    }
    // Objects added in this same task are noted a microtask later. Note them
    // now, so the save counts them and the document ends up clean.
    history.flush();
    return saving.save(saveOptions);
  }

  function newDocument(newOptions: NewDocumentRequest = {}): void {
    ensureUsable();
    protectUnsavedChanges(newOptions.discardUnsavedChanges);
    activeLoad?.abort();
    history.withoutRecording(() => canvas.clear());
    objectsById.clear();
    documentInfo = createDocumentInfo(newOptions);
    uploadedUrls.clear();
    history.reset();
    recovery?.cancel();
    saving.startSession(0);
    events.emit('document:change', { documentId: documentInfo.id });
  }

  function getObjectById(id: string): FabricObject | undefined {
    ensureUsable();
    const indexed = objectsById.get(id);
    if (indexed !== undefined) return indexed;
    rebuildIndex();
    return objectsById.get(id);
  }

  function checkAssets(): Promise<AssetReport> {
    ensureUsable();
    return inspectAssets(toDocument(), assetOptions, new AbortController().signal);
  }

  async function replaceImage(oldUrl: string, newUrl: string): Promise<number> {
    ensureUsable();
    const images: Array<FabricObject & ReplaceableImage> = [];
    walkObjects(canvas.getObjects(), (object) => {
      if (isReplaceableImage(object) && isSameUrl(object.getSrc(), oldUrl)) images.push(object);
    });
    if (images.length === 0) return 0;

    await history.transaction('Replace image', () =>
      Promise.all(
        images.map(async (image) => {
          const displayedWidth = image.width * image.scaleX;
          const displayedHeight = image.height * image.scaleY;
          await image.setSrc(newUrl, { crossOrigin: image.crossOrigin ?? null });
          image.set({ scaleX: displayedWidth / image.width, scaleY: displayedHeight / image.height });
          image.setCoords();
        }),
      ),
    );
    canvas.requestRenderAll();
    return images.length;
  }

  function fontsOnCanvas(): ReturnType<typeof buildAssetManifest>['fonts'] {
    rebuildIndex();
    return buildAssetManifest(serializeCanvas(canvas, registry.propertiesToInclude()).objects).fonts;
  }

  async function checkBeforeExport(exportOptions: ExportOptions): Promise<ExportPreflight> {
    ensureUsable();
    const { format, svg } = normalizeExportOptions(exportOptions);
    return preflightExport(canvas, format, format === 'json' ? [] : fontsOnCanvas(), assetOptions, svg);
  }

  function describeProblems(check: ExportPreflight): string {
    return check.problems.map((problem) => problem.message).join('; ');
  }

  async function exportContent(exportOptions: ExportOptions): Promise<ExportResult> {
    const settings = normalizeExportOptions(exportOptions);
    const stopIfCancelled = (): void => {
      if (settings.signal?.aborted) throw new DocumentEngineError('EXPORT_ABORTED', 'The export was cancelled');
    };
    stopIfCancelled();

    if (settings.format === 'json') {
      const prepared = await prepareAssetsForSave(toDocument(), assetOptions, uploadedUrls);
      stopIfCancelled();
      return {
        format: 'json',
        mimeType: mimeTypes.json,
        blob: new Blob([JSON.stringify(prepared.document)], { type: mimeTypes.json }),
        width: prepared.document.canvas.width,
        height: prepared.document.canvas.height,
        warnings: prepared.warnings,
        document: prepared.document,
      };
    }

    const check = await checkBeforeExport(settings);
    stopIfCancelled();
    if (!check.ok) {
      throw new DocumentEngineError('EXPORT_BLOCKED', `The export cannot run: ${describeProblems(check)}`, {
        problems: check.problems,
      });
    }

    const format = settings.format;
    try {
      const warnings = [...check.warnings];
      const rendered = withExportView(canvas, settings.background, format, () => {
        const area = resolveExportArea(canvas, settings.area, settings.padding);
        const content =
          format === 'svg'
            ? Promise.resolve(renderSvg(canvas, area, settings.scale, settings.svg))
            : renderRaster(canvas, area, format, settings.scale, settings.quality);
        return { area, content };
      });
      let blob: Blob;
      if (format === 'svg') {
        const embedded = await embedSvgAssets(
          (await rendered.content) as string,
          canvas,
          settings.svg,
          settings.signal,
          options.limits?.isAllowedUrl ?? isSafeImageUrl,
        );
        stopIfCancelled();
        if (settings.svg.embedImages === 'require' && embedded.problems.length > 0) {
          const problems = embedded.warnings
            .filter((warning) => warning.code === 'IMAGE_NOT_EMBEDDED')
            .map((warning) => ({ code: 'IMAGE_NOT_EMBEDDED' as const, message: warning.message, url: warning.url, objectIds: warning.objectIds }));
          throw new DocumentEngineError('EXPORT_BLOCKED', `The export cannot run: ${embedded.problems.join('; ')}`, { problems });
        }
        warnings.push(...embedded.warnings);
        blob = new Blob([embedded.svg], { type: mimeTypes.svg });
      } else {
        blob = (await rendered.content) as Blob;
      }
      return {
        format,
        mimeType: blob.type || mimeTypes[format],
        blob,
        width: Math.round(rendered.area.width * settings.scale),
        height: Math.round(rendered.area.height * settings.scale),
        warnings,
      };
    } catch (error) {
      if (isDocumentEngineError(error)) throw error;
      if (settings.signal?.aborted) throw new DocumentEngineError('EXPORT_ABORTED', 'The export was cancelled', { cause: error });
      if ((error as { name?: unknown } | null)?.name === 'SecurityError') {
        const problem = {
          code: 'CROSS_ORIGIN_IMAGE' as const,
          message: 'The browser blocked the export because the canvas shows an image from another site without CORS',
          objectIds: [],
        };
        throw new DocumentEngineError('EXPORT_BLOCKED', problem.message, { problems: [problem], cause: error });
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new DocumentEngineError('EXPORT_FAILED', `Fabric could not export the canvas: ${reason}`, { cause: error });
    }
  }

  async function exportDocument(exportOptions: ExportOptions): Promise<ExportResult> {
    ensureUsable();
    try {
      const result = await exportContent(exportOptions);
      events.emit('export:success', {
        format: result.format,
        width: result.width,
        height: result.height,
        warnings: result.warnings,
      });
      return result;
    } catch (error) {
      const engineError = isDocumentEngineError(error)
        ? error
        : new DocumentEngineError('EXPORT_FAILED', String(error), { cause: error });
      events.emit('export:error', { error: engineError });
      throw engineError;
    }
  }

  function requireRecovery(): NonNullable<typeof recovery> {
    ensureUsable();
    if (!recovery) {
      throw new DocumentEngineError('RECOVERY_MISSING', 'Pass recovery: { store } to createDocumentEngine to use recovery');
    }
    return recovery;
  }

  async function restoreRecovery(documentId?: string, loadOptions?: LoadOptions): Promise<FabricDocument> {
    const source = requireRecovery();
    const id = documentId ?? documentInfo.id;
    const record = await source.read(id);
    if (!record) throw new DocumentEngineError('RECOVERY_NOT_FOUND', `There is no recovery copy for document "${id}"`);
    const loaded = await loadDocument(await restoreRecordedFiles(record), loadOptions);
    noteContentChange();
    events.emit('recovery:restored', { document: loaded });
    return loaded;
  }

  async function travelThroughHistory(direction: 'undo' | 'redo'): Promise<boolean> {
    ensureUsable();
    try {
      return await history[direction]();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const engineError = new DocumentEngineError('HISTORY_FAILED', `Could not ${direction}: ${reason}`, {
        cause: error,
      });
      events.emit('history:error', { error: engineError });
      throw engineError;
    }
  }

  function destroy(): void {
    if (destroyed) return;
    // A disposed Fabric canvas has already dropped its objects. Writing now would
    // replace the last good checkpoint with an empty page, so keep that one.
    const { disposed } = canvas as StaticCanvas & { disposed?: boolean };
    if (recovery && saving.state().isDirty && !disposed) recovery.writeNow();
    destroyed = true;
    activeLoad?.abort();
    history.destroy();
    saving.destroy();
    recovery?.destroy();
    canvas.off('object:added', handleObjectAdded);
    canvas.off('object:removed', handleObjectRemoved);
    objectsById.clear();
    events.clear();
  }

  return {
    canvas,
    getDocumentInfo: () => ({ ...documentInfo, metadata: { ...documentInfo.metadata } }),
    updateMetadata(changes) {
      ensureUsable();
      documentInfo = { ...documentInfo, metadata: { ...documentInfo.metadata, ...changes } };
      noteContentChange();
    },
    newDocument,
    toDocument,
    loadDocument,
    load,
    importFabricJson,
    importSvg,
    createVersion: (name) => storeVersion(name ?? `Version ${new Date().toLocaleString()}`, 'named'),
    listVersions: async (documentId) => requireVersions().listVersions(documentId ?? documentInfo.id),
    restoreVersion,
    deleteVersion: async (versionId) => requireVersions().deleteVersion(documentInfo.id, versionId),
    save,
    isDirty: () => saving.state().isDirty,
    getSaveState: () => saving.state(),
    registerObject(definition) {
      ensureUsable();
      registry.register(definition);
    },
    getObjectById,
    getAssetManifest: () => toDocument().assets ?? { images: [], fonts: [] },
    checkAssets,
    replaceImage,
    export: exportDocument,
    preflightExport: checkBeforeExport,
    flushRecovery: async () => requireRecovery().flush(),
    getRecoverableDocuments: async () => requireRecovery().list(),
    getRecovery: async (documentId) => requireRecovery().read(documentId ?? documentInfo.id),
    restoreRecovery,
    discardRecovery: async (documentId) => requireRecovery().remove(documentId ?? documentInfo.id),
    getInterruptedLoad: async () => requireRecovery().interruptedLoad(),
    transaction(label, work) {
      ensureUsable();
      return history.transaction(label, work);
    },
    commit(label = 'Edit') {
      ensureUsable();
      return history.commit(label);
    },
    undo: () => travelThroughHistory('undo'),
    redo: () => travelThroughHistory('redo'),
    canUndo: () => history.state().canUndo,
    canRedo: () => history.state().canRedo,
    getHistory: () => history.labels(),
    clearHistory() {
      ensureUsable();
      // Changes made just before still count as unsaved content.
      history.flush();
      history.reset();
    },
    on: (name, handler) => events.on(name, handler),
    destroy,
  };
}
