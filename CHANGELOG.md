# fabricjs-document-engine

## 1.1.0

### Minor Changes

- Loading, image errors, clipboard and layers.
  
  - **Why an image failed.** Every missing image in `checkAssets().missingImages`, in `MISSING_ASSETS` errors and in `replaceMissingImage` now has a `failure` with a `reason` (`NOT_FOUND`, `HTTP_ERROR`, `CORS`, `NETWORK`, `TIMEOUT`, `DECODE` or `ABORTED`), the HTTP `status` when the browser allows it, and a message. Images now load six at a time (`assets.maxConcurrentImages`) and each waits at most 30 seconds (`assets.imageTimeout`, `0` to wait forever). Before, a hanging image server held the load forever.
  - **Load progress and cancelling.** `load`, `loadDocument`, `importFabricJson` and `restoreRecovery` accept `signal` and `onProgress`, and the engine emits `load:progress`. Objects are created 100 at a time with a pause for the browser in between, so opening thousands of objects no longer freezes the page. As before, a failed or cancelled load leaves the canvas as it was.
  - **Clipboard.** `createClipboard(engine)` copies, cuts and pastes as one undo step each. Pasted objects, group children and clip paths get new ids, objects from a moved or rotated selection keep their position, custom properties are kept, and content can move between documents and tabs as checked JSON.
  - **Layer commands.** `bringToFront`, `sendToBack`, `bringForward`, `sendBackward`, `moveToIndex` and `getLayers` work on objects or the selection, record one undo step, keep the order of several objects, and can pin a background or frame in place. `useLayers(engine)` in `fabricjs-document-engine/react` keeps a layers panel up to date.
  - **Object names are saved.** The `name` property is now saved with each object, so layer names survive reopening.
  - **Group tests.** Documents with nested, hidden, rotated, skewed, flipped, clipped and fixed-layout groups are saved on Fabric 6 and 7 and reopened on both, and checked again after ungrouping.
- PDF export and rendering many documents.
  
  - **PDF export.** The new `fabricjs-document-engine/pdf` entry exports engines, Fabric canvases and saved documents as PDF, one page each, with page sizes, orientation, margins and fit. It uses `jspdf` and `svg2pdf.js` as optional peer dependencies, loaded only when a PDF is made, so the core keeps no dependencies. Text in the TrueType fonts you pass, and in Arial, Helvetica, Times and Courier, stays real, selectable text. The default hybrid mode draws everything as vectors and draws only what PDF vectors cannot show (shadows, blend modes, gradient outlines, non-scaling outlines on scaled objects, and text that needs a missing font) as a picture of that object, with a warning. Curved text and underlines come out as on the canvas. Every page is checked against the canvas pixel by pixel in the tests.
  - **Rendering many documents.** `renderDocuments(documents, options)` renders documents to PNG, JPEG, WebP, SVG or JSON on a few reused off-screen canvases and yields each result as it finishes. A broken document reports its own error and the others still render. Every canvas a batch creates is freed, including Fabric's per-object cache canvases, whose memory browsers otherwise release only much later.
  - **Freed memory in image exports.** The temporary canvas behind each PNG, JPEG or WebP export is now released as soon as it is encoded, and the font check reuses one small canvas instead of creating a new one on every check.
- SVG export and import.
  
  - **Curved text in SVG.** Text that follows a path is now written as the canvas draws it: each letter at its place and angle, with `pathAlign`, `pathSide`, `pathStartOffset`, `deltaY`, letter styles, text backgrounds, underlines, overlines, line-throughs, outlines and the visible guide path all in the right place. Fabric's own output ignores `pathAlign`, moves raised letters the wrong way and draws backgrounds and underlines straight. Pixel tests compare every case with the canvas on Fabric 6 and 7 in Chromium, Firefox and WebKit. `svg: { textOnPath: 'fabric' }` keeps Fabric's output, with a `TEXT_ON_PATH_APPROXIMATED` warning.
  - **Valid SVG for text with spaces on a path.** Fabric 6 and 7 write `rotate="..."style="..."` for spaces in text on a path, which is not valid XML, so browsers and Illustrator refuse the whole file. Every SVG export now repairs it.
  - **Self-contained SVG.** `svg: { embedImages: true }` puts images, including pattern fills and images in groups, into the file as data, and `svg.embedFonts` embeds font files by family, including fonts set on single letters. Images that cannot be read are reported with `IMAGE_NOT_EMBEDDED`, or block the export with `embedImages: 'require'`.
  - **SVG import.** `engine.importSvg(svg, options)` adds an SVG where its viewport puts it, so elements outside the viewBox or hidden ones no longer move the artwork. It can place and fit the SVG, drop or clip what lies outside, add one group or separate objects, and counts as one undo step. Scripts, event handlers, `foreignObject` and links to other files are removed, and size limits apply. Invalid SVG rejects with the new `SVG_IMPORT_FAILED` code.

### Patch Changes

- fefe1cf: Rewrote the README around the problems it solves, added a Simplified Chinese README (`README.zh-CN.md`), and pointed `homepage` to the documentation site.

## 1.0.1

### Patch Changes

- cc42940: `load(id)` now claims the load before it reads storage. Before, when storage answered out of order, an older `load` could replace a newer one that had already finished. The older call now rejects with `LOAD_ABORTED`.
- `destroy()` no longer writes a recovery copy when the Fabric canvas was already disposed. React runs cleanups in hook order, so a component that creates the canvas before the engine disposes it first; the final copy then held an empty page and replaced the last good checkpoint.
- `save()` and `clearHistory()` now count objects added earlier in the same task. Before, `canvas.add(shape)` followed at once by `save()` left the document marked unsaved, and `clearHistory()` right after an edit dropped the change, so the edit was not treated as unsaved work.

## 1.0.0

### Major Changes

- 1.0: a stable API and a frozen document format.
  
  - **Frozen format.** Schema version 1 is frozen and published as a JSON Schema at `fabricjs-document-engine/schema/document-v1.json`. A reference document written by 1.0 and a Fabric 5 document are part of the test suite, and every future 1.x release must open them unchanged.
  - **Data-loss guards.** With a storage adapter, `load`, `loadDocument`, `importFabricJson` and `newDocument` now refuse with `UNSAVED_CHANGES` instead of silently replacing unsaved work. Pass `{ discardUnsavedChanges: true }` to replace it on purpose. `destroy()` now writes a recovery copy of unsaved work when recovery is configured.
  - **Adapter checker.** `verifyStorageAdapter(storage)` checks any storage adapter against the save contract: revision conflicts, overwrite, missing documents and versions.
  - **Documentation.** The repository gains a complete API reference, kept complete by a test, a compatibility policy that sets out the 1.x promises, and a production setup guide.

## 0.8.0

### Minor Changes

- Hardening. Imported documents are now treated as untrusted:
  - `__proto__`, `constructor` and `prototype` keys are removed before Fabric sees them.
  - Image addresses are checked after `resolveUrl` and before any fetch. `javascript:`, `file:` and non-image `data:` addresses are refused.
  - Object count and nesting depth are limited, and all of this is configurable with `limits: { maxObjects, maxDepth, isAllowedUrl }`. Violations reject with the new `UNSAFE_DOCUMENT` error. `secureDocument`, `refuseUnsafeImageUrls` and `isSafeImageUrl` are exported for server-side checks.
  
  Undo history now has a memory budget, `history.maxBytes` (default 64 MB), that drops the oldest steps first.
  
  Fixes:
  - Undo no longer slows down quadratically with large documents. It was 149 ms at 5,000 objects in Firefox and is now 28 ms.
  - Recovery copies keep image data as bytes, so they work in WebKit, which cannot store `Blob` values in IndexedDB.
  - Raster exports use `canvas.toBlob` instead of a base64 round trip, which lowers peak memory.
  
  The test suite now also runs in Firefox and WebKit, checks importing in Node, and covers cancellation, custom objects inside groups and clip paths, and performance budgets. The repository gains published compatibility and performance results, plus accessibility guidance for editor controls.

## 0.7.0

### Minor Changes

- Developer experience. Adds the `fabricjs-document-engine/react` entry, marked `'use client'`: `useDocumentEngine(canvas, options)` creates the engine when the canvas exists and destroys it on unmount (safe in StrictMode), `useDocumentState(engine)` exposes `isDirty`, `isSaving`, `saveStatus`, `revision`, `canUndo`, `canRedo`, undo and redo labels, `isLoading`, `loadError` and `assetWarnings`, and `useDocumentEvent`, `DocumentEngineProvider` and `useEngine` are included too. React is an optional peer dependency and the core never imports it; the build now verifies both. Adds the framework-free `createDocumentStateStore(engine)`, which only listens to the engine while it has subscribers, and the `document:change` event. The repository gains storage examples (REST with revision checks, key-value stores and uploads) and a troubleshooting guide.

## 0.6.0

### Minor Changes

- Versions and migration. Adds `createVersion(name)`, `listVersions()`, `restoreVersion(id)` and `deleteVersion(id)`. Restoring first keeps an automatic `Before restoring "..."` version, then loads the old content as a new unsaved revision of the same document, so nothing is lost and history stays linear. Adds `versions: { autoEvery, keepAuto }` to keep automatic versions every N saves, with retention that keeps every named version and the newest automatic ones. The built-in storage adapters implement the new `VersionStorage` methods, and versions are left out of `listDocuments` and deleted with their document. Adds a step-by-step schema migration chain. Plain Fabric JSON from Fabric 5, 6 or 7 opens through `importFabricJson(json, { id, metadata })`, `loadDocument` or `load(id)`, and a document loaded with `load(id)` keeps its id. Also adds `migratedFrom` on `load:success`, `MIGRATION_FAILED` errors, the exported `migrateDocument` and `detectSchemaVersion`, and the `version:created`, `version:restored` and `version:error` events.

## 0.5.0

### Minor Changes

- Export. Adds `engine.export({ format, scale, quality, area, padding, background, signal })` for PNG, JPEG, WebP, SVG and editable JSON. The area can be the canvas, the content, the selection or any rectangle. Exports always use document coordinates whatever the current zoom and pan, and never change the canvas, the history or the unsaved state. A JPEG with no background gets white instead of black. Before rendering, a preflight finds broken images, cross-origin images that would taint a picture export, and missing fonts. The export then either succeeds or rejects with `EXPORT_BLOCKED`, whose `problems` list names each URL or font and the objects that use it. Adds `engine.preflightExport(options)`, the `downloadExport(result, fileName)` helper, the `export:success` and `export:error` events, and the `INVALID_EXPORT_OPTIONS`, `EXPORT_ABORTED` and `EXPORT_FAILED` errors.

## 0.4.0

### Minor Changes

- Recovery. Adds the `fabricjs-document-engine/recovery` entry with `createIndexedDbRecovery` and `createMemoryRecovery`, and the `recovery: { store, interval }` option. While there are unsaved changes, the engine writes throttled checkpoints to IndexedDB, including the data of tab-only `blob:` images. When the tab is hidden, refreshed or closed, it also writes an immediate copy to localStorage, because browsers drop IndexedDB writes during unload. Copies are removed once a save covers every change, so a save interrupted by a crash keeps its copy. Adds `getRecoverableDocuments`, `getRecovery`, `restoreRecovery`, `discardRecovery` and `flushRecovery`. A restored document is marked unsaved and keeps its base revision, so a server that moved on reports `SAVE_CONFLICT` instead of being overwritten. Adds `getInterruptedLoad` to detect a crash during loading, plus the `recovery:checkpoint`, `recovery:restored` and `recovery:error` events.

## 0.3.0

### Minor Changes

- Assets and fonts. Saved documents now carry an `assets` manifest listing every image URL and font variant with the objects that use them. Loading checks every image in parallel and every font before touching the canvas. It fails with `MISSING_ASSETS` (listing each URL and object id) or `MISSING_FONTS` when `requireFonts` is on, and otherwise warns with `FONT_UNAVAILABLE`. New `assets` options: `resolveUrl` to rewrite stored URLs, `replaceMissingImage` to supply replacements, `loadFont` to load web fonts before text is created, and `upload` to store tab-only `blob:` and embedded `data:` images when saving (each uploaded once). Adds `IMAGE_CROSS_ORIGIN` warnings for images that would block export, the `assets:warning` event, warnings on `load:success`, and `engine.getAssetManifest()`, `engine.checkAssets()` and `engine.replaceImage(oldUrl, newUrl)`. `replaceImage` keeps each image's size on the page and takes one undo step.

## 0.2.0

### Minor Changes

- Safe saving. Adds dirty tracking (`isDirty`, `getSaveState`, `save:status`), autosave with a quiet-period delay and a maximum wait, one-save-at-a-time with merged follow-up saves so an older response can never overwrite newer work, stale-response protection when another document is opened, revision checks that report `SAVE_CONFLICT` when another tab or device saved first (with `save({ overwrite: true })` to keep your version), exponential backoff retries with `save:retry`, and `bindUnsavedChangesWarning`. Adds the `fabricjs-document-engine/storage` entry with `createMemoryStorage`, `createLocalStorage` and `createKeyValueStorage`. The storage adapter now receives `{ expectedRevision, signal }` as its second argument; adapters written for 0.1 keep working.

## 0.1.0

### Minor Changes

- Reliable history. Undo and redo for adding, deleting, moving, resizing, rotating, restyling, reordering, grouping, ungrouping and text editing, with one undo step per user action. Adds `transaction(label, work)` (nested and async), `commit(label)`, `canUndo`/`canRedo`, `getHistory()` labels, a history limit, `history:change` and `history:error` events, and `bindKeyboardShortcuts`.

## 0.0.0

### Initial Release

- The document foundation. Stable object ids that survive grouping and reloading, a versioned document format, validation that points at the exact problem, custom object registration, safe loading where the newest load wins, a load that fails before touching the canvas when an image is missing, and a simple storage adapter for load and save. Tested on Fabric 6 and Fabric 7.
