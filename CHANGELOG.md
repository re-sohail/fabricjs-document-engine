# fabricjs-document-engine

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
