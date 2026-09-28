# fabricjs-document-engine

## 0.3.0

### Minor Changes

- a5371de: Safe saving. Adds dirty tracking (`isDirty`, `getSaveState`, `save:status`), autosave with a quiet-period delay and a maximum wait, one-save-at-a-time with merged follow-up saves so an older response can never overwrite newer work, stale-response protection when another document is opened, revision checks that report `SAVE_CONFLICT` when another tab or device saved first (with `save({ overwrite: true })` to keep your version), exponential backoff retries with `save:retry`, and `bindUnsavedChangesWarning`. Adds the `fabricjs-document-engine/storage` entry with `createMemoryStorage`, `createLocalStorage` and `createKeyValueStorage`. The storage adapter now receives `{ expectedRevision, signal }` as its second argument; adapters written for 0.1 keep working.

## 0.2.0

### Minor Changes

- Reliable history. Undo and redo for adding, deleting, moving, resizing, rotating, restyling, reordering, grouping, ungrouping and text editing, with one undo step per user action. Adds `transaction(label, work)` (nested and async), `commit(label)`, `canUndo`/`canRedo`, `getHistory()` labels, a history limit, `history:change` and `history:error` events, and `bindKeyboardShortcuts`. These features first reached npm inside 0.1.0; 0.2.0 was skipped on npm so that npm versions match the roadmap from 0.3.0 on.

## 0.1.0

### Minor Changes

- First release: the document foundation. Stable object ids that survive grouping and reloading, a versioned document format, validation that points at the exact problem, custom object registration, safe loading where the newest load wins, a load that fails before touching the canvas when an image is missing, and a simple storage adapter for load and save. Tested on Fabric 6 and Fabric 7. First published to npm as 0.0.0.
