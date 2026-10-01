# fabricjs-document-engine

Save, load, undo and redo for an existing [Fabric.js](https://fabricjs.com) canvas. Your objects keep their ids, and a slow save never overwrites newer work.

[![npm version](https://img.shields.io/npm/v/fabricjs-document-engine.svg)](https://www.npmjs.com/package/fabricjs-document-engine)
[![bundle size](https://img.shields.io/bundlephobia/minzip/fabricjs-document-engine)](https://bundlephobia.com/package/fabricjs-document-engine)
[![types](https://img.shields.io/npm/types/fabricjs-document-engine.svg)](https://www.npmjs.com/package/fabricjs-document-engine)
[![license](https://img.shields.io/npm/l/fabricjs-document-engine.svg)](https://github.com/re-sohail/fabricjs-document-engine/blob/main/LICENSE)

[Documentation](https://fabricjs-document-engine.jscrate.dev) · [Live demos](https://fabricjs-document-engine.jscrate.dev/#examples-heading) · [Editor tutorial](https://fabricjs-document-engine.jscrate.dev/docs/overview/tutorial) · [API](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/api.md) · [中文](https://github.com/re-sohail/fabricjs-document-engine/blob/main/README.zh-CN.md)

You keep your own canvas, toolbar and UI. This package sits beside them and turns what is on the canvas into a document you can save, reopen and keep editing. It works with Fabric 6 and 7, in React, Next.js, Vue, Svelte or plain JavaScript.

It also covers the jobs around the document: copy and paste, layer order, importing SVG files, and exporting images, SVG and PDF that look like the canvas.

## Why this exists

Anyone who has shipped a fabricjs editor has hit the same walls. Fabric.js serialization and drawing work well, but a document needs more than that:

- **There is no undo.** Fabric has no built-in history, so every team writes its own and loses object references on the way ([fabric.js#10011](https://github.com/fabricjs/fabric.js/issues/10011)).
- **Custom properties vanish.** `toJSON` and `loadFromJSON` drop fields Fabric does not know about, unless you list them on every call ([fabric.js#10887](https://github.com/fabricjs/fabric.js/issues/10887)).
- **Objects cannot be found again.** After loading, you cannot get an object by id, because Fabric gives objects no stable id. Group children have none at all.
- **Saves race each other.** An older request can finish last and overwrite newer edits, or a second tab can save over the first.
- **Export stops at the canvas.** There is no PDF export ([fabric.js#5906](https://github.com/fabricjs/fabric.js/issues/5906)), curved text exports to SVG in the wrong place ([fabric.js#6958](https://github.com/fabricjs/fabric.js/issues/6958)), and an exported SVG shows empty boxes once its image links stop working ([fabric.js#1980](https://github.com/fabricjs/fabric.js/issues/1980)).

This package handles those problems and the ones behind them: missing images, fonts that fail to load, crashed tabs, old file formats, large documents that freeze the page, and SVG files that land in the wrong place when imported.

## Install

Install from npm, together with Fabric:

```bash
npm install fabricjs-document-engine fabric
```

The package is written in TypeScript and ships its own types. It has no runtime dependencies. `fabric` is a peer dependency, React is needed only for the hooks, and `jspdf` and `svg2pdf.js` only for PDF export.

## Quick start

Save a Fabric.js canvas as JSON, then load it back:

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

That is the whole setup for a first test. localStorage is fine here; in a real app you pass a storage adapter and let autosave do the work, as shown below. The [quick start guide](https://fabricjs-document-engine.jscrate.dev/docs/overview/quick-start) walks through it step by step.

## What it handles

- **Stable object ids.** Every object, including children of groups, gets an id that survives moving, styling, grouping, saving and reopening. `engine.getObjectById(id)` finds it again.
- **A versioned document format.** It records the schema version, canvas size, background, object order and your own metadata.
- **Safe loading.** Documents are validated first. Unknown object types are refused before the canvas is touched. A missing image fails the load instead of silently disappearing. When loads overlap, the newest one wins.
- **Custom objects.** Register your own Fabric classes and the extra properties they need to keep.
- **Safe saving.** It tracks unsaved changes and can autosave. Only one save runs at a time, so a slow older save can never overwrite newer work. Revision checks catch another tab or device saving the same document, and failed saves are retried with backoff.
- **Your storage.** Plug in any backend with two functions, or use the built-in memory and localStorage adapters. No hosted service is needed.
- **Assets and fonts.** Documents record the images and fonts they need. When a document is opened, every image and font is checked first. You get the exact list of what is missing and why (not found, server error, CORS, timeout or a broken file), can offer replacements, and tab-only images are uploaded when you save.
- **Recovery.** Unsaved work is copied to IndexedDB while the user edits, and again at the moment the tab is closed or refreshed. After a crash or refresh you can offer to restore it, including images that only existed in the old tab.
- **Export.** PNG, JPEG, WebP, SVG, PDF and editable JSON. You choose the area, scale and background. A preflight check means an export either succeeds or tells you exactly which image or font prevents it.
- **SVG that matches the canvas.** Text on a path keeps its place, its background and its underline in the SVG. Images and fonts can be embedded, so the file opens in Illustrator or on another computer.
- **PDF with real text.** Pages in A4, Letter or the canvas size, with margins, several pages per file, and text that stays selectable. Only shadows, blend modes and similar effects become pictures.
- **SVG import.** SVG files open where their viewBox puts them, even with elements outside it, and scripts and outside links are removed first.
- **Rendering in bulk.** Thumbnails or exports for hundreds of saved documents in one tab, on a few reused canvases that are freed after each document.
- **Versions and migration.** Keep named versions, restore any of them as a new revision, and open plain Fabric JSON or documents saved by older versions of this package.
- **Large documents.** Objects are created in chunks so the page stays responsive. Loads report progress and can be cancelled with an `AbortSignal`, and a cancelled load leaves the canvas as it was.
- **Copy, paste and layers.** A clipboard that keeps group transforms and custom properties and gives every pasted object a new id, plus bring-to-front and send-to-back commands that keep a pinned background in place. Each is one undo step.
- **Undo and redo.** One user action is one undo step. Transactions group several code changes into one labelled step, and ids survive undo and redo.
- **React ready, framework free.** Hooks for React, and a small state store for any other framework.
- **Hardened.** Imported documents and SVG files are cleaned and size-limited, undo history has a memory budget, and every feature is tested on Fabric 6 and 7 in Chromium, Firefox and WebKit. Exports are checked pixel by pixel against the canvas.

## React, Next.js, Vue and Svelte

A Fabric.js React example with a toolbar that shows undo and save state:

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
- The React entry is marked `'use client'`. For Fabric.js in Next.js, render the editor in a client component loaded with a dynamic import that skips the server, because Fabric needs `window`. React is an optional peer dependency, and the core never imports it.

For other frameworks, `createDocumentStateStore(engine)` gives the same state as `{ getSnapshot, subscribe }`. It fits Svelte stores, Vue's `shallowRef` and similar tools.

Framework guides: [React](https://fabricjs-document-engine.jscrate.dev/docs/frameworks/react) · [Next.js](https://fabricjs-document-engine.jscrate.dev/docs/frameworks/next-js) · [Fabric.js with Vue 3](https://fabricjs-document-engine.jscrate.dev/docs/frameworks/vue) (keep the canvas out of deep reactivity with `toRaw`) · [Fabric.js with Svelte](https://fabricjs-document-engine.jscrate.dev/docs/frameworks/svelte) · [Plain JavaScript](https://fabricjs-document-engine.jscrate.dev/docs/frameworks/vanilla-js)

## Save and load from a database or API

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

## Load progress and cancelling

Large Fabric.js documents with thousands of objects can take a while to open. The engine creates objects 100 at a time and gives the page a turn between chunks, so the page stays responsive. Show progress, and let the user cancel:

```ts
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

await engine.load('big-floor-plan', {
  signal: controller.signal,
  onProgress: ({ stage, done, total }) => {
    // stage is 'prepare', 'images', 'objects' or 'done'
    progressBar.value = total > 0 ? done / total : 0;
    progressLabel.textContent = stage;
  },
});
```

Cancelling rejects with `LOAD_ABORTED` and leaves the canvas showing what it showed before. A failed load does the same: every object is created before the canvas is cleared. The `load:progress` event carries the same progress for code that is not the caller.

## Autosave and save conflicts

Fabric.js autosave is one option. The rest of this section is about what happens when saves go wrong, because that is where editors lose work.

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
- **Unsaved work is never replaced silently.** With a storage adapter, `load`, `loadDocument`, `importFabricJson` and `newDocument` refuse with `UNSAVED_CHANGES` while there are unsaved changes. Save first, or pass `{ discardUnsavedChanges: true }` when the user chose to throw the changes away.

### Warn before leaving

```ts
import { bindUnsavedChangesWarning } from 'fabricjs-document-engine';

const unbind = bindUnsavedChangesWarning(engine);
```

Full guides: [autosave](https://fabricjs-document-engine.jscrate.dev/docs/guides/autosave) and [save conflicts](https://fabricjs-document-engine.jscrate.dev/docs/guides/save-conflicts).

## Images, fonts and CORS

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
3. Images load six at a time (`maxConcurrentImages`), and each one has 30 seconds (`imageTimeout`). If any are missing, `replaceMissingImage` can supply a replacement URL for each one. Return `null` to leave it missing.
4. If images are still missing, loading fails with `MISSING_ASSETS`, and `error.missingAssets` lists each `{ url, objectIds, failure }`. The canvas is not touched.

`failure.reason` tells you why an image failed, so you can show the right message:

```ts
try {
  await engine.load('poster-42');
} catch (error) {
  if (isDocumentEngineError(error) && error.code === 'MISSING_ASSETS') {
    for (const { url, objectIds, failure } of error.missingAssets) {
      // NOT_FOUND, HTTP_ERROR, CORS, NETWORK, TIMEOUT, DECODE or ABORTED
      console.warn(failure?.reason, failure?.status, url, objectIds);
    }
  }
}
```

Browsers hide some details on purpose. When an image from another site fails without CORS headers, the reason is `CORS` if the image asked for `crossOrigin`, and `NETWORK` otherwise.

Fabric.js fonts that are not available produce a `FONT_UNAVAILABLE` warning, and the text uses a fallback font. Set `requireFonts: true` to fail with `MISSING_FONTS` instead. Warnings are also delivered with `load:success` as `{ document, warnings }`.

### When a document is saved

Images that exist only in this tab (`blob:` URLs) and embedded `data:` images are passed to `upload` once, and the document stores the returned URL. Without an `upload` handler, `blob:` images produce an `ASSET_NOT_PORTABLE` warning, because another device cannot open them.

### Cross-origin images

A Fabric.js CORS image problem is the most common reason an export fails. An image from another site without `crossOrigin: 'anonymous'` taints the canvas, and exporting it will fail. The engine warns with `IMAGE_CROSS_ORIGIN` so you can fix it before the user tries to export.

### Checking and replacing at any time

```ts
const report = await engine.checkAssets();
report.missingImages;
report.unavailableFonts;
report.warnings;

await engine.replaceImage('/old-logo.png', '/new-logo.png');
```

`replaceImage` swaps every image that uses a URL. Each image keeps its size on the page, and the change is one undo step. `engine.getAssetManifest()` returns the manifest for the current canvas.

## Export an image, SVG or JSON

Fabric.js export to PNG, JPEG, WebP or SVG goes through one call. The result is a `Blob` you can download or upload.

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
| `svg` | `{ textOnPath?, embedImages?, maxEmbeddedImageBytes?, embedFonts? }` for SVG exports | |

- The current zoom and pan do not matter. Exports always use document coordinates, and the view is restored afterwards.
- A JPEG has no transparency, so an empty or transparent background becomes white instead of black.
- The export never changes the canvas, the history or the unsaved state.
- A JSON export is the same portable document a save produces, including uploaded images when `assets.upload` is set.
- For PDF, see [Export a PDF](#export-a-pdf) below.

### SVG that opens anywhere

A Fabric.js SVG export links to images by URL. Open the file in Illustrator, on another computer or after a signed URL expires, and the images are empty boxes. Embed them, and the fonts too:

```ts
const result = await engine.export({
  format: 'svg',
  svg: {
    embedImages: true, // or 'require' to block the export when one cannot be embedded
    embedFonts: { 'Brand Sans': '/fonts/brand-sans.woff2' },
  },
});
```

An image from another site that does not allow CORS cannot be read by the page. With `embedImages: true` it stays a link and you get an `IMAGE_NOT_EMBEDDED` warning that names the objects. Fonts can be a URL or the file's bytes, and fonts set on single letters are embedded too.

### Curved text in SVG

Fabric.js text on a path (`text.path`) does not export to SVG the way it looks on the canvas: `pathAlign` is ignored, raised letters move the wrong way, and text backgrounds and underlines are drawn straight. When the text contains a space, Fabric 6 and 7 even write invalid XML that browsers and Illustrator refuse to open.

SVG exports write each letter where the canvas draws it, with its background and underline in the same place, so curved text looks the same in the SVG. Every SVG reader understands the output, and it stays editable text. Pass `svg: { textOnPath: 'fabric' }` to keep Fabric's own output instead.

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

## Export a PDF

Fabric.js has no PDF export, and the usual recipe, a screenshot pasted into jsPDF, gives blurry pages with no selectable text. `exportPdf` draws the canvas as real PDF vectors and text instead. Install the two optional libraries first:

```bash
npm install jspdf svg2pdf.js
```

```ts
import { downloadExport } from 'fabricjs-document-engine';
import { exportPdf } from 'fabricjs-document-engine/pdf';

const { blob, warnings } = await exportPdf(engine, {
  page: 'A4',      // 'A3', 'A5', 'Letter', 'Legal', 'Tabloid', 'canvas' or [width, height] in points
  margin: 36,      // half an inch
  fonts: [
    { family: 'Inter', source: '/fonts/Inter-Regular.ttf' },
    { family: 'Inter', source: '/fonts/Inter-Bold.ttf', weight: 'bold' },
  ],
  metadata: { title: 'Spring poster' },
});
downloadExport({ blob, format: 'pdf' }, 'poster.pdf');
```

- **Text stays text.** Text in the fonts you pass, and in Arial, Helvetica, Times and Courier, can be selected and searched in the PDF. Fonts must be TrueType (.ttf) files, which most font sites offer next to the web formats.
- **Hybrid by default.** Everything is drawn as vectors, except what PDF vectors cannot show: shadows, blend modes, gradient outlines, outlines that keep their width while scaled, and text in a font with no file. Each of those is drawn as a 300 dpi picture of just that object, in its place, and `warnings` names it. Use `mode: 'vector'` for vectors only, or `mode: 'raster'` for one picture per page.
- **Curved text and underlines** come out as on the canvas, using the same fixes as the SVG export.
- **Several pages.** Pass an array of engines, Fabric canvases or saved documents to get one page each. Saved documents are drawn on an off-screen canvas that is freed after its page.

## Render many documents

Making thumbnails or PDFs for hundreds of saved designs in one browser tab runs out of memory with a canvas per design, because browsers free canvas memory late. `renderDocuments` reuses a few off-screen canvases and frees every object and cache canvas after each document:

```ts
import { renderDocuments } from 'fabricjs-document-engine';

for await (const { documentId, result, error } of renderDocuments(savedDocuments, { format: 'png', scale: 0.5, concurrency: 2 })) {
  if (result) await uploadThumbnail(documentId, result.blob);
  else console.warn(documentId, error?.message);
}
```

Results arrive as each document finishes, so they can be uploaded one by one. A broken document reports its own `error` and the rest still render. `documents` can be an async iterable, such as pages of a database query, and a `signal` stops the batch.

## Import an SVG file

Fabric's usual SVG import, `loadSVGFromString` with `util.groupSVGElements`, sizes the group to what is drawn. An element outside the SVG's viewBox, or a hidden one, then moves and resizes the whole artwork. `importSvg` keeps the SVG's own frame:

```ts
const { objects, viewport, warnings } = await engine.importSvg(svgText, {
  left: 40,
  top: 40,
  fit: { width: 300, height: 200 }, // optional: scale into a box
  offscreen: 'clip',                 // or 'keep' (default) or 'drop'
});
```

- Elements land where the SVG puts them, after `viewBox` and `preserveAspectRatio`.
- The result is one group with a fixed layout the size of the viewport, or separate objects with `as: 'objects'`. Either way it is one undo step, and every object gets an id.
- Scripts, event handlers, `foreignObject`, links to other files and image addresses that `limits.isAllowedUrl` refuses are removed, and `warnings` says what was removed.
- Size limits apply as for documents, so a huge or deeply nested SVG is refused with `UNSAFE_DOCUMENT`.

## Version history

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

## Load from JSON and migrate from Fabric 5

Plain Fabric JSON, such as the output of `canvas.toJSON()` from Fabric 5, 6 or 7, opens directly:

```ts
await engine.importFabricJson(savedJsonText, { id: 'plan-42', metadata: { source: 'old editor' } });
```

`loadDocument` and `load(id)` also recognise plain Fabric JSON, so projects stored by an existing Fabric app open without a separate import step. A document loaded with `load(id)` keeps that id, and its next save stores it in the current format.

Every document records its `schemaVersion`, which makes Fabric.js migration a one-way, step-by-step upgrade. When the package format changes, older documents are upgraded when they are opened. `load:success` reports `migratedFrom` when that happened. A failed step rejects with `MIGRATION_FAILED`, and `error.migrationFrom` names the version it started from. A document from a newer version of the package is refused with `UNSUPPORTED_SCHEMA` rather than being misread. `migrateDocument(value, context)` and `detectSchemaVersion(value)` are exported for tooling such as server-side batch upgrades.

## Recover unsaved work

Fabric.js IndexedDB recovery runs in the background while the user edits:

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

## Custom objects and properties

A Fabric.js custom object keeps its extra fields only if something lists them at save time. Register the class once and its properties survive every save, load, undo and redo:

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

## Fabric.js undo and redo

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
- To group objects or ungroup them, do the remove and the add inside one transaction, and they take one undo step. Grouping is an ordinary change to the object list.
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

The [undo and redo guide](https://fabricjs-document-engine.jscrate.dev/docs/guides/undo-redo) has a live demo and covers text editing in more detail.

## Copy, paste and layer order

Copy and paste in Fabric.js usually means `object.clone()`, which copies the id and can place objects from a moved selection or a group in the wrong spot. The clipboard copies objects where they really are on the canvas, keeps custom properties, and gives every pasted object, group child and clip path a new id:

```ts
import { createClipboard } from 'fabricjs-document-engine';

const clipboard = createClipboard(engine);

clipboard.copy();           // the selection, or pass objects
await clipboard.paste();    // one undo step, 10 units further each time
clipboard.cut();            // one undo step; the next paste lands in place
await clipboard.paste({ target: otherEngine });

// Share between tabs through the system clipboard
await navigator.clipboard.writeText(JSON.stringify(clipboard.read()));
clipboard.write(JSON.parse(await navigator.clipboard.readText()));
```

Content passed to `write` is checked like a loaded document, so pasted JSON cannot carry unsafe image addresses.

Layer commands move objects, or the selection, and record one undo step. Several selected objects keep their order. A pinned object, such as a background, never moves:

```ts
import { bringForward, bringToFront, getLayers, sendBackward, sendToBack } from 'fabricjs-document-engine';

const keepBackground = { pinned: (object) => object.name === 'background' };

bringToFront(engine);
sendToBack(engine, undefined, keepBackground);   // stops just above the background
bringForward(engine, [logo]);

getLayers(engine); // [{ id, type, name, index, visible, locked }], top first
```

The engine saves each object's `name`, so a layers panel keeps its labels. In React, `useLayers(engine)` from `fabricjs-document-engine/react` returns the same list and updates on every change.

## Edits that are never lost

These guarantees hold however the user and your code interleave work:

```ts
// Page settings are one undo step and count as unsaved work
engine.setPage({ width: 1080, height: 1080, background: '#fff8e7' }, 'Square post');

// All or nothing: a failure leaves the canvas as it was
await engine.transaction('Apply template', async () => {
  await addTemplateObjects(engine.canvas);
}, { rollback: true });

// A load refuses to overwrite edits made while it ran
try {
  await engine.load('poster-42');
} catch (error) {
  if (isDocumentEngineError(error) && error.code === 'LOAD_CONFLICT') askBeforeReplacing();
}
```

- **The whole page is saved.** Background images, overlays and a mask on the canvas (`canvas.backgroundImage`, `overlayImage`, `clipPath`) are saved, reopened, checked for missing images and kept in versions and recovery copies.
- **Page changes are undoable.** `setPage` changes the size, background, overlay or mask as one undo step, and changes made to the canvas inside a `transaction` count too.
- **Typing counts at once.** Each keystroke marks the document unsaved and feeds autosave and recovery, while the whole edit stays one undo step.
- **Loads keep edits.** If the canvas is edited while a document loads, the load stops with `LOAD_CONFLICT` and the edits stay, unless you pass `discardUnsavedChanges: true`.
- **Async work stays in its document.** An SVG import, image replacement or paste that finishes after another document was opened is dropped with `DOCUMENT_CHANGED`, instead of landing in the wrong document.
- **Each tab has its own recovery copy.** Two tabs editing the same document no longer overwrite each other's copy, and a save removes only the copy it covers.
- **Sizes are checked before drawing.** Pages, exports and images over the browser's canvas limits are refused before any canvas is made, so a huge file cannot crash the tab. Limits are set with `limits`.
- **Rollback when you want it.** `transaction(label, work, { rollback: true })` undoes everything `work` changed when it fails.

## Document format

```ts
interface FabricDocument {
  schemaVersion: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  revision?: number;
  fabricVersion?: string;
  canvas: {
    width: number;
    height: number;
    background?: unknown;       // color, gradient or pattern
    backgroundImage?: object;   // Fabric image behind every object
    overlay?: unknown;          // color drawn over every object
    overlayImage?: object;      // Fabric image over every object
    clipPath?: object;          // mask for the whole canvas
  };
  objects: SerializedFabricObject[];
  assets?: {
    images: Array<{ url: string; objectIds: string[] }>;
    fonts: Array<{ family: string; weight: string; style: string; objectIds: string[] }>;
  };
  metadata: Record<string, unknown>;
}
```

Keep project data such as titles, owners and tags in `metadata` with `engine.updateMetadata()`, rather than on Fabric objects.

The format is described by a JSON Schema that ships with the package:

```ts
import schema from 'fabricjs-document-engine/schema/document-v1.json';
```

## Where it fits

Use it when you are building a Fabric.js canvas editor: a design editor, an image editor, a floor planner, a label or certificate builder. Fabric still does the drawing, selection and serialization. This package adds the document layer on top: ids, history, saving, loading, assets, recovery, copy and paste, layer order, SVG import, and image, SVG and PDF export.

If you are comparing a canvas editor JS library or an undo redo JavaScript library, note the scope. It does not draw a toolbar, and it does not do real-time collaboration. The [comparison page](https://fabricjs-document-engine.jscrate.dev/docs/overview/comparison) sets it next to `fabric-history`, `fabricjs-react` and hand-written `toJSON`.

## Compatibility

| | Supported |
| --- | --- |
| Fabric | Fabric.js 6 and Fabric.js 7 (peer `^6.0.0 \|\| ^7.0.0`); plain JSON from Fabric 5 opens through migration |
| Browsers | Full suite passes in Chromium, Firefox and WebKit |
| React | 18 and 19, optional |
| Node | 18 or later, for server-side import, validation and migration. PDF export and `renderDocuments` need a browser |
| PDF | Optional peers `jspdf` 4 and `svg2pdf.js` 2.7 or later, only for `fabricjs-document-engine/pdf` |
| Modules | ESM and CommonJS, with TypeScript types |

Tested versions and performance numbers (5,000 objects, every step under 50 ms except load) are in [docs/compatibility.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/compatibility.md).

## API reference

Every function, option, event and error code is listed in [docs/api.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/api.md). Every failure is a `DocumentEngineError` with a stable `code` you can switch on, such as `SAVE_CONFLICT`, `MISSING_ASSETS` or `UNSAVED_CHANGES`. A failed load never clears or half-fills your canvas.

## Stability

Version 1.0 freezes the document format and the adapter contracts:

- Documents are validated by the published JSON Schema at `fabricjs-document-engine/schema/document-v1.json`. Every 1.x release reads every document written by earlier releases, as well as plain Fabric JSON from Fabric 5, 6 and 7.
- Public API names, options, events and error codes do not change within 1.x. New ones may be added.
- Storage, version and recovery adapters written for 1.0 keep working. `verifyStorageAdapter(storage)` from `fabricjs-document-engine/storage` checks that your adapter follows the save rules.

The full promise is in the [compatibility policy](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/compatibility-policy.md). A complete setup is in the [production guide](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/production.md).

## Imported content and limits

Documents often come from users, so the engine treats them as untrusted:

- Keys named `__proto__`, `constructor` or `prototype` are removed before Fabric sees them. Fabric copies every key onto the object it creates, so these keys could otherwise change an object's prototype.
- Image addresses are checked after `assets.resolveUrl`, before anything is fetched. `http:`, `https:`, `blob:`, relative addresses and `data:image/...` are allowed. `javascript:`, `file:` and non-image `data:` addresses are refused with `UNSAFE_DOCUMENT`.
- A document with more than 50,000 objects, or nested more than 100 levels deep, is refused before loading, so a hostile file cannot freeze the tab.
- SVG files passed to `importSvg` lose scripts, event handlers, `foreignObject` and links to other files before Fabric parses them, and the same size limits apply.
- JSON written into the clipboard with `clipboard.write` is checked like a document, so pasted content cannot bring in unsafe image addresses.

```ts
createDocumentEngine({
  canvas,
  limits: {
    maxObjects: 10_000,
    maxDepth: 40,
    isAllowedUrl: (url) => url.startsWith('https://cdn.example.com/'),
  },
  history: { limit: 100, maxBytes: 32 * 1024 * 1024 },
});
```

`history.maxBytes` caps the memory undo history uses. The default is 64 MB, and the oldest steps are dropped first. SVG export escapes text, so text such as `<script>` inside a text box stays text.

Accessibility guidance for your toolbar, status text and dialogs is in [docs/accessibility.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/accessibility.md).

## Troubleshooting

Common problems and fixes are in [docs/troubleshooting.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/troubleshooting.md). Questions people ask most, such as why `loadFromJSON` loses custom properties, are answered in the [FAQ](https://fabricjs-document-engine.jscrate.dev/docs/overview/faq).

## Help and contributing

- Documentation and live Fabric.js examples: [fabricjs-document-engine.jscrate.dev](https://fabricjs-document-engine.jscrate.dev)
- Bugs and feature requests: [GitHub issues](https://github.com/re-sohail/fabricjs-document-engine/issues)
- Release notes: [CHANGELOG.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/CHANGELOG.md)

Maintained by [Sohail Khan](https://me.jscrate.dev). Pull requests are welcome. Every user-facing change needs a changeset (`npx changeset`).

## License

MIT
