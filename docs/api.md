# API reference

This is the complete public API of `fabricjs-document-engine` 1.x. Everything listed here follows the [compatibility policy](./compatibility-policy.md). Anything not listed here is internal and may change.

The package has four entry points:

| Import | Contents |
| --- | --- |
| `fabricjs-document-engine` | The engine, errors, document helpers, safety checks and export helpers |
| `fabricjs-document-engine/storage` | Storage adapters and the adapter checker |
| `fabricjs-document-engine/recovery` | Recovery stores |
| `fabricjs-document-engine/react` | React hooks, marked `'use client'` |
| `fabricjs-document-engine/pdf` | PDF export. Needs the optional peers `jspdf` and `svg2pdf.js` |
| `fabricjs-document-engine/schema/document-v1.json` | The JSON Schema of the document format |

---

## `createDocumentEngine(options)`

```ts
function createDocumentEngine(options: DocumentEngineOptions): DocumentEngine;
```

Connects the engine to an existing Fabric canvas. The canvas stays yours. The engine only listens to it and changes it when you load, undo or restore.

### `DocumentEngineOptions`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `canvas` | `StaticCanvas` or `Canvas` | required | Your Fabric canvas. |
| `storage` | `DocumentStorage` | none | Needed for `load`, `save`, autosave and versions. |
| `customObjects` | `CustomObjectDefinition[]` | `[]` | Custom Fabric classes and their extra properties. |
| `document` | `{ id?, metadata? }` | new id | Identity of the first, empty document. |
| `history` | `{ limit?, maxBytes? }` | `{ limit: 100, maxBytes: 64 MB }` | Undo history size. |
| `autosave` | `boolean` or `{ delay?, maxWait? }` | off | `true` means `{ delay: 1000, maxWait: 10000 }`. Needs `storage`. |
| `saveRetry` | `{ attempts?, baseDelay?, maxDelay? }` | `{ 3, 500, 8000 }` | Retries for failed saves. |
| `assets` | `AssetOptions` | `{}` | How images and fonts are resolved, checked and uploaded. |
| `recovery` | `{ store, interval? }` | off | Local recovery copies. `interval` defaults to 2000 ms. |
| `versions` | `{ autoEvery?, keepAuto? }` | `{ 0, 20 }` | Automatic versions every N saves, and how many to keep. |
| `limits` | `ContentLimits` | see below | Safety and memory limits for documents, images, pages and exports. |

### `ContentLimits`

| Field | Default | Purpose |
| --- | --- | --- |
| `maxObjects` | `50000` | Objects in a document or SVG, counting group children and clip paths. |
| `maxDepth` | `100` | Nesting depth of a document or SVG. |
| `isAllowedUrl` | `isSafeImageUrl` | Which image addresses may be loaded. |
| `maxCanvasSide` | `16384` | Longest side of the page, in pixels. Also applies to raster exports. |
| `maxCanvasPixels` | `67108864` | Largest page or raster export area (8,192 × 8,192, what iOS 18 Safari can draw). |
| `maxImagePixels` | `67108864` | Largest decoded image. Larger images fail with reason `TOO_LARGE`. |
| `maxDocumentLength` | `100000000` | Longest document, in characters of JSON. |

Each check is plain arithmetic made before any canvas is created. A document over a limit is refused with `UNSAFE_DOCUMENT`; a raster export over it with `EXPORT_BLOCKED` and a `TOO_LARGE` problem. PDF pages and pictures in a PDF are drawn at a lower resolution instead of failing.

### `CustomObjectDefinition`

```ts
{ fabricClass: typeof FabricObject subclass with a static type; properties?: string[] }
```

### `AssetOptions`

| Option | Type | Purpose |
| --- | --- | --- |
| `resolveUrl` | `(url) => string or Promise<string>` | Rewrites stored image URLs before loading. |
| `replaceMissingImage` | `(image: ImageAsset) => string, null or undefined, or a Promise of one` | Supplies a replacement for an image that did not load. `image.failure` says why it failed. |
| `upload` | `(request: UploadRequest) => Promise<string>` | Stores `blob:` and `data:` images while saving, and returns their permanent URL. |
| `loadFont` | `(font: FontAsset) => void or Promise<void>` | Loads a font before text is created. |
| `checkImages` | `boolean` | Set to `false` to skip loading images during the preflight. The default is `true`. |
| `requireFonts` | `boolean` | Fail loading with `MISSING_FONTS`, and export with `MISSING_FONT`, instead of warning. |
| `imageTimeout` | `number` | Milliseconds to wait for each image before it counts as missing with reason `TIMEOUT`. The default is `30000`. `0` waits forever. |
| `maxConcurrentImages` | `number` | How many images load at the same time while checking. The default is `6`. |

### Why an image failed

Every image in `missingImages` (from `checkAssets()`) and in `error.missingAssets` (from `MISSING_ASSETS`) has a `failure: ImageLoadFailure`:

```ts
{ url: string; reason: ImageFailureReason; message: string; status?: number; timeoutMs?: number }
```

| `reason` | Meaning |
| --- | --- |
| `NOT_FOUND` | The server answered 404 or 410. `status` is set. |
| `HTTP_ERROR` | The server answered with another error status. `status` is set. |
| `CORS` | Another site answered, but sent no CORS headers for an image that asks for `crossOrigin`. |
| `NETWORK` | The address could not be reached, or another site answered without CORS and the browser hid the reason. |
| `TIMEOUT` | The image took longer than `imageTimeout`. `timeoutMs` is set. |
| `DECODE` | The bytes arrived but are not a picture the browser can decode. |
| `ABORTED` | The load or check was cancelled. |
| `TOO_LARGE` | The decoded image has more pixels than `limits.maxImagePixels`. |

---

## `DocumentEngine`

### Documents

| Member | Returns | Description |
| --- | --- | --- |
| `canvas` | `StaticCanvas` | The canvas you passed in. |
| `getDocumentInfo()` | `DocumentInfo` | `{ id, createdAt, updatedAt, metadata, session }` of the current document. `session` goes up each time the canvas shows another document. |
| `setPage(changes, label?)` | `void` | Changes the page as one undo step that marks the document unsaved. `PageChanges` is `{ width?, height?, background?, backgroundImage?, overlay?, overlayImage?, clipPath? }`; images and the mask are Fabric objects, and `null` removes one. |
| `updateMetadata(changes)` | `void` | Merges `changes` into the metadata and marks the document unsaved. |
| `newDocument(options?)` | `void` | Clears the canvas and starts a new document. Options: `{ id?, metadata?, discardUnsavedChanges? }`. |
| `toDocument()` | `FabricDocument` | Serializes the canvas. Every object gets an id. |
| `loadDocument(document, options?)` | `Promise<FabricDocument>` | Validates, migrates, checks assets, then loads. Options are `LoadOptions`, below. |
| `load(id, options?)` | `Promise<FabricDocument>` | Loads from `storage`. The document keeps `id` even if it was stored as plain Fabric JSON. |
| `importFabricJson(json, options?)` | `Promise<FabricDocument>` | Opens plain Fabric JSON, as text or an object. Options: `{ id?, metadata?, restoreCanvasSize?, discardUnsavedChanges? }`. |
| `importSvg(svg, options?)` | `Promise<SvgImportResult>` | Adds an SVG file to the canvas as one undo step, where its viewport puts it. See [SVG import](#svg-import). |
| `registerObject(definition)` | `void` | Registers a custom class after creation. |
| `getObjectById(id)` | `FabricObject` or `undefined` | Finds any object, including objects inside groups. |
| `destroy()` | `void` | Stops listening, cancels loads, saves and timers, and writes a recovery copy if there is unsaved work. Every later call throws `ENGINE_DESTROYED`. |

`LoadOptions` is `{ restoreCanvasSize?, discardUnsavedChanges?, signal?, onProgress? }` and works for `load`, `loadDocument`, `importFabricJson` and `restoreRecovery`:

- `signal`: an `AbortSignal`. Cancelling it stops the load with `LOAD_ABORTED`, and the canvas keeps what it showed before.
- `onProgress`: called with a `LoadProgress`, `{ documentId, stage, done, total }`. The `load:progress` event carries the same values. `stage` is a `LoadStage`: `prepare` (validation and migration), `images` (images checked), `objects` (top-level objects created) and `done`.

Objects are created 100 at a time, and the page gets a turn between chunks, so a large document does not freeze it. Every object is created before the canvas is cleared, so a failed or cancelled load leaves the old content in place.

When a `storage` adapter is configured and there are unsaved changes, `load`, `loadDocument`, `importFabricJson` and `newDocument` refuse with `UNSAVED_CHANGES`. Save first, or pass `discardUnsavedChanges: true`.

### Saving

| Member | Returns | Description |
| --- | --- | --- |
| `save(options?)` | `Promise<FabricDocument>` | Saves through `storage`. Only one save runs at a time, and calls made during a save merge into one follow-up. Pass `{ overwrite: true }` to skip the revision check after a conflict. |
| `isDirty()` | `boolean` | Whether there are unsaved changes. |
| `getSaveState()` | `SaveState` | `{ status, isDirty, isSaving, revision, lastSavedAt, error }`. `status` is one of `saved`, `unsaved`, `saving`, `error` or `conflict`. |

### History

| Member | Returns | Description |
| --- | --- | --- |
| `transaction(label, work, options?)` | the result of `work` | Records everything `work` changes, page included, as one undo step. Nested and async work is supported. `TransactionOptions` is `{ rollback? }`: with `rollback: true`, a `work` that throws or rejects leaves the canvas as it was before, with no undo step and no unsaved changes. |
| `commit(label?)` | `boolean` | Records changes made by code since the last step. Returns `false` if nothing changed. |
| `undo()` / `redo()` | `Promise<boolean>` | Applies one step. Calls run in order. Failures reject with `HISTORY_FAILED` and keep the step. |
| `canUndo()` / `canRedo()` | `boolean` | Whether a step is available. |
| `getHistory()` | `{ undo: string[], redo: string[] }` | Step labels, newest first. |
| `clearHistory()` | `void` | Forgets every step. |

### Assets

| Member | Returns | Description |
| --- | --- | --- |
| `getAssetManifest()` | `AssetManifest` | `{ images: ImageAsset[], fonts: FontAsset[] }` for the current canvas. |
| `checkAssets()` | `Promise<AssetReport>` | `{ manifest, missingImages, unavailableFonts, warnings }`. |
| `replaceImage(oldUrl, newUrl)` | `Promise<number>` | Replaces every image with that URL and keeps its size on the page, as one undo step. |

### Export

| Member | Returns | Description |
| --- | --- | --- |
| `export(options)` | `Promise<ExportResult>` | See `ExportOptions`. It rejects with `EXPORT_BLOCKED` and a list of `problems` when something would break the output. |
| `preflightExport(options)` | `Promise<ExportPreflight>` | `{ ok, problems, warnings }` without exporting. |

`ExportOptions` is `{ format, scale?, quality?, area?, padding?, background?, signal?, svg? }`:

- `format`: `'png'`, `'jpeg'`, `'webp'`, `'svg'` or `'json'`
- `area`: `'canvas'`, `'content'`, `'selection'`, or `{ left, top, width, height }`
- `background`: `'keep'`, `'transparent'` or a CSS color
- `svg`: `SvgExportOptions`, below

`SvgExportOptions`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `textDecorations` | `'shapes'` or `'css'` | `'shapes'` | `shapes` draws underlines, overlines and line-throughs of ordinary text where the canvas does, and fixes letters raised with `deltaY` on Fabric 6. `css` keeps Fabric's `text-decoration`, which each reader places its own way. |
| `textOnPath` | `'vector'` or `'fabric'` | `'vector'` | `vector` writes text that follows a path exactly as the canvas draws it, including `pathAlign`, `pathSide`, `deltaY`, text backgrounds and underlines. `fabric` keeps Fabric's own output and adds a `TEXT_ON_PATH_APPROXIMATED` warning. |
| `embedImages` | `boolean` or `'require'` | `false` | Puts every image into the file as data, so the SVG opens without the original URLs. `true` exports anyway and warns with `IMAGE_NOT_EMBEDDED`; `'require'` rejects with `EXPORT_BLOCKED` and an `IMAGE_NOT_EMBEDDED` problem. |
| `maxEmbeddedImageBytes` | `number` | 25 MB | Larger images are not embedded. |
| `embedFonts` | `Record<string, FontSource>` | `{}` | Font files to embed, by family. A `FontSource` is a URL, an `ArrayBuffer`, a `Uint8Array` or a `Blob`. Families the canvas uses without a file here get a `FONT_NOT_EMBEDDED` warning. |

Every SVG export also repairs a Fabric 6 and 7 bug: text on a path that contains a space is written as invalid XML (`rotate="..."style="..."`), which browsers and design tools refuse to open.

Clip paths: an inverted clip path is written as an SVG `<mask>`, so the outside of the shape shows as on the canvas. An object whose clip path has a clip path of its own is drawn as a picture with a `CLIP_PATH_RASTERIZED` warning, because Fabric 7 throws and Fabric 6 writes a broken reference for it.

`ExportResult` is `{ format, mimeType, blob, width, height, warnings, document? }`.

### SVG import

```ts
const { objects, viewport, warnings } = await engine.importSvg(svgText, {
  left: 40,
  top: 40,
  fit: { width: 300, height: 200 },
});
```

`SvgImportOptions`:

| Option | Default | Purpose |
| --- | --- | --- |
| `viewport` | `'preserve'` | `preserve` uses the SVG's own `viewBox`, `width` and `height` as the frame, so elements outside it or hidden ones cannot move the artwork. `content` uses the bounds of what is drawn. An SVG with no size always uses `content`. |
| `offscreen` | `'keep'` | `keep`, `drop` (leave out elements entirely outside the viewport) or `clip` (clip to the viewport). |
| `as` | `'group'` | One group with a fixed layout the size of the viewport, or `'objects'` for separate objects in the same places. |
| `left`, `top` | `0` | Where the viewport's top-left corner lands. |
| `fit` | none | `{ width, height, mode? }` scales the viewport into a box. `mode` is `'contain'` (default), `'cover'` or `'fill'`. |
| `crossOrigin` | `'anonymous'` | Passed to images in the SVG. |
| `preserveGroups` | `false` | Rebuilds each `<g>` and `<a>` as a Fabric group (fabric.js #899). Groups keep their `id`, opacity and clip path. Objects lose ids they only inherited from a group. Every object and group gets `svgId`, `svgClass` and `svgData` (its `data-*` attributes), which are saved with the document. |
| `signal` | none | Cancels the import with `LOAD_ABORTED`. |

`SvgImportResult` is `{ objects, viewport: { width, height }, warnings: SvgImportWarning[] }`. A `SvgImportWarning` is `{ code, message }`, where `code` is a `SvgImportWarningCode`:

- `SVG_CONTENT_REMOVED`: scripts, event handlers, `foreignObject`, links to other files or CSS imports were removed.
- `SVG_IMAGE_BLOCKED`: an image address was not allowed by `limits.isAllowedUrl`.
- `SVG_OFFSCREEN_DROPPED`: `offscreen: 'drop'` left elements out.

A `<use>` that points to nothing is left out. Fabric stops expanding every later `<use>` after such a link, so before this fix the rest were missing.

The SVG is checked against `limits` like a document: too many elements or too deep nesting rejects with `UNSAFE_DOCUMENT`. Text that is not SVG rejects with `SVG_IMPORT_FAILED`.

### Versions

| Member | Returns | Description |
| --- | --- | --- |
| `createVersion(name?)` | `Promise<VersionSummary>` | Keeps a named version. |
| `listVersions(documentId?)` | `Promise<VersionSummary[]>` | Newest first. |
| `restoreVersion(versionId)` | `Promise<FabricDocument>` | First keeps an automatic `Before restoring "..."` version. Then it loads the old content as a new, unsaved revision. |
| `deleteVersion(versionId)` | `Promise<void>` | Deletes a version. |

A `VersionSummary` is `{ id, documentId, name, kind: 'named' | 'auto', createdAt, revision }`.

### Recovery

| Member | Returns | Description |
| --- | --- | --- |
| `getRecoverableDocuments()` | `Promise<RecoveryRecord[]>` | Recovery copies, newest first. |
| `getRecovery(documentId?, sessionId?)` | `Promise<RecoveryRecord or undefined>` | The newest copy of a document, or the copy one session wrote. The default is the current document. |
| `restoreRecovery(documentId?, options?)` | `Promise<FabricDocument>` | Loads a copy as unsaved work, keeping its base revision. `RestoreRecoveryOptions` is `LoadOptions` plus `sessionId`, to pick one session's copy. The next save also removes that copy. |
| `discardRecovery(documentId?, sessionId?)` | `Promise<void>` | Deletes one session's copy, or every copy of the document. |
| `flushRecovery()` | `Promise<void>` | Writes a copy now. |
| `getInterruptedLoad()` | `Promise<InterruptedLoad or undefined>` | `{ documentId, startedAt }` of a load that never finished. |

A `RecoveryRecord` is `{ documentId, sessionId, active, savedAt, baseRevision, document, files }`. Each engine is one session, so two tabs editing the same document keep separate copies, and a save removes only the copy it covers. `active` is true while the session that wrote the copy is still open in a tab (Web Locks API). Copies written before 1.2 have the session `legacy`. `getInterruptedLoad` reports loads of sessions that are no longer open.

### Events

`on(name, handler)` subscribes to an event and returns an unsubscribe function. Payloads are fully typed through `DocumentEngineEvents`.

| Event | Payload |
| --- | --- |
| `load:start` | `{ documentId }` |
| `load:progress` | `LoadProgress`: `{ documentId, stage, done, total }` |
| `document:change` | `{ documentId }` |
| `load:success` | `{ document, warnings, migratedFrom }` |
| `load:error` | `{ error }` |
| `assets:warning` | `{ warnings: AssetWarning[] }` |
| `save:start` | `{ document }` |
| `save:success` | `{ document }` |
| `save:error` | `{ error }` |
| `save:retry` | `{ attempt, delay, error }` |
| `save:status` | `SaveState` |
| `history:change` | `{ canUndo, canRedo, undoLabel, redoLabel }` |
| `history:error` | `{ error }` |
| `recovery:checkpoint` | `{ documentId, savedAt }` |
| `recovery:restored` | `{ document }` |
| `recovery:error` | `{ error }` |
| `export:success` | `{ format, width, height, warnings }` |
| `export:error` | `{ error }` |
| `version:created` | `VersionSummary` |
| `version:restored` | `{ version, document }` |
| `version:error` | `{ error }` |

---

## Helpers in the main entry

| Export | Description |
| --- | --- |
| `bindKeyboardShortcuts(engine, { target? })` | Ctrl/Cmd+Z undoes. Ctrl/Cmd+Shift+Z and Ctrl+Y redo. It ignores text inputs. Returns an unbind function. |
| `bindUnsavedChangesWarning(engine, target?)` | Asks the browser to confirm before a page with unsaved changes closes. Returns an unbind function. |
| `downloadExport(result, fileName?)` | Starts a browser download of an export result. |
| `renderDocuments(documents, options)` | Renders many documents on a few reused off-screen canvases. See [Rendering many documents](#rendering-many-documents). |
| `createDocumentStateStore(engine)` | Framework-free `{ getSnapshot, subscribe, destroy }` with `DocumentState`. |
| `validateDocument(value)` | Returns `DocumentIssue[]` with the path of each problem. |
| `migrateDocument(value, context)` | Upgrades an older document or plain Fabric JSON. Returns `{ document, migratedFrom }`. |
| `detectSchemaVersion(value)` | Returns `1` for documents, `0` for plain Fabric JSON, otherwise `undefined`. |
| `secureDocument(value, limits?)` | Removes prototype keys and enforces object and depth limits. Throws `UNSAFE_DOCUMENT`. |
| `refuseUnsafeImageUrls(objects, isAllowed?)` | Throws `UNSAFE_DOCUMENT` when an image address is not allowed. |
| `isSafeImageUrl(url)` | The default address rule. It allows `http`, `https`, `blob`, relative addresses and `data:image/`. |
| `createConflictError(id, expected, actual)` | A `SAVE_CONFLICT` error for storage adapters. |
| `createClipboard(engine, options?)` | Copy, cut and paste. See [Clipboard](#clipboard). |
| `CLIPBOARD_FORMAT` | `'fabricjs-document-engine/objects'`, the `format` of `ClipboardContent`. |
| `bringToFront(engine, objects?, options?)` | Moves objects, or the selection, to the top. See [Layers](#layers). |
| `sendToBack(engine, objects?, options?)` | Moves objects, or the selection, to the bottom. |
| `bringForward(engine, objects?, options?)` | Moves objects one step up. Neighbours move as a block. |
| `sendBackward(engine, objects?, options?)` | Moves objects one step down. |
| `moveToIndex(engine, objects, index, options?)` | Moves objects to an index counted from the bottom, as a block. |
| `getLayers(engine)` | `LayerInfo[]` from top to bottom. |
| `createTextCommands(engine)` | Text edits that keep letter styles in place. See [Text edits](#text-edits). |
| `replaceTextRange(text, start, end, insert, style?)` | Replaces letters `start` to `end` and moves every style with its letters. No undo step on its own. |
| `setTextRangeStyle(text, start, end, style)` | Merges a style into letters `start` to `end`. |
| `shiftStyleRuns(runs, start, end, insertedLength, style?)` | Moves `StyleRun[]` for one edit. Pure, O(runs). |
| `readStyleRuns(graphemes, styles)` | Fabric's per-line styles as `StyleRun[]`. |
| `writeStyleRuns(graphemes, runs)` | `StyleRun[]` back to Fabric's per-line styles. |
| `isDocumentEngineError(value)` | Type guard. |
| `DocumentEngineError` | Error class with `code`, `issues`, `unknownTypes`, `missingAssets`, `missingFonts`, `problems`, `migrationFrom`, `retryable` and `cause`. |
| `CURRENT_SCHEMA_VERSION` | `1` for every 1.x release. |

### Clipboard

```ts
const clipboard = createClipboard(engine, { offset: 10 });
clipboard.copy();            // the selection, or pass objects
await clipboard.paste();     // one undo step, fresh ids, selected
clipboard.cut();             // one undo step; the next paste lands in place
await clipboard.paste({ target: otherEngine });
```

| Member | Returns | Description |
| --- | --- | --- |
| `copy(objects?)` | `number` | Copies top-level objects, or the selection, in stacking order. Custom properties and the position of objects in a moved, rotated or scaled selection are kept. |
| `cut(objects?)` | `number` | Copies, then removes the objects as one undo step. |
| `paste(options?)` | `Promise<FabricObject[]>` | Adds a copy as one undo step. Every object, group child and clip path gets a new id. Each paste moves `offset` further. `PasteOptions` is `{ target?, offset?, select? }`. |
| `hasContent()` | `boolean` | Whether something was copied. |
| `read()` | `ClipboardContent` or `undefined` | `{ format, version: 1, objects }` as plain JSON, for the system clipboard. |
| `write(content)` | `void` | Replaces the content, for example with JSON from another tab. It is checked like a loaded document and throws `INVALID_DOCUMENT` or `UNSAFE_DOCUMENT`. |
| `clear()` | `void` | Empties the clipboard. |

`ClipboardOptions` is `{ offset?, limits? }`. A paste with an object type that is not registered rejects with `UNKNOWN_OBJECT_TYPE`.

### Layers

Each command takes the objects to move, or uses the selection, and records one undo step. It returns `false`, and records nothing, when the order would not change.

`LayerOptions` is `{ pinned? }`. `pinned` is a `LayerPin`, `(object) => boolean`. A pinned object, such as a background or a frame, never moves and keeps its place in the stack:

```ts
const keepBackground = { pinned: (object) => object.name === 'background' };
sendToBack(engine, undefined, keepBackground);
```

A `LayerInfo` is `{ id, type, name, index, visible, locked }`. `name` is the object's `name` property, which the engine saves with the document. `locked` is true when the object cannot be selected.

### Text edits

Setting `text` on a Fabric text object leaves every letter style at its old position, so after an insert the bold word is no longer bold (fabric.js #6133). These commands move styles with their letters, keep the cursor and the hidden textarea in step while the user types, fire `changed` and `text:changed`, and record one undo step each.

```ts
const text = createTextCommands(engine);
text.insertText(title, 0, 'New: ');
text.replaceText(title, 5, 9, 'Big', { fontWeight: 'bold' });
text.deleteText(title, 0, 5);
text.setTextStyle(title, 0, 3, { fill: 'red' });
```

Positions count graphemes, as `selectionStart` does, so an emoji is one letter. `TextCommands` has `insertText(target, index, text, style?)`, `deleteText(target, start, end)`, `replaceText(target, start, end, text, style?)` and `setTextStyle(target, start, end, style)`. `target` is an `EditableTextObject`: an `IText`, a `Textbox` or a subclass. An `InsertedStyle` is a style object, `null` for no style, or `undefined` to take the style of the letter before. A `StyleRun` is `{ start, end, style }`.

### Rendering many documents

```ts
for await (const { index, documentId, result, error } of renderDocuments(documents, { format: 'png', scale: 2 })) {
  if (result) await upload(documentId, result.blob);
  else console.warn(index, error?.code);
}
```

`renderDocuments` is an async generator. It yields a `RenderedDocument`, `{ index, documentId, result?, error? }`, as each document finishes, so results can be stored one by one instead of being held in memory. A failed document has `error` and the others still render. `documents` is any iterable or async iterable of documents or plain Fabric JSON.

`RenderDocumentsOptions` takes every `ExportOptions` field, plus:

| Option | Default | Purpose |
| --- | --- | --- |
| `concurrency` | `2` | How many documents render at the same time, each on its own canvas. |
| `onProgress` | none | Called with `{ done, total }` after each document. `total` is set for arrays. |
| `customObjects`, `assets`, `limits` | none | As for `createDocumentEngine`. |
| `signal` | none | Stops the batch with `EXPORT_ABORTED`. |

Every canvas a batch creates is freed when it ends, stops early or is cancelled, including the cache canvases Fabric creates for each object.

## `fabricjs-document-engine/storage`

| Export | Description |
| --- | --- |
| `createMemoryStorage()` | In-memory storage with revisions, listing and versions. |
| `createLocalStorage({ prefix?, storage? })` | The same, backed by `localStorage`. |
| `createKeyValueStorage(store, prefix)` | The same, on any `{ read, write, remove, keys }` store. |
| `verifyStorageAdapter(storage)` | Runs the storage contract against an adapter. Returns `{ ok, checks }`. |

The built-in adapters also offer `listDocuments()` and `deleteDocument(id)`.

## `fabricjs-document-engine/recovery`

| Export | Description |
| --- | --- |
| `createIndexedDbRecovery({ databaseName?, storeName? })` | IndexedDB checkpoints plus a synchronous localStorage copy when the page closes. |
| `createMemoryRecovery()` | In-memory store for tests. |

A custom store implements `{ get, set, delete, keys }` and optionally a synchronous `setNow`.

## `fabricjs-document-engine/react`

| Export | Description |
| --- | --- |
| `useDocumentEngine(canvas, options?)` | Creates the engine when `canvas` exists and destroys it on unmount. Returns `DocumentEngine` or `null`. |
| `useDocumentState(engine)` | `DocumentState` or `null`, updated on every change. |
| `useDocumentEvent(engine, name, handler)` | Subscribes to an event with the latest handler. |
| `DocumentEngineProvider` | Context provider, used as `<DocumentEngineProvider engine={engine}>`. |
| `useEngine()` | Reads the engine from context. |
| `useLayers(engine)` | `LayerInfo[]` from top to bottom, updated after every undo step, load, add and remove. |

`DocumentState` is `{ documentId, isLoading, loadError, saveStatus, isDirty, isSaving, revision, lastSavedAt, saveError, canUndo, canRedo, undoLabel, redoLabel, assetWarnings }`.

## `fabricjs-document-engine/pdf`

PDF export with [jsPDF](https://github.com/parallax/jsPDF) and [svg2pdf.js](https://github.com/yWorks/svg2pdf.js), which are optional peer dependencies: `npm install jspdf svg2pdf.js`. They load only when a PDF is made. `mode: 'raster'` needs only `jspdf`.

| Export | Description |
| --- | --- |
| `exportPdf(sources, options?)` | Makes a PDF with one page per source. A source is a `DocumentEngine`, a Fabric canvas, or a saved document or plain Fabric JSON. Returns `Promise<PdfExportResult>`. |
| `layoutPage(content, options?)` | Where a canvas of `{ width, height }` pixels lands on a page, as a `PageLayout` in points. |
| `PAGE_SIZES` | The named sizes in points, portrait: `A3`, `A4`, `A5`, `Letter`, `Legal` and `Tabloid`. |
| `POINTS_PER_PIXEL` | `0.75`: one CSS pixel is 1/96 inch, a PDF point 1/72 inch. |

`PdfExportOptions`:

| Option | Default | Purpose |
| --- | --- | --- |
| `page` | `'canvas'` | A `PdfPageSize`: a named size, `'canvas'` for a page the size of the canvas, or `[width, height]` in points. |
| `orientation` | `'auto'` | A `PdfOrientation`. `auto` turns named pages to match the drawing. |
| `margin` | `0` | Points, as one number or a `PdfMargin`, `{ top, right, bottom, left }`. |
| `fit` | `'contain'` | A `PdfFit`. `contain` shows all of the canvas, `cover` fills the box and clips, `none` prints at real size. |
| `mode` | `'hybrid'` | A `PdfMode`. `vector` draws everything as PDF vectors and text. `raster` draws each page as one picture. `hybrid` uses vectors, and draws only what PDF vectors cannot show as a picture of that object: shadows, blend modes, gradient outlines, non-scaling outlines on scaled objects, and text that needs a font file. |
| `dpi` | `300` | Resolution of everything drawn as a picture. |
| `fonts` | `[]` | `PdfFont[]`: `{ family, source, weight?, style? }`. `source` is a TrueType (.ttf) URL or its bytes. `style` is a `PdfFontStyle`, `'normal'` or `'italic'`. Text in these families stays real, selectable text. |
| `missingFonts` | `'rasterize'` in hybrid mode | Text in a family with no file: `rasterize` draws it as a picture, `substitute` uses the closest built-in PDF font. Built-in fonts cover Latin-1 letters only, so other letters are always drawn as a picture. Arial, Helvetica, Times and Courier and the generic families map to built-in fonts. |
| `background` | `'keep'` | As for `export`. |
| `metadata` | none | `{ title?, author?, subject?, keywords?, creator? }`. |
| `customObjects`, `assets`, `limits` | none | Used for documents passed as sources. |
| `signal` | none | Cancels with `EXPORT_ABORTED`. |

`PdfExportResult` is `{ blob, pageCount, warnings }`. A `PdfWarning` is `{ code, message, page, objectIds, family?, url? }`, where `code` is a `PdfWarningCode`:

- `PDF_RASTERIZED`: an object was drawn as a picture in hybrid mode, and the message says why.
- `PDF_UNSUPPORTED`: in vector mode, an object may look different, for example a shadow that is left out.
- `PDF_FONT_SUBSTITUTED`: text used a built-in font, or another file of the same family because no file was given for its weight or style.
- `IMAGE_NOT_EMBEDDED`: an image could not be read, usually because of CORS, and is missing from the page.

The page layout types are `NamedPageSize`, `PageLayout` and `PageLayoutOptions`.

## `fabricjs-document-engine/text`

Text classes for problems Fabric's text objects have. Register them with the engine so documents that use them save and load:

```ts
import { BoundedTextbox, VerticalText, attachMobileTextInput, textObjects } from 'fabricjs-document-engine/text';

const engine = createDocumentEngine({ canvas, customObjects: textObjects });
```

| Export | Description |
| --- | --- |
| `BoundedTextbox` | A Textbox that keeps its width, with optional height limit, overflow and shrink-to-fit (fabric.js #2376). |
| `ShapedIText`, `ShapedTextbox` | IText and Textbox whose cursor, selection and clicks follow joined letters and ligatures (fabric.js #4815). |
| `VerticalText` | Editable vertical text for Chinese, Japanese and Korean (fabric.js #511). |
| `attachMobileTextInput(canvas, options?)` | Correct typing with phone keyboards, autocorrect and IME (fabric.js #6588). Returns a `MobileTextInput`, `{ detach() }`. |
| `textObjects` | `CustomObjectDefinition[]` for all the classes above. |
| `registerTextObjects()` | Registers the classes with Fabric, for `loadFromJSON` without an engine. |
| `findTextEdit(previous, next, cursor)` | The edited range between two grapheme lists, used by the mobile adapter. |
| `shapeLine(text, lineIndex, measured)`, `shapeWord(text, word, lineIndex, offset, fallback)`, `drawsJoinedRuns(text)` | The shaped measuring, for your own text classes. `text` is an `AnyText`. |
| `orientationOf(grapheme)`, `orientationOfCodePoint(codePoint)`, `Orientation` | UAX #50 vertical orientation: `Orientation.Upright`, `Rotated` or `UprightShifted`. |

### `BoundedTextbox`

Fabric widens a Textbox to its longest word. A `BoundedTextbox` breaks a word that is wider than the box between letters, so long links and text without spaces stay inside. The box is never narrower than its widest letter.

`BoundedTextboxProps`:

| Option | Default | Purpose |
| --- | --- | --- |
| `breakWords` | `'anywhere'` | A `BreakWords`. `never` acts like a Textbox. |
| `maxHeight` | none | The tallest the box may be. |
| `overflow` | `'visible'` | A `TextOverflow`: `visible`, `clip` (cut at `maxHeight`), or `ellipsis` (hide the lines past `maxHeight` and end the last one with "…"). The text itself is not changed. |
| `fit` | `'none'` | A `TextFit`. `shrink` makes the text smaller, in half points, until it fits `maxHeight`. |
| `minFontSize` | `6` | The smallest size `shrink` goes to. |
| `shaping` | `false` | Measure as `ShapedTextbox` does. |

With `fit: 'shrink'`, `fontSize` reads the size drawn and `getBaseFontSize()` the size you set. The document saves the size you set. `fitScale` is the share used.

### `ShapedIText` and `ShapedTextbox`

Fabric measures letters one by one and draws runs of letters together, where the font joins them. In Arabic at 40px, the cursor lands up to two letters away from where it should be. These classes measure each position from the text as the browser shapes it, by words, with a cache. Text with letter spacing, `justify` or a path is drawn letter by letter by Fabric and is measured as Fabric does.

### `VerticalText`

Lines become columns, read top to bottom and placed right to left. Chinese, Japanese and Korean characters stand upright and Latin text turns 90°, following Unicode's vertical orientation table (UAX #50). The cursor is a horizontal bar. ↓ and ↑ move along a column, ← and → move to the next and previous column. IME input works as in any IText. SVG and PDF export draw each upright character and each turned run with its own position, without `writing-mode`.

`VerticalTextProps`:

| Option | Default | Purpose |
| --- | --- | --- |
| `textOrientation` | `'mixed'` | A `TextOrientation`. `upright` stands every character up. |
| `combineUpright` | `'none'` | A `CombineUpright`. `digits2` sets one or two digits side by side in one square (tate-chū-yoko). |

`textAlign` places columns along their length: `left` at the top, `center`, `right` at the bottom.

### `attachMobileTextInput`

Android keyboards send keyCode 229 for every key and change the text away from the cursor: autocorrect replaces a word before it, and a swipe on the space bar moves it. Fabric works out each edit from its own cursor, so text and styles land in the wrong place. The adapter reads each edit from the text itself and applies it with `replaceTextRange`. It also follows cursor moves made by the keyboard, focuses the textarea inside the tap so the keyboard opens, uses a 16px font so iOS does not zoom, and keeps the textarea at the cursor when the keyboard resizes the page. Attach it before editing starts.

`MobileTextInputOptions`:

| Option | Default |
| --- | --- |
| `inputMode` | `'text'` |
| `enterKeyHint` | `'enter'` |
| `autocapitalize` | `'sentences'` |
| `autocorrect` | `true` |
| `spellcheck` | `false` |

## `fabricjs-document-engine/performance`

Faster rendering for canvases with many objects (fabric.js #9847).

| Export | Description |
| --- | --- |
| `enableDirtyRegionRendering(canvas, options?)` | Redraws only what changed. Returns a `DirtyRegionRenderer`. |
| `createPerformanceMonitor(canvas, options?)` | Frame times and objects drawn. Returns a `PerformanceMonitor`. |
| `batchCanvasUpdates(canvas, work)` | Runs many adds and changes with one render at the end. Nests, and works with async work. |
| `createSpatialIndex(options?)` | The grid index the renderer uses. Returns a `SpatialIndex` with `set`, `delete`, `has`, `query`, `clear` and `size`. `SpatialIndexOptions` is `{ cellSize?, maxCellsPerItem? }`. A `Rect` is `{ left, top, width, height }`. |

### `enableDirtyRegionRendering`

```ts
const renderer = enableDirtyRegionRendering(canvas);
```

Each frame, one pass compares a fingerprint of every object with the last frame: its transform, size, stack position, shadow, stroke, `dirty` flag and those of its children. So changes made with `set()` and no event are seen. Each changed object marks its old and new bounds, grown for shadows, stroke joins, text overhang and anti-aliasing, and the selection's controls mark their area. A grid index finds the objects that touch the marked areas, and Fabric's own `renderCanvas` draws only those, once, clipped to the areas. `before:render` and `after:render` still fire once per frame.

The frame is drawn in full when the view, size, background, overlay or canvas clip path change, or when the marked area is larger than `fullRedrawRatio`. A frame where nothing changed draws nothing. Exports and `toCanvasElement` always draw in full.

`DirtyRegionOptions` is `{ fullRedrawRatio?: 0.4, maxRegions?: 4, cellSize?: 256 }`. `DirtyRegionRenderer` has `invalidate()` (draw the next frame in full, for changes made inside a custom `_render`), `stats()` and `disable()`. `DirtyRegionStats` is `{ frames, fullFrames, skippedFrames, lastObjectsDrawn, lastAreaRatio, lastRegions }`.

Chromium and Firefox smooth the edges of shapes slightly differently when a clip is active, so an edge pixel can differ by a few shades from a full redraw. Shapes, colors and positions are the same.

### `createPerformanceMonitor`

`PerformanceMonitorOptions` is `{ samples?: 120 }`. `PerformanceMonitor` has `stats()`, `reset()` and `stop()`. `FrameStats` is `{ frames, averageMs, p50Ms, p95Ms, worstMs, lastObjectsDrawn }`.

## `fabricjs-document-engine/filters`

Image filters off the main thread (fabric.js #9532). `FabricImage.applyFilters` runs every filter over every pixel before the page can paint again.

```ts
const filterWorker = createFilterWorker({ engine });
await filterWorker.apply(image, [new filters.Blur({ blur: 0.2 }), new filters.Brightness({ brightness: 0.1 })], {
  onProgress: (done) => setProgress(done),
  signal,
});
```

| Export | Description |
| --- | --- |
| `createFilterWorker(options?)` | Returns a `FilterWorker`. |
| `runFilterPipeline(filters, state, options?)` | Runs filters on `ImageData` in steps. `PipelineState` matches Fabric's 2D pipeline state. `PipelineOptions` is `{ bandRows?, onProgress?, isCancelled?, pause? }`. A `PipelineFilter` is any Fabric filter. |
| `canRunInWorker(filters)` | True when every filter, inside `Composed` ones too, can run in a worker. |
| `flattenFilters(filters)` | `Composed` filters replaced by their sub-filters. |
| `PIXEL_FILTERS`, `WORKER_FILTERS` | The filter types run in bands of rows, and all the types a worker runs. |

`FilterWorker`:

| Member | Description |
| --- | --- |
| `apply(image, filters?, options?)` | Applies filters, by default the image's own. Resolves `true` when the image was updated and `false` when a newer run for the same image replaced it. Rejects with the signal's reason when aborted. The image only changes when the result is ready. `ApplyFilterOptions` is `{ signal?, onProgress? }`. |
| `mode` | `'worker'` or `'main-thread'`. |
| `terminate()` | Stops the workers. Runs still going resolve `false`. |

`FilterWorkerOptions`:

| Option | Default | Purpose |
| --- | --- | --- |
| `createWorker` | the shipped worker | Makes a worker. Use it when your bundler needs its own worker setup. |
| `worker` | `true` | `false` runs the steps on the main thread with a pause after each. |
| `poolSize` | `1` | Workers to run at once. |
| `bandRows` | `64` | Rows per step for pixel filters. |
| `engine` | none | Records each finished run as one undo step and drops runs that finish after another document opened. |

The picture and the result are transferred as `ImageBitmap`s, not copied. Pixel filters run together over bands of rows, with progress and a cancel check after each band. Blur, Convolute and Pixelate run over the whole picture as one step. The results match Fabric's 2D filter backend. Filters a worker cannot run, such as BlendImage, Resize or your own, use Fabric's `applyFilters`. Without `Worker` and `OffscreenCanvas` (Safari before 16.4), or from the CommonJS build, the steps run on the main thread. An `ImageFilter` is any Fabric filter.

## Error codes

| Code | When |
| --- | --- |
| `INVALID_DOCUMENT` | The document shape is wrong, or the imported text is not JSON. |
| `UNSAFE_DOCUMENT` | An unsafe image address, too many objects, or nesting too deep. |
| `UNSUPPORTED_SCHEMA` | Written by a newer major version of this package. |
| `UNKNOWN_OBJECT_TYPE` | A custom class is not registered. |
| `INVALID_CUSTOM_OBJECT` | A registered class has no static `type`, or is not a Fabric class. |
| `MIGRATION_FAILED` | An older document could not be upgraded. |
| `LOAD_ABORTED` | The load's `signal` was cancelled, or a newer load or `destroy` stopped it. |
| `LOAD_FAILED` | Fabric or storage failed to load. |
| `MISSING_ASSETS` | Images could not be loaded. Each entry in `missingAssets` has a `failure` with the reason. |
| `MISSING_FONTS` | Fonts are unavailable and `requireFonts` is on. |
| `ASSET_UPLOAD_FAILED` | The `upload` handler failed. |
| `UNSAVED_CHANGES` | Opening another document would discard unsaved changes. |
| `STORAGE_MISSING` | `load`, `save` or autosave was used without storage. |
| `SAVE_FAILED` | Storage refused after all retries. |
| `SAVE_CONFLICT` | Another tab or device saved first. |
| `SAVE_CANCELLED` | A save was dropped because another document was opened, or the engine was destroyed. |
| `DOCUMENT_NOT_FOUND` | A built-in adapter has no such document. |
| `HISTORY_FAILED` | Undo or redo could not rebuild an object. |
| `RECOVERY_MISSING` / `RECOVERY_NOT_FOUND` / `RECOVERY_FAILED` | Recovery is not configured, has no copy, or could not write one. |
| `VERSIONS_UNSUPPORTED` / `VERSION_NOT_FOUND` / `VERSION_FAILED` | Storage has no version methods, there is no such version, or an automatic version failed. |
| `INVALID_EXPORT_OPTIONS` / `EXPORT_BLOCKED` / `EXPORT_ABORTED` / `EXPORT_FAILED` | Export problems, for images, SVG, PDF and `renderDocuments`. |
| `SVG_IMPORT_FAILED` | `importSvg` got text that is not a valid SVG. |
| `LOAD_CONFLICT` | The canvas was edited while a document loaded, so the load stopped to keep the edits. Pass `discardUnsavedChanges: true` to replace them. |
| `DOCUMENT_CHANGED` | Async work (`importSvg`, `replaceImage`, `paste`) finished after another document was opened, so its result was dropped. |
| `PDF_UNAVAILABLE` | `jspdf` or `svg2pdf.js` is not installed, or there is no browser DOM. |
| `PDF_FAILED` | A font file is not TrueType or could not be read, or the PDF could not be made. |
| `ENGINE_DESTROYED` | The engine was used after `destroy()`. |
