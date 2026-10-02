# Troubleshooting

## Undo does not notice my change

Fabric only fires events for pointer interaction, adding and removing objects, and text editing. Changes your code makes with `object.set(...)`, `canvas.bringObjectForward(...)` and similar calls fire nothing. Wrap them:

```ts
engine.transaction('Recolor', () => shape.set('fill', 'teal'));
```

or call `engine.commit('Recolor')` afterwards.

## My object reference stopped working after undo

Undo and redo rebuild the changed objects from their saved state, so they are new instances with the same ids. Keep ids rather than objects, and look them up with `engine.getObjectById(id)`.

## Loading fails with UNKNOWN_OBJECT_TYPE

The document contains a custom class that this page has not registered. Pass it in `customObjects` or call `engine.registerObject({ fabricClass, properties })` before loading. The class needs a static `type` that matches the saved `type`.

## My custom property is not saved

List it in `properties` when you register the class, for example `{ fabricClass: Sticker, properties: ['label'] }`. Only `id`, `name` and registered properties are added to what Fabric saves by default.

## Loading fails with MISSING_ASSETS

`error.missingAssets` lists every image that could not load, and which objects use it. You can:

- fix the URLs with `assets.resolveUrl`,
- offer replacements with `assets.replaceMissingImage`, or
- open the file, then call `engine.replaceImage(oldUrl, newUrl)` once you have the right image.

Each entry has a `failure` that says why it failed:

- `NOT_FOUND` or `HTTP_ERROR`: check `failure.status` and the URL on your server.
- `CORS`: the other site must send `Access-Control-Allow-Origin` for this page. Images that ask for `crossOrigin` cannot load without it.
- `NETWORK`: the address could not be reached. For another site without CORS headers, the browser hides the real reason, so open the URL directly to see it.
- `TIMEOUT`: raise `assets.imageTimeout` for slow servers, or lower `assets.maxConcurrentImages` when many large images compete.
- `DECODE`: the file is not an image the browser can read, for example an HTML error page served with status 200, or a format the browser does not support.

## Opening a large document freezes the page

Pass `onProgress` to show where the load is, and a `signal` so the user can cancel it. Objects are created in chunks, so the page stays responsive while they are made. If the page still pauses, the time is usually spent drawing: a canvas with thousands of objects takes a while to render once it is loaded, which is Fabric's work, not the load's. Turning off `objectCaching` for many small shapes, or splitting a huge drawing into pages, helps there.

## Groups move after reopening or ungrouping

Groups are tested to reopen with every object in the same place on Fabric 6 and 7, including documents saved on one version and opened on the other, and to stay in place when ungrouped afterwards (fabric.js issue #11016). If a group still moves:

- Check that it was saved with `engine.toDocument()` or `engine.save()`, not `canvas.toJSON()`. The engine writes `originX` and `originY` on every object, because Fabric 6 and 7 use different defaults, and plain Fabric JSON from version 6 opened on version 7 shifts by half of each object's size.
- Ungroup by removing the children from the group first, then removing the group and adding the children, all inside one `engine.transaction('Ungroup', ...)`. `group.removeAll()` returns children that keep their position on the canvas.

## Text looks different after reopening

The font was not loaded when the text was created, so Fabric measured it with a fallback font. Load web fonts in `assets.loadFont`. The engine waits for it before creating text. Watch for `FONT_UNAVAILABLE` warnings, or set `assets.requireFonts: true` to fail instead.

## Export fails with EXPORT_BLOCKED

Read `error.problems`:

- **CROSS_ORIGIN_IMAGE**: load the image with `crossOrigin: 'anonymous'` from a server that sends `Access-Control-Allow-Origin`. SVG and JSON exports are not affected.
- **MISSING_IMAGE**: the image did not load. Replace it with `engine.replaceImage`.
- **MISSING_FONT**: only with `requireFonts`. Load the font first.

Run `engine.preflightExport({ format })` to show these before the user clicks export.

## Curved text looks different in the SVG

SVG exports write text on a path the way the canvas draws it. If it still differs:

- The text is in a group with object caching on. Fabric sizes a group's cache to the path's box, so letters that rise above the curve are cut off on the canvas, while the SVG shows them. Set `objectCaching: false` on that group to see the whole text on the canvas too.
- The SVG is opened somewhere without the font. Pass the font in `svg.embedFonts`.
- `svg.textOnPath: 'fabric'` is set. That keeps Fabric's own output, which ignores `pathAlign` and draws text backgrounds and underlines straight.

## An SVG from Fabric does not open in Illustrator or the browser

Fabric 6 and 7 write text on a path that contains a space as `rotate="..."style="..."`, which is not valid XML. Exports through `engine.export({ format: 'svg' })` repair it. If you call `canvas.toSVG()` yourself, insert the missing space or export through the engine.

## Images are missing when the SVG is opened elsewhere

Fabric links to images by URL. Export with `svg: { embedImages: true }` to put them in the file. An image from another site that does not send CORS headers cannot be read by the page, so it stays a link with an `IMAGE_NOT_EMBEDDED` warning. Load it with `crossOrigin: 'anonymous'` from a server that allows CORS, or use `embedImages: 'require'` to stop the export instead.

## An imported SVG lands in the wrong place

`util.groupSVGElements` sizes the group to the drawn content, so elements outside the viewBox, or hidden ones, move everything. `engine.importSvg(svg)` keeps the SVG's viewport instead. Pass `offscreen: 'drop'` or `'clip'` to remove or hide what lies outside it.

## PDF export fails with PDF_UNAVAILABLE

Install the optional libraries with `npm install jspdf svg2pdf.js`. `mode: 'raster'` needs only `jspdf`. PDF export also needs a browser: in Node, render in a headless browser instead.

## Text in the PDF is a picture, or uses the wrong font

Pass a TrueType (.ttf) file for each family the canvas uses in `fonts`, with one entry per weight and style you use. Without a file, hybrid mode draws that text as a picture so it looks right, and `warnings` says so. Pass `missingFonts: 'substitute'` to keep it as text in the closest built-in font instead. The built-in PDF fonts have Latin-1 letters only, so text in other scripts always needs a font file that has those letters.

WOFF, WOFF2 and OpenType files with CFF outlines are refused with `PDF_FAILED`, because jsPDF reads TrueType only.

## Some objects in the PDF look slightly blurred

In hybrid mode, objects PDF vectors cannot draw, such as shadows and blend modes, are drawn as pictures. Raise `dpi` (default 300) for sharper pictures, or remove the shadow to keep the object as vectors. `warnings` lists each object drawn as a picture.

## Rendering many documents runs out of memory

Use `renderDocuments` rather than one canvas per document. It reuses a few canvases and frees each document's objects and cache canvases. Keep `concurrency` low (the default is 2), and upload each result as it arrives rather than collecting them all.

## Loading fails with LOAD_CONFLICT

The canvas was edited while the document loaded, for example by a click or by code that added objects. The load stopped so those edits are not lost. Ask the user, then load again with `{ discardUnsavedChanges: true }` to replace them, or disable editing while a load runs.

## An import, paste or image change fails with DOCUMENT_CHANGED

It was still running when another document was opened, so its result was dropped instead of landing in the wrong document. Run it again in the document that is open now.

## The background image or overlay is gone after reopening

Documents saved before 1.2 did not keep canvas-level images, overlays or masks. Save the document again with 1.2 or later; from then on `canvas.backgroundImage`, `overlayImage` and `clipPath` are kept.

## Two tabs show different recovery copies

Since 1.2 each tab keeps its own copy of unsaved work. `getRecoverableDocuments()` lists every copy with its `sessionId`, and `active` tells you whether that tab is still open. Restore one with `restoreRecovery(id, { sessionId })`, or discard one with `discardRecovery(id, sessionId)`.

## A large export or document is refused with TOO_LARGE or UNSAFE_DOCUMENT

The page, export or image is bigger than what browsers can draw (by default 16,384 pixels per side and 67 million pixels in all, the iOS 18 Safari limit). Lower the export `scale`, export a smaller `area`, or raise `limits.maxCanvasPixels` if you only target desktop browsers.

## A JPEG export has a black background

It should not. The engine uses white when the background is empty or transparent. If you still see black, you set `background` to a dark color.

## A Textbox grows wider than I set it

Fabric widens a Textbox to its longest word. Use `BoundedTextbox` from `fabricjs-document-engine/text`, which breaks long words between letters. Add `maxHeight` with `overflow` or `fit: 'shrink'` to keep the height too.

## The cursor is in the wrong place in Arabic or with ligatures

Fabric measures letters one by one but draws them joined. Use `ShapedIText` or `ShapedTextbox`, or `shaping: true` on a `BoundedTextbox`. Text with letter spacing or `justify` is drawn letter by letter and is already measured right.

## Typing on Android puts letters or styles in the wrong place

Call `attachMobileTextInput(canvas)` before editing starts. It reads each keyboard edit from the text, so autocorrect, suggestions and cursor swipes work.

## Styles move to the wrong letters when I change text in code

Setting `text` does not move styles. Use `createTextCommands(engine)` or `replaceTextRange`.

## An imported SVG lost its groups

Pass `preserveGroups: true` to `importSvg`. Group ids, classes and `data-*` attributes are on `svgId`, `svgClass` and `svgData`.

## Applying a filter freezes the page

Use `createFilterWorker()` from `fabricjs-document-engine/filters`. If `mode` is `'main-thread'`, the browser has no module workers or `OffscreenCanvas`, or the CommonJS build is in use; pass `createWorker` with your bundler's worker setup.

## Dragging is slow with many objects

Call `enableDirtyRegionRendering(canvas)` from `fabricjs-document-engine/performance`. If a custom object changes inside its own `_render` without changing any property, call `invalidate()` after the change.

## Saves fail with SAVE_CONFLICT

Another tab or device saved the same document after this one loaded it. Either reload with `engine.load(id)`, or keep this version with `engine.save({ overwrite: true })`. If conflicts happen in a single tab, make sure your adapter returns the new revision, or that it stores `document.revision`.

## The recovery prompt never appears after a refresh

- Pass `recovery: { store: createIndexedDbRecovery() }`.
- Copies are only written while there are unsaved changes. If autosave saved everything, there is nothing to recover, which is the good case.
- Private browsing modes may clear IndexedDB and localStorage when the window closes.

## Loading a document crashes the tab every time

On the next start, call `engine.getInterruptedLoad()`. If it returns the same document id, skip loading it automatically and offer to discard its recovery copy.

## React: two engines are created in development

React StrictMode mounts effects twice in development. `useDocumentEngine` destroys the first engine before creating the second, so only one stays alive. Always read the engine from the hook's return value.

## React: the toolbar does not update

Read state through `useDocumentState(engine)`, not from the engine directly during render. The hook re-renders on save status, history, loading and asset warnings.

## Next.js: "useState only works in client components"

Import hooks from `fabricjs-document-engine/react`. That entry is marked `'use client'`. Fabric needs a browser, so render your editor in a client component, or with `dynamic(() => import('./Editor'), { ssr: false })`.

## Two copies of Fabric in the bundle

Custom classes registered in one copy are unknown to the other, and loads fail with `UNKNOWN_OBJECT_TYPE`. Make sure only one `fabric` is installed. With a linked package in Vite, add `resolve: { dedupe: ['fabric'] }`.
