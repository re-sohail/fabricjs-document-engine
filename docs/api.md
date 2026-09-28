# API reference

This is the complete public API of `fabricjs-document-engine` 1.x. Everything listed here follows the [compatibility policy](./compatibility-policy.md). Anything not listed here is internal and may change.

The package has four entry points:

| Import | Contents |
| --- | --- |
| `fabricjs-document-engine` | The engine, errors, document helpers, safety checks and export helpers |
| `fabricjs-document-engine/storage` | Storage adapters and the adapter checker |
| `fabricjs-document-engine/recovery` | Recovery stores |
| `fabricjs-document-engine/react` | React hooks, marked `'use client'` |
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
| `limits` | `{ maxObjects?, maxDepth?, isAllowedUrl? }` | `{ 50000, 100, isSafeImageUrl }` | Safety limits for loaded documents. |

### `CustomObjectDefinition`

```ts
{ fabricClass: typeof FabricObject subclass with a static type; properties?: string[] }
```

### `AssetOptions`

| Option | Type | Purpose |
| --- | --- | --- |
| `resolveUrl` | `(url) => string or Promise<string>` | Rewrites stored image URLs before loading. |
| `replaceMissingImage` | `(image: ImageAsset) => string, null or undefined, or a Promise of one` | Supplies a replacement for an image that did not load. |
| `upload` | `(request: UploadRequest) => Promise<string>` | Stores `blob:` and `data:` images while saving, and returns their permanent URL. |
| `loadFont` | `(font: FontAsset) => void or Promise<void>` | Loads a font before text is created. |
| `checkImages` | `boolean` | Set to `false` to skip loading images during the preflight. The default is `true`. |
| `requireFonts` | `boolean` | Fail loading with `MISSING_FONTS`, and export with `MISSING_FONT`, instead of warning. |

---

## `DocumentEngine`

### Documents

| Member | Returns | Description |
| --- | --- | --- |
| `canvas` | `StaticCanvas` | The canvas you passed in. |
| `getDocumentInfo()` | `DocumentInfo` | `{ id, createdAt, updatedAt, metadata }` of the current document. |
| `updateMetadata(changes)` | `void` | Merges `changes` into the metadata and marks the document unsaved. |
| `newDocument(options?)` | `void` | Clears the canvas and starts a new document. Options: `{ id?, metadata?, discardUnsavedChanges? }`. |
| `toDocument()` | `FabricDocument` | Serializes the canvas. Every object gets an id. |
| `loadDocument(document, options?)` | `Promise<FabricDocument>` | Validates, migrates, checks assets, then loads. Options: `{ restoreCanvasSize?, discardUnsavedChanges? }`. |
| `load(id, options?)` | `Promise<FabricDocument>` | Loads from `storage`. The document keeps `id` even if it was stored as plain Fabric JSON. |
| `importFabricJson(json, options?)` | `Promise<FabricDocument>` | Opens plain Fabric JSON, as text or an object. Options: `{ id?, metadata?, restoreCanvasSize?, discardUnsavedChanges? }`. |
| `registerObject(definition)` | `void` | Registers a custom class after creation. |
| `getObjectById(id)` | `FabricObject` or `undefined` | Finds any object, including objects inside groups. |
| `destroy()` | `void` | Stops listening, cancels loads, saves and timers, and writes a recovery copy if there is unsaved work. Every later call throws `ENGINE_DESTROYED`. |

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
| `transaction(label, work)` | the result of `work` | Records everything `work` changes as one undo step. Nested and async work is supported. |
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

`ExportOptions` is `{ format, scale?, quality?, area?, padding?, background?, signal? }`:

- `format`: `'png'`, `'jpeg'`, `'webp'`, `'svg'` or `'json'`
- `area`: `'canvas'`, `'content'`, `'selection'`, or `{ left, top, width, height }`
- `background`: `'keep'`, `'transparent'` or a CSS color

`ExportResult` is `{ format, mimeType, blob, width, height, warnings, document? }`.

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
| `getRecovery(documentId?)` | `Promise<RecoveryRecord or undefined>` | One copy. The default is the current document. |
| `restoreRecovery(documentId?, options?)` | `Promise<FabricDocument>` | Loads a copy as unsaved work, keeping its base revision. |
| `discardRecovery(documentId?)` | `Promise<void>` | Deletes a copy. |
| `flushRecovery()` | `Promise<void>` | Writes a copy now. |
| `getInterruptedLoad()` | `Promise<InterruptedLoad or undefined>` | `{ documentId, startedAt }` of a load that never finished. |

A `RecoveryRecord` is `{ documentId, savedAt, baseRevision, document, files }`.

### Events

`on(name, handler)` subscribes to an event and returns an unsubscribe function. Payloads are fully typed through `DocumentEngineEvents`.

| Event | Payload |
| --- | --- |
| `load:start` | `{ documentId }` |
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
| `createDocumentStateStore(engine)` | Framework-free `{ getSnapshot, subscribe, destroy }` with `DocumentState`. |
| `validateDocument(value)` | Returns `DocumentIssue[]` with the path of each problem. |
| `migrateDocument(value, context)` | Upgrades an older document or plain Fabric JSON. Returns `{ document, migratedFrom }`. |
| `detectSchemaVersion(value)` | Returns `1` for documents, `0` for plain Fabric JSON, otherwise `undefined`. |
| `secureDocument(value, limits?)` | Removes prototype keys and enforces object and depth limits. Throws `UNSAFE_DOCUMENT`. |
| `refuseUnsafeImageUrls(objects, isAllowed?)` | Throws `UNSAFE_DOCUMENT` when an image address is not allowed. |
| `isSafeImageUrl(url)` | The default address rule. It allows `http`, `https`, `blob`, relative addresses and `data:image/`. |
| `createConflictError(id, expected, actual)` | A `SAVE_CONFLICT` error for storage adapters. |
| `isDocumentEngineError(value)` | Type guard. |
| `DocumentEngineError` | Error class with `code`, `issues`, `unknownTypes`, `missingAssets`, `missingFonts`, `problems`, `migrationFrom`, `retryable` and `cause`. |
| `CURRENT_SCHEMA_VERSION` | `1` for every 1.x release. |

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

`DocumentState` is `{ documentId, isLoading, loadError, saveStatus, isDirty, isSaving, revision, lastSavedAt, saveError, canUndo, canRedo, undoLabel, redoLabel, assetWarnings }`.

## Error codes

| Code | When |
| --- | --- |
| `INVALID_DOCUMENT` | The document shape is wrong, or the imported text is not JSON. |
| `UNSAFE_DOCUMENT` | An unsafe image address, too many objects, or nesting too deep. |
| `UNSUPPORTED_SCHEMA` | Written by a newer major version of this package. |
| `UNKNOWN_OBJECT_TYPE` | A custom class is not registered. |
| `INVALID_CUSTOM_OBJECT` | A registered class has no static `type`, or is not a Fabric class. |
| `MIGRATION_FAILED` | An older document could not be upgraded. |
| `LOAD_ABORTED` | A newer load, or `destroy`, stopped this load. |
| `LOAD_FAILED` | Fabric or storage failed to load. |
| `MISSING_ASSETS` | Images could not be loaded. |
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
| `INVALID_EXPORT_OPTIONS` / `EXPORT_BLOCKED` / `EXPORT_ABORTED` / `EXPORT_FAILED` | Export problems. |
| `ENGINE_DESTROYED` | The engine was used after `destroy()`. |
