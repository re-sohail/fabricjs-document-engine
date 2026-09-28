---
"fabricjs-document-engine": minor
---

Reliable history. Undo and redo for adding, deleting, moving, resizing, rotating, restyling, reordering, grouping, ungrouping and text editing, with one undo step per user action. Adds `transaction(label, work)` for grouping code changes (nested and async transactions are supported), `commit(label)`, `canUndo`/`canRedo`, `getHistory()` labels, a configurable history limit, `history:change` and `history:error` events, and a `bindKeyboardShortcuts` helper. Object ids survive undo and redo, and an undo that cannot rebuild an object leaves the canvas unchanged.
