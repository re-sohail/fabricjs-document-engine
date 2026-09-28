# Production setup

This guide puts every feature together the way a real editor uses them.

## The engine

```ts
import { createDocumentEngine, bindKeyboardShortcuts, bindUnsavedChangesWarning } from 'fabricjs-document-engine';
import { createIndexedDbRecovery } from 'fabricjs-document-engine/recovery';
import { restStorage } from './rest-storage';

export function createEditor(canvas: Canvas) {
  const engine = createDocumentEngine({
    canvas,
    storage: restStorage,
    customObjects: [{ fabricClass: Sticker, properties: ['label'] }],
    autosave: { delay: 1500, maxWait: 15000 },
    saveRetry: { attempts: 4, baseDelay: 800, maxDelay: 10000 },
    recovery: { store: createIndexedDbRecovery(), interval: 3000 },
    versions: { autoEvery: 20, keepAuto: 30 },
    history: { limit: 150, maxBytes: 48 * 1024 * 1024 },
    limits: { maxObjects: 20000, isAllowedUrl: (url) => url.startsWith('https://cdn.example.com/') || url.startsWith('blob:') },
    assets: {
      resolveUrl: (url) => signCdnUrl(url),
      upload: async ({ blob }) => uploadToBucket(blob),
      loadFont: async ({ family, weight, style }) => {
        const face = new FontFace(family, `url(https://cdn.example.com/fonts/${family}-${weight}.woff2)`, { weight, style });
        document.fonts.add(await face.load());
      },
      replaceMissingImage: () => 'https://cdn.example.com/placeholders/missing.png',
    },
  });

  const unbindShortcuts = bindKeyboardShortcuts(engine);
  const unbindWarning = bindUnsavedChangesWarning(engine);
  return {
    engine,
    dispose() {
      unbindShortcuts();
      unbindWarning();
      engine.destroy();
    },
  };
}
```

For the REST adapter, see [storage-examples.md](./storage-examples.md). Check your own adapter once in development:

```ts
import { verifyStorageAdapter } from 'fabricjs-document-engine/storage';

const report = await verifyStorageAdapter(restStorage);
if (!report.ok) console.table(report.checks);
```

## Opening a document

```ts
async function openDocument(engine: DocumentEngine, id: string) {
  const interrupted = await engine.getInterruptedLoad();
  if (interrupted?.documentId === id && !(await confirmUser('This document failed to open last time. Try again?'))) return;

  const copy = await engine.getRecovery(id);
  if (copy && (await confirmUser(`Restore unsaved work from ${new Date(copy.savedAt).toLocaleString()}?`))) {
    await engine.restoreRecovery(id, { discardUnsavedChanges: true });
    return;
  }
  if (copy) await engine.discardRecovery(id);

  try {
    await engine.load(id);
  } catch (error) {
    if (isDocumentEngineError(error) && error.code === 'UNSAVED_CHANGES') {
      await engine.save();
      await engine.load(id);
      return;
    }
    throw error;
  }
}
```

## Handling every error

```ts
engine.on('load:error', ({ error }) => {
  switch (error.code) {
    case 'LOAD_ABORTED':
      return;
    case 'MISSING_ASSETS':
      return showMissingImages(error.missingAssets);
    case 'UNKNOWN_OBJECT_TYPE':
      return showMessage(`This document needs a newer version of the editor (${error.unknownTypes.join(', ')}).`);
    case 'UNSUPPORTED_SCHEMA':
      return showMessage('This document was made with a newer version of the editor.');
    case 'UNSAFE_DOCUMENT':
      return showMessage('This file was blocked for safety reasons.');
    default:
      return showMessage(`The document could not be opened: ${error.message}`);
  }
});

engine.on('save:error', ({ error }) => {
  if (error.code === 'SAVE_CONFLICT') return askConflict();
  if (error.code !== 'SAVE_CANCELLED') showMessage('Saving failed. Your work is kept on this device.');
});

async function askConflict() {
  const choice = await chooseUser('Someone else saved this document.', ['Keep my version', 'Load their version']);
  if (choice === 'Keep my version') await engine.save({ overwrite: true });
  else await engine.load(engine.getDocumentInfo().id, { discardUnsavedChanges: true });
}

engine.on('recovery:error', ({ error }) => reportToMonitoring(error));
engine.on('version:error', ({ error }) => reportToMonitoring(error));
```

## Leaving the editor

```ts
async function closeEditor(editor: ReturnType<typeof createEditor>) {
  if (editor.engine.isDirty()) await editor.engine.save().catch(() => undefined);
  editor.dispose();
}
```

`destroy()` also writes a recovery copy of any unsaved work, so nothing is lost even when the save above fails.

## Next.js

```tsx
'use client';

import dynamic from 'next/dynamic';

export const Editor = dynamic(() => import('./EditorClient'), { ssr: false });
```

Inside `EditorClient`, create the Fabric canvas in an effect, then call `useDocumentEngine(canvas, options)` from `fabricjs-document-engine/react`.

## Server side

The document helpers work in Node without a canvas, so you can validate uploads before storing them:

```ts
import { migrateDocument, secureDocument, validateDocument } from 'fabricjs-document-engine';

export function acceptUpload(body: unknown) {
  const safe = secureDocument(body, { maxObjects: 20000 });
  const { document } = migrateDocument(safe, { canvasWidth: 1200, canvasHeight: 800 });
  const issues = validateDocument(document);
  if (issues.length > 0) throw new BadRequest(issues);
  return document;
}
```

## Checklist before going live

- [ ] `verifyStorageAdapter(yourStorage)` passes.
- [ ] The server compares revisions and the write in one step, as in [storage-examples.md](./storage-examples.md).
- [ ] Custom classes are registered everywhere documents are opened.
- [ ] Web fonts load through `assets.loadFont`.
- [ ] Images load with CORS and `crossOrigin: 'anonymous'`, so exports work.
- [ ] You have UI for `SAVE_CONFLICT`, `MISSING_ASSETS`, recovery offers and `UNSAVED_CHANGES`.
- [ ] Your toolbar follows the [accessibility guidance](./accessibility.md).
