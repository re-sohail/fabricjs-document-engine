# Storage examples

A storage adapter tells the engine how to read and write documents. It needs two functions. Versions add four more, which are optional.

```ts
interface DocumentStorage {
  loadDocument(id: string): Promise<unknown>;
  saveDocument(document: FabricDocument, context: { expectedRevision: number | null; signal: AbortSignal }): Promise<void | { revision?: number }>;
}
```

The rules that keep saving safe:

1. Reject a save when the stored revision is not `expectedRevision`. Throw an error with `code: 'SAVE_CONFLICT'`, or use `createConflictError`.
2. Skip that check when `expectedRevision` is `null`. The user chose to overwrite.
3. Throw an error with `retryable: false` when trying again cannot help, such as for a permission or validation error.
4. Pass `signal` on to `fetch` so a save can be cancelled when another document is opened.

## REST API

```ts
import type { DocumentStorage } from 'fabricjs-document-engine';

export const restStorage: DocumentStorage = {
  async loadDocument(id) {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}`);
    if (response.status === 404) throw Object.assign(new Error('Not found'), { code: 'DOCUMENT_NOT_FOUND' });
    if (!response.ok) throw new Error(`Loading failed with ${response.status}`);
    return response.json();
  },
  async saveDocument(document, { expectedRevision, signal }) {
    const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}`, {
      method: 'PUT',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'If-Match': expectedRevision === null ? '*' : String(expectedRevision),
      },
      body: JSON.stringify(document),
    });
    if (response.status === 409 || response.status === 412) {
      throw Object.assign(new Error('Someone else saved this document'), { code: 'SAVE_CONFLICT' });
    }
    if (response.status === 401 || response.status === 403 || response.status === 422) {
      throw Object.assign(new Error(`Save refused with ${response.status}`), { retryable: false });
    }
    if (!response.ok) throw new Error(`Save failed with ${response.status}`);
    const { revision } = (await response.json()) as { revision: number };
    return { revision };
  },
};
```

On the server, run the revision check and the write as one step. For example:

```sql
UPDATE documents
SET body = $1, revision = revision + 1
WHERE id = $2 AND ($3::int IS NULL OR revision = $3)
RETURNING revision;
```

If no row comes back, answer `409`.

## Any key-value store

`createKeyValueStorage` adds revision checks, document listing and versions on top of any synchronous key-value store:

```ts
import { createKeyValueStorage } from 'fabricjs-document-engine/storage';

const sessionStore = createKeyValueStorage(
  {
    read: (key) => sessionStorage.getItem(key),
    write: (key, value) => sessionStorage.setItem(key, value),
    remove: (key) => sessionStorage.removeItem(key),
    keys: () => Object.keys(sessionStorage),
  },
  'my-app:',
);
```

## Uploading images while saving

```ts
const engine = createDocumentEngine({
  canvas,
  storage: restStorage,
  assets: {
    upload: async ({ blob }) => {
      const body = new FormData();
      body.append('file', blob);
      const response = await fetch('/api/uploads', { method: 'POST', body });
      const { url } = (await response.json()) as { url: string };
      return url;
    },
  },
});
```

Each tab-only image is uploaded once. Later saves reuse the returned URL.

## Versions

To keep versions in your own backend, add these methods to the adapter:

```ts
saveVersion(version): Promise<void>;
listVersions(documentId): Promise<VersionSummary[]>;
loadVersion(documentId, versionId): Promise<DocumentVersion>;
deleteVersion(documentId, versionId): Promise<void>;
```

`listVersions` should return summaries without the `document` field, newest first.
