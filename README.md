# fabricjs-document-engine

Turn an existing [Fabric.js](https://fabricjs.com) canvas into a dependable editable document.

Fabric already draws objects, handles interaction and serializes to JSON. This package coordinates those pieces into a document workflow you can trust. You keep your own canvas, toolbar and UI.

- **Stable object ids.** Every object, including children of groups, gets an id that survives moving, styling, grouping, saving and reopening.
- **A versioned document format.** It records the schema version, canvas size, background, object order and your own metadata.
- **Safe loading.** Documents are validated first. Unknown object types are refused before the canvas is touched. A missing image fails the load instead of silently disappearing. When loads overlap, the newest one wins.
- **Custom objects.** Register your own Fabric classes and the extra properties they need to keep.
- **Safe saving.** It tracks unsaved changes and can autosave. Only one save runs at a time, so a slow older save can never overwrite newer work. Revision checks catch another tab or device saving the same document, and failed saves are retried with backoff.
- **Your storage.** Plug in any backend with two functions, or use the built-in memory and localStorage adapters. No hosted service is needed.
- **Assets and fonts.** Documents record the images and fonts they need. When a document is opened, every image and font is checked first. You get the exact list of what is missing, can offer replacements, and tab-only images are uploaded when you save.
- **Recovery.** Unsaved work is copied to IndexedDB while the user edits, and again at the moment the tab is closed or refreshed. After a crash or refresh you can offer to restore it, including images that only existed in the old tab.
- **Dependable export.** PNG, JPEG, WebP, SVG and editable JSON. You choose the area, scale and background. A preflight check means an export either succeeds or tells you exactly which image or font prevents it.
- **Versions and migration.** Keep named versions, restore any of them as a new revision, and open plain Fabric JSON or documents saved by older versions of this package.
- **Reliable undo and redo.** One user action is one undo step. Transactions group several code changes into one labelled step, and ids survive undo and redo.
- **React ready, framework free.** Hooks for React, and a small state store for any other framework. Your toolbar and UI stay yours.
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

## React

```tsx
import { useDocumentEngine, useDocumentState, DocumentEngineProvider, useEngine } from 'fabricjs-document-engine/react';

function Editor({ canvas }: { canvas: Canvas | null }) {
  const engine = useDocumentEngine(canvas, { storage, autosave: true });
  return (
    <DocumentEngineProvider engine={engine}>
      <YourToolbar />
    </DocumentEngineProvider>
  );
}

function YourToolbar() {
  const engine = useEngine();
  const state = useDocumentState(engine);
  if (!engine || !state) return null;
  return (
    <>
      <button disabled={!state.canUndo} onClick={() => engine.undo()}>Undo {state.undoLabel}</button>
      <button disabled={!state.isDirty} onClick={() => engine.save()}>Save</button>
      <span>{state.saveStatus}</span>
    </>
  );
}
```

- `useDocumentEngine(canvas, options)` creates the engine once your Fabric canvas exists and destroys it on unmount. It returns `null` until then. Options are read when the engine is created.
- `useDocumentState(engine)` returns `{ documentId, isLoading, loadError, saveStatus, isDirty, isSaving, revision, lastSavedAt, saveError, canUndo, canRedo, undoLabel, redoLabel, assetWarnings }` and re-renders when any of them change.
- `useDocumentEvent(engine, 'save:error', handler)` subscribes to any event with the latest handler.
- `DocumentEngineProvider` and `useEngine()` pass the engine to deeply nested toolbars.
- The React entry is marked `'use client'` for Next.js. React is an optional peer dependency, so the core never imports it.

For other frameworks, `createDocumentStateStore(engine)` gives the same state as `{ getSnapshot, subscribe }`, which fits Svelte stores, Vue's `shallowRef` and similar tools.

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

More adapters, including a REST API with revision checks and image uploads, are in [docs/storage-examples.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/storage-examples.md).

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

## Assets and fonts

Every saved document carries an `assets` manifest that lists each image URL and font variant, together with the ids of the objects that use them. Images embedded as `data:` URLs are left out of the manifest because they need no fetching.

```ts
const engine = createDocumentEngine({
  canvas,
  storage,
  assets: {
    resolveUrl: (url) => url.replace('asset://', 'https://cdn.example.com/'),
    replaceMissingImage: (image) => '/placeholder.png',
    upload: async ({ blob }) => uploadToYourBucket(blob),
    loadFont: async ({ family, weight, style }) => {
      const face = new FontFace(family, `url(/fonts/${family}-${weight}.woff2)`, { weight, style });
      document.fonts.add(await face.load());
    },
    requireFonts: false,
  },
});

engine.on('assets:warning', ({ warnings }) => warnings.forEach((warning) => console.warn(warning.message)));
```

### When a document is opened

1. `resolveUrl` can rewrite each stored URL, for example to sign it or to map asset ids to a CDN.
2. `loadFont` runs for each font variant. Then the engine checks that the font really renders, rather than silently falling back to a default.
3. Every image loads in parallel. If any are missing, `replaceMissingImage` can supply a replacement URL for each one. Return `null` to leave it missing.
4. If images are still missing, loading fails with `MISSING_ASSETS`, and `error.missingAssets` lists each `{ url, objectIds }`. The canvas is not touched.

Fonts that are not available produce a `FONT_UNAVAILABLE` warning and the text uses a fallback font. Set `requireFonts: true` to fail with `MISSING_FONTS` instead. Warnings are also delivered with `load:success` as `{ document, warnings }`.

### When a document is saved

Images that exist only in this tab (`blob:` URLs) and embedded `data:` images are passed to `upload` once, and the document stores the returned URL. Without an `upload` handler, `blob:` images produce an `ASSET_NOT_PORTABLE` warning, because another device cannot open them.

### Cross-origin images

An image from another site without `crossOrigin: 'anonymous'` taints the canvas, and exporting it will fail. The engine warns with `IMAGE_CROSS_ORIGIN` so you can fix it before the user tries to export.

### Checking and replacing at any time

```ts
const report = await engine.checkAssets();
report.missingImages;
report.unavailableFonts;
report.warnings;

await engine.replaceImage('/old-logo.png', '/new-logo.png');
```

`replaceImage` swaps every image that uses a URL. Each image keeps its size on the page, and the change is one undo step. `engine.getAssetManifest()` returns the manifest for the current canvas.

## Export

```ts
import { downloadExport } from 'fabricjs-document-engine';

const result = await engine.export({ format: 'png', scale: 2 });
downloadExport(result, 'poster.png');
```

`result` is `{ format, mimeType, blob, width, height, warnings }`. JSON exports also include `document`.

| Option | Values | Default |
| --- | --- | --- |
| `format` | `'png'`, `'jpeg'`, `'webp'`, `'svg'` or `'json'` | required |
| `scale` | Output size multiplier, such as `2` for retina | `1` |
| `quality` | 0 to 1, for JPEG and WebP | `0.92` |
| `area` | `'canvas'`, `'content'` (every object), `'selection'`, or `{ left, top, width, height }` | `'canvas'` |
| `padding` | Extra space around `content` or `selection` | `0` |
| `background` | `'keep'`, `'transparent'` or any CSS color | `'keep'` |
| `signal` | An `AbortSignal` to cancel | |

- The current zoom and pan do not matter. Exports always use document coordinates, and the view is restored afterwards.
- A JPEG has no transparency, so an empty or transparent background becomes white instead of black.
- The export never changes the canvas, the history or the unsaved state.
- A JSON export is the same portable document a save produces, including uploaded images when `assets.upload` is set.

### Preflight and errors

Before rendering, the engine checks the objects on the canvas:

- **`MISSING_IMAGE`**: an image failed to load.
- **`CROSS_ORIGIN_IMAGE`**: an image from another site without CORS would make the browser block a PNG, JPEG or WebP export. SVG and JSON are not affected.
- **`MISSING_FONT`**: a font is not available and `assets.requireFonts` is on. Otherwise you get a `FONT_UNAVAILABLE` warning.

If any problem is found, `export` rejects with `EXPORT_BLOCKED`, and `error.problems` lists each `{ code, message, url?, family?, objectIds }`. You can run the same check first to show it in your UI:

```ts
const check = await engine.preflightExport({ format: 'png' });
if (!check.ok) showProblems(check.problems);
```

## Versions

```ts
const version = await engine.createVersion('Sent to client');
const versions = await engine.listVersions();
await engine.restoreVersion(version.id);
await engine.deleteVersion(version.id);
```

- Versions are full copies of the document, kept in your storage adapter. The built-in adapters support them. A custom adapter adds four methods: `saveVersion(version)`, `listVersions(documentId)`, `loadVersion(documentId, versionId)` and `deleteVersion(documentId, versionId)`.
- `listVersions` returns summaries, newest first: `{ id, documentId, name, kind, createdAt, revision }`. `kind` is `named` or `auto`.
- **Restoring never loses work.** The engine first keeps an automatic version named `Before restoring "..."`. It then loads the old content as a new, unsaved revision of the same document. The next save stores it as the newest revision, and history stays linear. To undo a restore, restore the automatic version.
- **Automatic versions.** Use `versions: { autoEvery: 10, keepAuto: 20 }` to keep a version after every 10 successful saves. Named versions are never pruned. Only the newest `keepAuto` automatic versions are kept, 20 by default.
- Undo and redo cover recent edits in this session. Versions preserve chosen states for later.

## Migration and importing Fabric JSON

Plain Fabric JSON, such as the output of `canvas.toJSON()` from Fabric 5, 6 or 7, opens directly:

```ts
await engine.importFabricJson(savedJsonText, { id: 'plan-42', metadata: { source: 'old editor' } });
```

`loadDocument` and `load(id)` also recognise plain Fabric JSON, so projects stored by an existing Fabric app open without a separate import step. A document loaded with `load(id)` keeps that id, and its next save stores it in the current format.

Every document records its `schemaVersion`. When the package format changes, older documents are upgraded step by step when they are opened. `load:success` reports `migratedFrom` when that happened. A failed step rejects with `MIGRATION_FAILED`, and `error.migrationFrom` names the version it started from. A document from a newer version of the package is refused with `UNSUPPORTED_SCHEMA` rather than being misread. `migrateDocument(value, context)` and `detectSchemaVersion(value)` are exported for tooling such as server-side batch upgrades.

## Recovery

```ts
import { createIndexedDbRecovery } from 'fabricjs-document-engine/recovery';

const engine = createDocumentEngine({
  canvas,
  storage,
  recovery: { store: createIndexedDbRecovery(), interval: 2000 },
});

const [latest] = await engine.getRecoverableDocuments();
if (latest && confirm(`Restore unsaved work from ${new Date(latest.savedAt).toLocaleString()}?`)) {
  await engine.restoreRecovery(latest.documentId);
} else if (latest) {
  await engine.discardRecovery(latest.documentId);
}
```

- **Checkpoints.** While there are unsaved changes, a copy is written at most once every `interval` ms (default 2000). Nothing is written while the document is saved.
- **Closing or refreshing.** Browsers do not let IndexedDB finish writing while a page unloads. So when the tab is hidden or closed, the engine also writes an immediate copy to localStorage. The newest copy wins when you read it back.
- **Tab-only images.** Images with `blob:` URLs vanish on refresh. Checkpoints keep the image data, and restoring creates fresh URLs for it.
- **After a save.** When a save covers every change, the copy is removed. If the tab closes during a save, the copy stays, so work is never lost between the edit and the server.
- **Restoring.** The restored document is marked as unsaved and keeps the revision it was based on. If the server moved on meanwhile, the next save reports `SAVE_CONFLICT` instead of overwriting newer work.
- **Interrupted loads.** A marker is kept while a document loads. If the tab crashes during loading, `engine.getInterruptedLoad()` returns `{ documentId, startedAt }` on the next start, so you can skip or discard that document instead of crashing again.
- `engine.flushRecovery()` writes a copy right now. `engine.getRecovery(id?)` reads one.
- `createMemoryRecovery()` keeps copies in memory, which is useful for tests. To use your own storage, implement `{ get, set, delete, keys }`, plus an optional synchronous `setNow` for the moment the page closes.

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
  assets?: {
    images: Array<{ url: string; objectIds: string[] }>;
    fonts: Array<{ family: string; weight: string; style: string; objectIds: string[] }>;
  };
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
| `engine.importFabricJson(json, { id?, metadata? })` | Opens plain Fabric JSON, as text or an object. |
| `engine.createVersion(name?)` / `engine.listVersions()` | Keeps a named version, or lists versions newest first. |
| `engine.restoreVersion(id)` / `engine.deleteVersion(id)` | Restores a version as a new unsaved revision, or deletes it. |
| `engine.isDirty()` | Tells you whether there are unsaved changes. |
| `engine.getSaveState()` | Returns `{ status, isDirty, isSaving, revision, lastSavedAt, error }`. |
| `bindUnsavedChangesWarning(engine)` | Asks the browser to confirm before closing a page with unsaved changes. Returns an unbind function. |
| `engine.newDocument({ id?, metadata? })` | Clears the canvas and starts a fresh document. |
| `engine.getDocumentInfo()` | Returns the current document's id, dates and metadata. |
| `engine.updateMetadata(changes)` | Merges changes into the document metadata. |
| `engine.getObjectById(id)` | Finds any object by id, including objects inside groups. |
| `engine.registerObject({ fabricClass, properties })` | Registers a custom class after the engine is created. |
| `engine.getAssetManifest()` | Lists the images and fonts used on the canvas. |
| `engine.checkAssets()` | Resolves to `{ manifest, missingImages, unavailableFonts, warnings }` for the current canvas. |
| `engine.replaceImage(oldUrl, newUrl)` | Replaces every image with that URL as one undo step. Resolves to the number of images replaced. |
| `engine.export(options)` | Exports PNG, JPEG, WebP, SVG or JSON. See [Export](#export). |
| `engine.preflightExport(options)` | Resolves to `{ ok, problems, warnings }` without exporting. |
| `downloadExport(result, fileName?)` | Starts a browser download of an export result. |
| `engine.getRecoverableDocuments()` | Lists recovery copies, newest first. |
| `engine.restoreRecovery(id?)` / `engine.discardRecovery(id?)` | Loads or deletes a recovery copy. The default is the current document. |
| `engine.getRecovery(id?)` / `engine.flushRecovery()` | Reads a copy, or writes one now. |
| `engine.getInterruptedLoad()` | Returns the load that was running when the tab last crashed, if any. |
| `engine.transaction(label, work)` | Runs `work` and records everything it changed as one undo step. Returns what `work` returns. |
| `engine.commit(label?)` | Records changes made since the last step. Returns `false` when nothing changed. |
| `engine.undo()` / `engine.redo()` | Resolves to `true` when a step was applied. Calls run one after another. |
| `engine.canUndo()` / `engine.canRedo()` | Tells you whether a step is available. |
| `engine.getHistory()` | Returns `{ undo, redo }` label lists, newest first. |
| `engine.clearHistory()` | Forgets all steps. Loading a document or starting a new one also does this. |
| `bindKeyboardShortcuts(engine, { target? })` | Adds the undo and redo shortcuts. Returns an unbind function. |
| `engine.on(event, handler)` | Listens to `load:start`, `document:change`, `load:success`, `load:error`, `save:start`, `save:success`, `save:error`, `save:retry`, `save:status`, `assets:warning`, `recovery:checkpoint`, `recovery:restored`, `recovery:error`, `export:success`, `export:error`, `version:created`, `version:restored`, `version:error`, `history:change` or `history:error`. Returns an unsubscribe function. |
| `engine.destroy()` | Stops listening to the canvas and cancels a running load. |
| `createDocumentStateStore(engine)` | Framework-free `{ getSnapshot, subscribe, destroy }` state for toolbars. |
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
| `MISSING_ASSETS` | Images could not be loaded and had no replacement. `error.missingAssets` lists each `{ url, objectIds }`. |
| `MISSING_FONTS` | Fonts are not available and `requireFonts` is on. `error.missingFonts` lists them. |
| `ASSET_UPLOAD_FAILED` | Your `upload` handler failed while saving. |
| `SAVE_FAILED` | Your storage adapter rejected the save after all retries. `error.retryable` tells you whether trying again could help. |
| `SAVE_CONFLICT` | Another tab or device saved this document first. |
| `SAVE_CANCELLED` | A queued save was dropped because another document was opened. |
| `DOCUMENT_NOT_FOUND` | The built-in adapters have no document with that id. |
| `HISTORY_FAILED` | Undo or redo could not rebuild an object, for example because an image is gone. The step is kept and the canvas is unchanged. |
| `MIGRATION_FAILED` | An older document could not be upgraded. `error.migrationFrom` is the schema version it started from. |
| `VERSIONS_UNSUPPORTED` | The storage adapter has no version methods. |
| `VERSION_NOT_FOUND` | There is no version with that id. |
| `VERSION_FAILED` | An automatic version could not be kept. It is delivered as a `version:error` event. |
| `EXPORT_BLOCKED` | The preflight found problems. `error.problems` lists each one with the objects involved. |
| `INVALID_EXPORT_OPTIONS` | The format, scale, quality, area or padding is not valid, or the area is empty. |
| `EXPORT_ABORTED` | The export was cancelled with its `signal`. |
| `EXPORT_FAILED` | Fabric could not render the export. `error.cause` holds the original error. |
| `RECOVERY_MISSING` | A recovery method was called without `recovery: { store }`. |
| `RECOVERY_NOT_FOUND` | There is no recovery copy for that document. |
| `RECOVERY_FAILED` | Writing a recovery copy failed, for example because storage is full. It is delivered as a `recovery:error` event and never interrupts editing. |
| `STORAGE_MISSING` | `load` or `save` was called without a storage adapter. |
| `INVALID_CUSTOM_OBJECT` | A registered class has no static `type`, or it does not extend a Fabric class. |
| `ENGINE_DESTROYED` | The engine was used after `destroy()`. |

A failed load never clears or half-fills your canvas.

## Roadmap

| Stage | Focus | Released in |
| --- | --- | --- |
| 1 | Document foundation: ids, save and load, validation, custom objects | 0.0.0 |
| 2 | Undo and redo with transactions | 0.1.0 |
| 3 | Safe saving: dirty state, autosave, stale-response protection | 0.2.0 |
| 4 | Assets and fonts | 0.3.0 |
| 5 | Recovery after a refresh or crash | 0.4.0 |
| 6 | PNG, JPEG, SVG and JSON export with preflight checks | 0.5.0 |
| 7 | Named versions and schema migrations | 0.6.0 |
| 8 | React adapter and examples | 0.7.0 |
| 9 | Hardening and benchmarks | |
| 10 | Stable API | 1.0.0 |

## Troubleshooting

Common problems and fixes are in [docs/troubleshooting.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/troubleshooting.md).

## License

MIT
