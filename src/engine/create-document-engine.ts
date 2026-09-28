import type { FabricObject, StaticCanvas } from 'fabric';
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
import { DocumentEngineError, isDocumentEngineError } from './errors';
import { createEventEmitter } from './event-emitter';
import type { Unsubscribe } from './event-emitter';

export interface DocumentStorage {
  loadDocument(id: string): Promise<unknown>;
  saveDocument(document: FabricDocument): Promise<void>;
}

export interface DocumentEngineOptions {
  canvas: StaticCanvas;
  storage?: DocumentStorage;
  customObjects?: CustomObjectDefinition[];
  document?: NewDocumentOptions;
  history?: HistoryOptions;
}

export interface LoadOptions {
  restoreCanvasSize?: boolean;
}

export interface DocumentEngineEvents {
  'load:start': { documentId: string | undefined };
  'load:success': { document: FabricDocument };
  'load:error': { error: DocumentEngineError };
  'save:start': { document: FabricDocument };
  'save:success': { document: FabricDocument };
  'save:error': { error: DocumentEngineError };
  'history:change': HistoryState;
  'history:error': { error: DocumentEngineError };
}

export interface DocumentEngine {
  readonly canvas: StaticCanvas;
  getDocumentInfo(): DocumentInfo;
  updateMetadata(changes: Record<string, unknown>): void;
  newDocument(options?: NewDocumentOptions): void;
  toDocument(): FabricDocument;
  loadDocument(document: unknown, options?: LoadOptions): Promise<FabricDocument>;
  load(documentId: string, options?: LoadOptions): Promise<FabricDocument>;
  save(): Promise<FabricDocument>;
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
  on<Name extends keyof DocumentEngineEvents>(
    name: Name,
    handler: (payload: DocumentEngineEvents[Name]) => void,
  ): Unsubscribe;
  destroy(): void;
}

interface ObjectEvent {
  target: FabricObject;
}

function describeDocumentId(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : undefined;
}

export function createDocumentEngine(options: DocumentEngineOptions): DocumentEngine {
  const { canvas, storage } = options;
  const registry = createObjectRegistry(options.customObjects);
  const events = createEventEmitter<DocumentEngineEvents>();
  const objectsById = new Map<string, FabricObject>();
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
    serializeObjects: () => {
      rebuildIndex();
      return serializeCanvas(canvas, registry.propertiesToInclude()).objects;
    },
    onChange: (state) => events.emit('history:change', state),
  });

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
      canvas: { width: canvas.getWidth(), height: canvas.getHeight() },
      objects: serialized.objects,
      metadata: { ...documentInfo.metadata },
    };
    if (serialized.version !== undefined) document.fabricVersion = serialized.version;
    if (serialized.background !== undefined) document.canvas.background = serialized.background;
    return document;
  }

  function toLoadError(error: unknown, signal: AbortSignal): DocumentEngineError {
    if (isDocumentEngineError(error)) return error;
    if (signal.aborted) {
      return new DocumentEngineError('LOAD_ABORTED', 'Loading stopped because a newer load started', {
        cause: error,
      });
    }
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

  async function loadDocument(input: unknown, loadOptions: LoadOptions = {}): Promise<FabricDocument> {
    ensureUsable();
    activeLoad?.abort();
    const controller = new AbortController();
    activeLoad = controller;
    events.emit('load:start', { documentId: describeDocumentId(input) });

    try {
      const document = checkDocument(input);
      await history.withoutRecording(() =>
        loadIntoCanvas(
          canvas,
          { version: document.fabricVersion, background: document.canvas.background, objects: document.objects },
          controller.signal,
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
      canvas.requestRenderAll();
      events.emit('load:success', { document });
      return document;
    } catch (error) {
      const engineError = toLoadError(error, controller.signal);
      events.emit('load:error', { error: engineError });
      throw engineError;
    } finally {
      if (activeLoad === controller) activeLoad = null;
    }
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
    let stored: unknown;
    try {
      stored = await source.loadDocument(documentId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const engineError = new DocumentEngineError('LOAD_FAILED', `Storage could not load "${documentId}": ${reason}`, {
        cause: error,
      });
      events.emit('load:error', { error: engineError });
      throw engineError;
    }
    return loadDocument(stored, loadOptions);
  }

  async function save(): Promise<FabricDocument> {
    ensureUsable();
    const target = requireStorage();
    const document = toDocument();
    events.emit('save:start', { document });
    try {
      await target.saveDocument(document);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const engineError = new DocumentEngineError('SAVE_FAILED', `Storage could not save the document: ${reason}`, {
        cause: error,
      });
      events.emit('save:error', { error: engineError });
      throw engineError;
    }
    events.emit('save:success', { document });
    return document;
  }

  function newDocument(newOptions?: NewDocumentOptions): void {
    ensureUsable();
    activeLoad?.abort();
    history.withoutRecording(() => canvas.clear());
    objectsById.clear();
    documentInfo = createDocumentInfo(newOptions);
    history.reset();
  }

  function getObjectById(id: string): FabricObject | undefined {
    ensureUsable();
    const indexed = objectsById.get(id);
    if (indexed !== undefined) return indexed;
    rebuildIndex();
    return objectsById.get(id);
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
    destroyed = true;
    activeLoad?.abort();
    history.destroy();
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
    },
    newDocument,
    toDocument,
    loadDocument,
    load,
    save,
    registerObject(definition) {
      ensureUsable();
      registry.register(definition);
    },
    getObjectById,
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
      history.reset();
    },
    on: (name, handler) => events.on(name, handler),
    destroy,
  };
}
