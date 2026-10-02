import { ActiveSelection, classRegistry } from 'fabric';
import type { Canvas, FabricObject } from 'fabric';
import type { SerializedFabricObject } from '../document/document-format';
import type { DocumentEngine } from '../engine/create-document-engine';
import { DocumentEngineError } from '../engine/errors';
import { createObjects } from '../fabric/fabric-adapter';
import { readObjectId } from '../fabric/object-ids';
import { collectSerializedTypes } from '../fabric/walk-objects';
import { refuseUnsafeImageUrls, secureDocument } from '../security/content-limits';
import type { ContentLimits } from '../security/content-limits';

export const CLIPBOARD_FORMAT = 'fabricjs-document-engine/objects';

/** What the clipboard holds. Plain JSON, so an app can put it on the system clipboard. */
export interface ClipboardContent {
  format: typeof CLIPBOARD_FORMAT;
  version: 1;
  objects: SerializedFabricObject[];
}

export interface ClipboardOptions {
  /** How far each paste moves from the last one, in canvas units. Default 10. */
  offset?: number;
  /** Limits for content passed to `write`, as for loading documents. */
  limits?: ContentLimits;
}

export interface PasteOptions {
  /** The engine to paste into. Defaults to the engine the clipboard was made for. */
  target?: DocumentEngine;
  /** Overrides the offset for this paste. */
  offset?: number;
  /** Selects the pasted objects on an interactive canvas. Default true. */
  select?: boolean;
}

export interface Clipboard {
  /** Copies objects, or the current selection. Returns how many objects were copied. */
  copy(objects?: readonly FabricObject[]): number;
  /** Copies and then removes objects, as one undo step. Returns how many objects were cut. */
  cut(objects?: readonly FabricObject[]): number;
  /** Adds a copy of the clipboard with fresh ids, as one undo step. Returns the new objects. */
  paste(options?: PasteOptions): Promise<FabricObject[]>;
  hasContent(): boolean;
  /** The copied objects as JSON, or `undefined` when the clipboard is empty. */
  read(): ClipboardContent | undefined;
  /** Replaces the clipboard with content from `read`, for example from another tab. */
  write(content: unknown): void;
  clear(): void;
}

interface SelectionCanvas {
  getActiveObjects?: () => FabricObject[];
  discardActiveObject?: () => unknown;
  setActiveObject?: (object: FabricObject) => unknown;
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

/** Removes every id, so the engine gives each pasted object, child and clip path a new one. */
function withoutIds(object: SerializedFabricObject): SerializedFabricObject {
  const copy: SerializedFabricObject = { ...object };
  delete copy.id;
  if (Array.isArray(copy.objects)) copy.objects = copy.objects.map(withoutIds);
  if (copy.clipPath && typeof copy.clipPath === 'object') copy.clipPath = withoutIds(copy.clipPath);
  return copy;
}

function moved(object: SerializedFabricObject, distance: number): SerializedFabricObject {
  const left = typeof object.left === 'number' ? object.left : 0;
  const top = typeof object.top === 'number' ? object.top : 0;
  return { ...object, left: left + distance, top: top + distance };
}

function refuseInvalidContent(message: string): never {
  throw new DocumentEngineError('INVALID_DOCUMENT', `The clipboard content is not valid: ${message}`);
}

function checkContent(content: unknown, limits: ContentLimits | undefined): ClipboardContent {
  if (typeof content !== 'object' || content === null) refuseInvalidContent('it is not an object');
  const candidate = content as Partial<ClipboardContent>;
  if (candidate.format !== CLIPBOARD_FORMAT) refuseInvalidContent(`its format is not "${CLIPBOARD_FORMAT}"`);
  if (candidate.version !== 1) refuseInvalidContent('its version is not 1');
  if (!Array.isArray(candidate.objects)) refuseInvalidContent('it has no objects list');
  const secured = secureDocument({ objects: candidate.objects }, limits) as { objects: unknown[] };
  const objects = secured.objects.filter(
    (object): object is SerializedFabricObject =>
      typeof object === 'object' && object !== null && typeof (object as { type?: unknown }).type === 'string',
  );
  if (objects.length !== secured.objects.length) refuseInvalidContent('every object needs a type');
  refuseUnsafeImageUrls(objects, limits?.isAllowedUrl);
  return { format: CLIPBOARD_FORMAT, version: 1, objects };
}

function topLevelInOrder(engine: DocumentEngine, objects: readonly FabricObject[]): FabricObject[] {
  const stack = engine.canvas.getObjects();
  const wanted = new Set(objects);
  return stack.filter((object) => wanted.has(object));
}

function selectionOf(engine: DocumentEngine): FabricObject[] {
  const canvas = engine.canvas as unknown as SelectionCanvas;
  return canvas.getActiveObjects?.() ?? [];
}

function refuseUnknownTypes(objects: readonly SerializedFabricObject[]): void {
  const unknownTypes = [...collectSerializedTypes(objects)].filter((type) => !classRegistry.has(type));
  if (unknownTypes.length === 0) return;
  throw new DocumentEngineError(
    'UNKNOWN_OBJECT_TYPE',
    `The clipboard holds object types that are not registered: ${unknownTypes.join(', ')}`,
    { unknownTypes },
  );
}

function select(engine: DocumentEngine, objects: FabricObject[]): void {
  const canvas = engine.canvas as unknown as SelectionCanvas;
  if (typeof canvas.setActiveObject !== 'function' || objects.length === 0) return;
  canvas.discardActiveObject?.();
  canvas.setActiveObject(objects.length === 1 ? objects[0]! : new ActiveSelection(objects, { canvas: engine.canvas as Canvas }));
}

/**
 * A clipboard for one engine. Copies keep custom properties and the exact
 * position of objects in groups and selections; pastes get fresh ids for
 * every object and child and count as one undo step.
 */
export function createClipboard(engine: DocumentEngine, options: ClipboardOptions = {}): Clipboard {
  const defaultOffset = options.offset ?? 10;
  let content: ClipboardContent | undefined;
  // Pastes since the last copy; a cut pastes the first copy in place.
  let pastes = 0;

  function copyObjects(objects: readonly FabricObject[]): number {
    const chosen = topLevelInOrder(engine, objects);
    if (chosen.length === 0) return 0;
    // The document serializer knows the custom properties and writes
    // objects in a selection at their real position on the canvas.
    const document = engine.toDocument();
    const ids = chosen.map((object) => readObjectId(object));
    const serialized = ids
      .map((id) => document.objects.find((object) => object.id === id))
      .filter((object): object is SerializedFabricObject => object !== undefined);
    content = { format: CLIPBOARD_FORMAT, version: 1, objects: clone(serialized) };
    return serialized.length;
  }

  return {
    copy(objects) {
      const count = copyObjects(objects ?? selectionOf(engine));
      if (count > 0) pastes = 0;
      return count;
    },
    cut(objects) {
      const chosen = topLevelInOrder(engine, objects ?? selectionOf(engine));
      const count = copyObjects(chosen);
      if (count === 0) return 0;
      pastes = -1;
      engine.transaction(count === 1 ? 'Cut' : `Cut ${count} objects`, () => {
        (engine.canvas as unknown as SelectionCanvas).discardActiveObject?.();
        engine.canvas.remove(...chosen);
      });
      engine.canvas.requestRenderAll();
      return count;
    },
    async paste(pasteOptions = {}) {
      if (!content) return [];
      const target = pasteOptions.target ?? engine;
      const offset = pasteOptions.offset ?? defaultOffset;
      pastes += 1;
      const distance = offset * pastes;
      const serialized = content.objects.map((object) => moved(withoutIds(object), distance));
      refuseUnknownTypes(serialized);
      const startedIn = target.getDocumentInfo().session;
      const created = await createObjects(clone(serialized));
      // Another document may have been opened while the copies were made.
      if (target.getDocumentInfo().session !== startedIn) {
        created.forEach((object) => object.dispose?.());
        throw new DocumentEngineError('DOCUMENT_CHANGED', 'The paste was dropped because another document was opened while it ran');
      }
      target.transaction(created.length === 1 ? 'Paste' : `Paste ${created.length} objects`, () => {
        target.canvas.add(...created);
      });
      if (pasteOptions.select ?? true) select(target, created);
      target.canvas.requestRenderAll();
      return created;
    },
    hasContent: () => content !== undefined,
    read: () => (content ? clone(content) : undefined),
    write(next) {
      content = checkContent(next, options.limits);
      pastes = 0;
    },
    clear() {
      content = undefined;
      pastes = 0;
    },
  };
}
