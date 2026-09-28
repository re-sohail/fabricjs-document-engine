# fabricjs-document-engine

Turn an existing [Fabric.js](https://fabricjs.com) canvas into a dependable editable document.

Fabric already draws objects, handles interaction and serializes to JSON. This package coordinates those pieces into a document workflow you can trust. You keep your own canvas, toolbar and UI.

- **Stable object ids.** Every object, including children of groups, gets an id that survives moving, styling, grouping, saving and reopening.
- **A versioned document format.** It records the schema version, canvas size, background, object order and your own metadata.
- **Safe loading.** Documents are validated first. Unknown object types are refused before the canvas is touched. A missing image fails the load instead of silently disappearing. When loads overlap, the newest one wins.
- **Custom objects.** Register your own Fabric classes and the extra properties they need to keep.
- **Safe saving.** It tracks unsaved changes and can autosave. Only one save runs at a time, so a slow older save can never overwrite newer work. Revision checks catch another tab or device saving the same document, and failed saves are retried with backoff.
- **Your storage.** Plug in any backend with two functions, or use the built-in memory and localStorage adapters. No hosted service is needed.
- **Reliable undo and redo.** One user action is one undo step. Transactions group several code changes into one labelled step, and ids survive undo and redo.
- **Fabric 6 and 7.** Every release is tested against both.

## Install

```bash
npm install fabricjs-document-engine fabric
```

## Quick start

```ts
import { Canvas, Rect } from 'fabric';
import { createDocumentEngine } from 'fabricjs-document-engine';

const canvas = new Canvas('editor', { width: 800, height: 600 });
const engine = createDocumentEngine({ canvas });

canvas.add(new Rect({ width: 100, height: 80, fill: 'tomato' }));

const document = engine.toDocument();
localStorage.setItem(document.id, JSON.stringify(document));

await engine.loadDocument(JSON.parse(localStorage.getItem(document.id)!));
```

## Saving and loading through storage

The built-in adapters are the quickest way to start:

```ts
import { createLocalStorage, createMemoryStorage } from 'fabricjs-document-engine/storage';

const engine = createDocumentEngine({
  canvas,
  storage: createLocalStorage({ prefix: 'my-app:' }),
  autosave: true,
});

await engine.load('project-42');
await engine.save();
```

Both adapters also have `listDocuments()` and `deleteDocument(id)`. To build on another key-value store, use `createKeyValueStorage({ read, write, remove, keys }, prefix)`.

### Your own backend

A storage adapter is two functions:

```ts
import { createDocumentEngine, createConflictError } from 'fabricjs-document-engine';
import type { DocumentStorage } from 'fabricjs-document-engine';

const storage: DocumentStorage = {
  async loadDocument(id) {
    const response = await fetch(`/api/documents/${id}`);
    return response.json();
  },
  async saveDocument(document, { expectedRevision, signal }) {
    const response = await fetch(`/api/documents/${document.id}`, {
      method: 'PUT',
      headers: { 'If-Match': String(expectedRevision ?? '*') },
      body: JSON.stringify(document),
      signal,
    });
    if (response.status === 409) throw Object.assign(new Error('Saved elsewhere'), { code: 'SAVE_CONFLICT' });
    if (response.status === 403) throw Object.assign(new Error('Not allowed'), { retryable: false });
    if (!response.ok) throw new Error(`Save failed with ${response.status}`);
    return { revision: document.revision };
  },
};
```

- `expectedRevision` is the revision this editor last saved or loaded. Reject the save when the stored document has a different revision. It is `null` when the user chose to overwrite.
- `document.revision` is the next revision. If your backend assigns its own number, return `{ revision }`.
- Throw an error with `code: 'SAVE_CONFLICT'`, or use `createConflictError(id, expected, actual)`, to report a conflict. Conflicts are never retried.
- Throw an error with `retryable: false` for failures that retrying cannot fix. Every other error is retried.
- Pass `signal` to `fetch`. The engine aborts it when another document is opened.

## Safe saving

```ts
const engine = createDocumentEngine({
  canvas,
  storage,
  autosave: { delay: 1000, maxWait: 10000 },
  saveRetry: { attempts: 3, baseDelay: 500, maxDelay: 8000 },
});

engine.on('save:status', ({ status, isDirty, revision, lastSavedAt, error }) => {
  statusLabel.textContent = status;
});
```

`status` is one of `saved`, `unsaved`, `saving`, `error` or `conflict`.

- **Unsaved changes.** Every recorded history step, undo, redo and metadata change marks the document as changed. `engine.isDirty()` tells you whether anything is unsaved. Edits made while a save is running stay unsaved until the next save.
- **Autosave.** It saves after `delay` ms without edits, and at the latest `maxWait` ms after the first unsaved edit, even while the user keeps editing. `autosave: true` uses the defaults shown above.
- **One save at a time.** Calling `save()` while a save is running queues exactly one follow-up save of the latest content. Responses can never arrive out of order.
- **Stale responses.** If another document is loaded while a save is running, that save's response is ignored and any queued save is cancelled with `SAVE_CANCELLED`.
- **Conflicts.** When another tab or device saved first, the save fails with `SAVE_CONFLICT` and the status becomes `conflict`. Either reload the document with `engine.load(id)`, or keep your version with `engine.save({ overwrite: true })`.
- **Retries.** Temporary failures are retried with exponential backoff and jitter. Each retry emits `save:retry` with `{ attempt, delay, error }`.

### Warn before leaving

```ts
import { bindUnsavedChangesWarning } from 'fabricjs-document-engine';

const unbind = bindUnsavedChangesWarning(engine);
```

## Custom objects

```ts
import { Rect } from 'fabric';

class Sticker extends Rect {
  static type = 'Sticker';
  declare label: string;
}

const engine = createDocumentEngine({
  canvas,
  customObjects: [{ fabricClass: Sticker, properties: ['label'] }],
});
```

If a document contains a type that has not been registered, loading fails with `UNKNOWN_OBJECT_TYPE` and lists the missing types. Your object is never turned into something else.

## Undo and redo

History is on by default. The engine records these automatically:

- adding and deleting objects, where several changes in the same tick become one step
- pointer moves, resizes and rotations (Fabric's `object:modified`)
- finished text editing

Fabric fires no events for changes your code makes directly, such as `object.set('fill', 'red')` or `canvas.bringObjectForward(object)`. Wrap them in a transaction or call `commit`:

```ts
engine.transaction('Arrange furniture', () => {
  chair.set({ left: 120, top: 80 });
  table.set('fill', 'oak');
  canvas.bringObjectToFront(table);
});

canvas.sendObjectBackwards(rug);
engine.commit('Send rug backwards');

await engine.undo();
await engine.redo();
```

- Transactions can be nested, and the outermost label is used. They can also be async: `await engine.transaction('Import', async () => { ... })`.
- Grouping and ungrouping are ordinary changes to the object list. Do the remove and the add inside one transaction and they take one undo step.
- Undo and redo rebuild the changed objects from their saved state, so they come back as new instances with the same ids. Look them up again with `engine.getObjectById(id)` rather than keeping old references.
- Keep the last 50 steps with `createDocumentEngine({ canvas, history: { limit: 50 } })`. The default is 100.

### Keyboard shortcuts

```ts
import { bindKeyboardShortcuts } from 'fabricjs-document-engine';

const unbind = bindKeyboardShortcuts(engine);
```

Ctrl/Cmd + Z undoes. Ctrl/Cmd + Shift + Z and Ctrl + Y redo. Shortcuts are ignored while the user is typing in an input, a textarea, a contenteditable element or Fabric text, so native text undo keeps working there. Pass `{ target: element }` to listen somewhere other than `window`.

### Toolbar state

```ts
engine.on('history:change', ({ canUndo, canRedo, undoLabel, redoLabel }) => {
  undoButton.disabled = !canUndo;
  undoButton.title = undoLabel ? `Undo ${undoLabel}` : 'Undo';
});
```

## Document format

```ts
interface FabricDocument {
  schemaVersion: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  revision?: number;
  fabricVersion?: string;
  canvas: { width: number; height: number; background?: unknown };
  objects: SerializedFabricObject[];
  metadata: Record<string, unknown>;
}
```

Keep project data such as titles, owners and tags in `metadata` with `engine.updateMetadata()`, rather than on Fabric objects.

## API

| Member | What it does |
| --- | --- |
| `createDocumentEngine({ canvas, storage?, customObjects?, document? })` | Connects the engine to your canvas. |
| `engine.toDocument()` | Serializes the canvas into the versioned document format. |
| `engine.loadDocument(document, { restoreCanvasSize? })` | Validates and loads a document. Resolves when the objects are on the canvas. |
| `engine.load(id)` / `engine.save({ overwrite? })` | Reads from or writes to your storage adapter. |
| `engine.isDirty()` | Tells you whether there are unsaved changes. |
| `engine.getSaveState()` | Returns `{ status, isDirty, isSaving, revision, lastSavedAt, error }`. |
| `bindUnsavedChangesWarning(engine)` | Asks the browser to confirm before closing a page with unsaved changes. Returns an unbind function. |
| `engine.newDocument({ id?, metadata? })` | Clears the canvas and starts a fresh document. |
| `engine.getDocumentInfo()` | Returns the current document's id, dates and metadata. |
| `engine.updateMetadata(changes)` | Merges changes into the document metadata. |
| `engine.getObjectById(id)` | Finds any object by id, including objects inside groups. |
| `engine.registerObject({ fabricClass, properties })` | Registers a custom class after the engine is created. |
| `engine.transaction(label, work)` | Runs `work` and records everything it changed as one undo step. Returns what `work` returns. |
| `engine.commit(label?)` | Records changes made since the last step. Returns `false` when nothing changed. |
| `engine.undo()` / `engine.redo()` | Resolves to `true` when a step was applied. Calls run one after another. |
| `engine.canUndo()` / `engine.canRedo()` | Tells you whether a step is available. |
| `engine.getHistory()` | Returns `{ undo, redo }` label lists, newest first. |
| `engine.clearHistory()` | Forgets all steps. Loading a document or starting a new one also does this. |
| `bindKeyboardShortcuts(engine, { target? })` | Adds the undo and redo shortcuts. Returns an unbind function. |
| `engine.on(event, handler)` | Listens to `load:start`, `load:success`, `load:error`, `save:start`, `save:success`, `save:error`, `save:retry`, `save:status`, `history:change` or `history:error`. Returns an unsubscribe function. |
| `engine.destroy()` | Stops listening to the canvas and cancels a running load. |
| `validateDocument(value)` | Returns a list of issues with the exact path of each problem. |

## Errors

Every failure is a `DocumentEngineError` with a `code` you can switch on:

| Code | Meaning |
| --- | --- |
| `INVALID_DOCUMENT` | The document shape is wrong. `error.issues` lists each path, such as `objects[3].objects[1].type`. |
| `UNSUPPORTED_SCHEMA` | The document was written by a newer version of this package. |
| `UNKNOWN_OBJECT_TYPE` | A type is not registered. `error.unknownTypes` lists them. |
| `LOAD_FAILED` | Fabric or your storage could not load the document, for example because an image is missing. `error.cause` holds the original error. |
| `LOAD_ABORTED` | A newer load started before this one finished. |
| `SAVE_FAILED` | Your storage adapter rejected the save after all retries. `error.retryable` tells you whether trying again could help. |
| `SAVE_CONFLICT` | Another tab or device saved this document first. |
| `SAVE_CANCELLED` | A queued save was dropped because another document was opened. |
| `DOCUMENT_NOT_FOUND` | The built-in adapters have no document with that id. |
| `HISTORY_FAILED` | Undo or redo could not rebuild an object, for example because an image is gone. The step is kept and the canvas is unchanged. |
| `STORAGE_MISSING` | `load` or `save` was called without a storage adapter. |
| `INVALID_CUSTOM_OBJECT` | A registered class has no static `type`, or it does not extend a Fabric class. |
| `ENGINE_DESTROYED` | The engine was used after `destroy()`. |

A failed load never clears or half-fills your canvas.

## Roadmap

| Version | Focus |
| --- | --- |
| 0.1 ✓ | Document foundation: ids, save and load, validation, custom objects |
| 0.2 ✓ | Undo and redo with transactions |
| 0.3 ✓ | Safe saving: dirty state, autosave, stale-response protection |
| 0.4 | Assets and fonts |
| 0.5 | Recovery after a refresh or crash |
| 0.6 | PNG, JPEG, SVG and JSON export with preflight checks |
| 0.7 | Named versions and schema migrations |
| 0.8 | React adapter and examples |
| 0.9 | Hardening and benchmarks |
| 1.0 | Stable API |

## License

MIT
