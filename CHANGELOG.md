# fabricjs-document-engine

## 0.2.0

### Minor Changes

- Reliable history. Undo and redo for adding, deleting, moving, resizing, rotating, restyling, reordering, grouping, ungrouping and text editing, with one undo step per user action. Adds `transaction(label, work)` (nested and async), `commit(label)`, `canUndo`/`canRedo`, `getHistory()` labels, a history limit, `history:change` and `history:error` events, and `bindKeyboardShortcuts`. These features first reached npm inside 0.1.0; 0.2.0 was skipped on npm so that npm versions match the roadmap from 0.3.0 on.

## 0.1.0

### Minor Changes

- First release: the document foundation. Stable object ids that survive grouping and reloading, a versioned document format, validation that points at the exact problem, custom object registration, safe loading where the newest load wins, a load that fails before touching the canvas when an image is missing, and a simple storage adapter for load and save. Tested on Fabric 6 and Fabric 7. First published to npm as 0.0.0.
