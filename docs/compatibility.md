# Compatibility and performance

These results come from version 0.8.0. Every release runs the same suite before publishing.

## Compatibility

| | Chromium | Firefox | WebKit (Safari engine) | Node (server import) |
| --- | --- | --- | --- | --- |
| Fabric 7.4 | Full suite passes | Full suite passes | Full suite passes | Imports, validation and migration pass |
| Fabric 6.9 | Full suite passes | Not run separately | Not run separately | Imports, validation and migration pass |

- The browser suite covers every feature: ids, save and load, history, safe saving, assets and fonts, recovery with IndexedDB, export, versions and migration, the React adapter, cancellation, custom objects and imported-content safety.
- Fabric 6 differs from Fabric 7 in its default origin. Documents always store `originX` and `originY`, so a document saved with one opens correctly with the other.
- Plain Fabric JSON from Fabric 5 opens through the migration step. Fabric 6 and 7 still accept Fabric 5's legacy type names.
- **WebKit note.** WebKit cannot store `Blob` values in IndexedDB, so recovery copies keep image data as bytes and turn it back into a `Blob` when read.
- React 18 and 19 are supported through `fabricjs-document-engine/react`. The core never imports React.
- `fabricjs-document-engine/filters` runs filters in a module worker with `OffscreenCanvas` (Chrome 80, Firefox 114, Safari 16.4 and later). Elsewhere, and from the CommonJS build, filters run in steps on the main thread.
- `ShapedIText` and `ShapedTextbox` use the browser's own shaping through `measureText`, so results follow the fonts installed.

## Performance targets

These are measured with 5,000 objects: 60% rectangles, 20% circles, 10% text boxes and 10% groups.

| Step | Target | Worst measured |
| --- | --- | --- |
| Recording one undo step after a move | 50 ms | 27 ms (Firefox) |
| A transaction restyling one object | 50 ms | 29 ms (Firefox) |
| Undo one step | 50 ms | 28 ms (Firefox) |
| Save (serialize and store in memory) | 50 ms | 29 ms (Firefox) |
| Load a document | 1,000 ms | 828 ms (Firefox) |
| Engine checks before export | 50 ms | 22 ms (Firefox) |

Export time is almost all Fabric's own rendering plus the browser's image encoder, shown as "Fabric alone" below. The engine adds its preflight check on top.

A regression test runs 2,000 objects in every browser project with generous budgets, so large slowdowns fail the build.

## Dirty-region rendering

The median time of one frame while dragging one rectangle on a 1,200 × 800 canvas, measured in the test browsers (headless, software drawing), version 1.3.0:

| Objects | Chromium: Fabric / dirty regions | Firefox: Fabric / dirty regions | WebKit: Fabric / dirty regions |
| --- | --- | --- | --- |
| 1,000 | 178 ms / 0.4 ms | 151 ms / 1 ms | 1 ms / 0 ms |
| 5,000 | 987 ms / 1.7 ms | 814 ms / 2 ms | 10 ms / 3 ms |

With dirty regions, about 25 objects are drawn per frame instead of 5,000. The remaining time is the pass that compares every object with the last frame.

## Measurements

### Chromium

| Step | 1000 objects | 5000 objects |
| --- | --- | --- |
| add objects (incl. id indexing) | 56.0 ms | 162.2 ms |
| toDocument | 4.0 ms | 14.6 ms |
| record one move (object:modified) | 3.7 ms | 17.6 ms |
| transaction restyling one object | 3.6 ms | 18.6 ms |
| undo one step | 4.2 ms | 17.0 ms |
| save to memory storage | 4.9 ms | 20.4 ms |
| loadDocument | 65.7 ms | 325.1 ms |
| export preflight | 3.1 ms | 14.5 ms |
| Fabric alone: render to a new canvas | 253.4 ms | 1312.6 ms |
| export PNG | 436.5 ms | 2074.7 ms |
| export SVG | 15.4 ms | 69.3 ms |

### Firefox

| Step | 1000 objects | 5000 objects |
| --- | --- | --- |
| add objects (incl. id indexing) | 61.0 ms | 229.0 ms |
| toDocument | 10.0 ms | 22.0 ms |
| record one move (object:modified) | 7.0 ms | 27.0 ms |
| transaction restyling one object | 4.0 ms | 29.0 ms |
| undo one step | 7.0 ms | 28.0 ms |
| save to memory storage | 7.0 ms | 29.0 ms |
| loadDocument | 240.0 ms | 828.0 ms |
| export preflight | 6.0 ms | 22.0 ms |
| Fabric alone: render to a new canvas | 252.0 ms | 1192.0 ms |
| export PNG | 356.0 ms | 1965.0 ms |
| export SVG | 21.0 ms | 65.0 ms |

### WebKit (Safari engine)

| Step | 1000 objects | 5000 objects |
| --- | --- | --- |
| add objects (incl. id indexing) | 58.0 ms | 149.0 ms |
| toDocument | 5.0 ms | 19.0 ms |
| record one move (object:modified) | 11.0 ms | 21.0 ms |
| transaction restyling one object | 4.0 ms | 20.0 ms |
| undo one step | 6.0 ms | 20.0 ms |
| save to memory storage | 8.0 ms | 22.0 ms |
| loadDocument | 63.0 ms | 265.0 ms |
| export preflight | 5.0 ms | 21.0 ms |
| Fabric alone: render to a new canvas | 162.0 ms | 842.0 ms |
| export PNG | 45.0 ms | 2415.0 ms |
| export SVG | 19.0 ms | 81.0 ms |

Measured on an Apple Silicon Mac with headless Playwright browsers, with the canvas at 2000×1100. To reproduce, run `node run-benchmark.mjs chromium|firefox|webkit` from the playground.

## Memory

- Undo history keeps at most `history.limit` steps (100) and `history.maxBytes` of saved object data (64 MB). The oldest steps are dropped first, and the newest step is always kept.
- Each history step stores only the objects that changed, plus the object order when it changed.
- Recovery keeps one copy per document. It is removed once a save covers every change.
- Imported documents are limited to `limits.maxObjects` objects (50,000) and `limits.maxDepth` levels of nesting (100).
- Loading creates objects 100 at a time and gives the page a turn between chunks. Images are checked six at a time, each for at most 30 seconds.
- `renderDocuments` keeps `concurrency` off-screen canvases (2) and frees each document's objects, Fabric cache canvases and export canvases after it.

## Size limits

Every page, raster export and decoded image is checked against `limits` before a canvas is created: 16,384 pixels per side and 67,108,864 pixels in all by default. That is the area iOS 18 Safari can draw (older iOS: 16,777,216; Chrome: 268,435,456; Firefox: 472,907,776). PDF pages and pictures in a PDF are drawn at a lower resolution instead of failing.

## Fabric behaviour the engine works around

These were reproduced on Fabric 6.9.1 and 7.4.0, and the tests guard each workaround. If a later Fabric release fixes one, the workaround can be removed.

| Problem in Fabric | Fabric issue | What the engine does |
| --- | --- | --- |
| A failed image load gives no reason | [#11074](https://github.com/fabricjs/fabric.js/issues/11074) | Each missing image has a `failure` with a reason and status. |
| Large documents block the page while they load | [#9632](https://github.com/fabricjs/fabric.js/issues/9632) | Objects are created in chunks, with progress and cancelling. |
| Cloned groups and selections land in the wrong place, and keep their ids | [#2974](https://github.com/fabricjs/fabric.js/issues/2974) | `createClipboard` copies real positions and gives fresh ids. |
| Groups saved on one version shift on the other | [#11016](https://github.com/fabricjs/fabric.js/issues/11016) | Not reproduced through the engine, which saves `originX` and `originY` on every object. Fixtures from both versions guard it. |
| Text on a path in SVG ignores `pathAlign`, moves `deltaY` the wrong way and draws backgrounds and underlines straight | [#6958](https://github.com/fabricjs/fabric.js/issues/6958) | SVG export writes each letter as the canvas draws it. |
| Text on a path with a space is written as invalid XML (`rotate="..."style=`) | | Every SVG export repairs it. |
| A cached group clips text on a path that rises above the path's box, on the canvas | | Documented; set `objectCaching: false` on such groups. The SVG and PDF show the whole text. |
| SVG exports link to images by URL | [#1980](https://github.com/fabricjs/fabric.js/issues/1980) | `svg.embedImages` puts them in the file. |
| `@font-face` export skips fonts set on single letters | | `svg.embedFonts` embeds them. |
| `util.groupSVGElements` moves SVG artwork when elements lie outside the viewBox | [#10916](https://github.com/fabricjs/fabric.js/issues/10916) | `importSvg` keeps the SVG's viewport. |
| No PDF export | [#5906](https://github.com/fabricjs/fabric.js/issues/5906) | `fabricjs-document-engine/pdf`. |
| `dispose()` does not free canvas memory in browsers | [#4848](https://github.com/fabricjs/fabric.js/issues/4848) | `renderDocuments` and exports release canvas pixels themselves. |
| Inverted clip paths are written to SVG as ordinary clip paths | [#10460](https://github.com/fabricjs/fabric.js/issues/10460) | SVG export writes them as masks. |
| A clip path with its own clip path makes `toSVG()` throw (Fabric 7) or write `url(#undefined)` (Fabric 6) | [#10460](https://github.com/fabricjs/fabric.js/issues/10460) | The object is drawn as a picture, with `CLIP_PATH_RASTERIZED`. |
| Overlines and other decorations of ordinary text land away from the canvas in SVG; Fabric 6 shifts raised letters twice | [#10645](https://github.com/fabricjs/fabric.js/issues/10645) | SVG export draws decorations as shapes where the canvas does. |
