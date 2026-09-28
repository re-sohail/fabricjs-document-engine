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

List it in `properties` when you register the class, for example `{ fabricClass: Sticker, properties: ['label'] }`. Only `id` and registered properties are added to what Fabric saves by default.

## Loading fails with MISSING_ASSETS

`error.missingAssets` lists every image that could not load, and which objects use it. You can:

- fix the URLs with `assets.resolveUrl`,
- offer replacements with `assets.replaceMissingImage`, or
- open the file, then call `engine.replaceImage(oldUrl, newUrl)` once you have the right image.

## Text looks different after reopening

The font was not loaded when the text was created, so Fabric measured it with a fallback font. Load web fonts in `assets.loadFont`. The engine waits for it before creating text. Watch for `FONT_UNAVAILABLE` warnings, or set `assets.requireFonts: true` to fail instead.

## Export fails with EXPORT_BLOCKED

Read `error.problems`:

- **CROSS_ORIGIN_IMAGE**: load the image with `crossOrigin: 'anonymous'` from a server that sends `Access-Control-Allow-Origin`. SVG and JSON exports are not affected.
- **MISSING_IMAGE**: the image did not load. Replace it with `engine.replaceImage`.
- **MISSING_FONT**: only with `requireFonts`. Load the font first.

Run `engine.preflightExport({ format })` to show these before the user clicks export.

## A JPEG export has a black background

It should not. The engine uses white when the background is empty or transparent. If you still see black, you set `background` to a dark color.

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
