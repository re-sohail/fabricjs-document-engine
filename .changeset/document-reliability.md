---
"fabricjs-document-engine": minor
---

Document reliability: nothing the user does is lost, misplaced or left half done.

- **Canvas-level content is saved.** `canvas.backgroundImage`, `overlay`, `overlayImage` and `clipPath` are now saved, reopened, migrated from plain Fabric JSON, checked for missing images, and kept in versions and recovery copies. Before, they disappeared after reopening.
- **Page changes are undoable.** New `engine.setPage({ width, height, background, backgroundImage, overlay, overlayImage, clipPath }, label)` records one undo step and marks the document unsaved. History snapshots now include the page as one more entry, so page changes made inside any transaction are recorded too.
- **Typing counts at once.** `text:changed` now marks the document unsaved and schedules autosave and recovery on every keystroke; the edit is still one undo step.
- **Loads keep edits.** A load compares a change counter before it replaces the canvas. If the canvas was edited meanwhile, it stops with the new `LOAD_CONFLICT` code and keeps the edits, unless `discardUnsavedChanges: true` is passed.
- **Async work stays in its document.** `getDocumentInfo().session` goes up whenever the canvas shows another document. `importSvg`, `replaceImage`, clipboard `paste` and undo/redo check it after every wait, and drop their result with the new `DOCUMENT_CHANGED` code instead of changing another document.
- **One recovery copy per tab.** Recovery copies are kept per session and document, so two tabs no longer overwrite each other. `RecoveryRecord` gains `sessionId` and `active` (another tab still open, via the Web Locks API); `getRecovery`, `restoreRecovery` and `discardRecovery` take a session; a save removes only the copies it covers. Copies written by earlier versions are still read.
- **Size limits.** `limits.maxCanvasSide`, `maxCanvasPixels`, `maxImagePixels` and `maxDocumentLength`, with defaults matching what iOS 18 Safari can draw, are checked before any canvas is made. Oversized documents are refused with `UNSAFE_DOCUMENT`, raster exports with `EXPORT_BLOCKED` and a `TOO_LARGE` problem, images with the failure reason `TOO_LARGE`; PDF pages are drawn at a lower resolution instead.
- **Rollback.** `transaction(label, work, { rollback: true })` puts the canvas back when `work` throws or rejects, with no undo step and no unsaved change.
- **SVG clip paths and decorations.** Inverted clip paths are written as SVG masks. Objects with nested clip paths, which make Fabric 7's `toSVG()` throw, are drawn as pictures with a `CLIP_PATH_RASTERIZED` warning. Underlines, overlines and line-throughs of ordinary text are drawn as shapes where the canvas draws them (`svg.textDecorations: 'css'` keeps Fabric's output), which also fixes letters raised with `deltaY` on Fabric 6. Pixel tests compare every case with the canvas on Fabric 6 and 7.
