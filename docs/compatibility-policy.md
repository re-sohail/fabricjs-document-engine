# Compatibility policy

From 1.0.0, `fabricjs-document-engine` follows semantic versioning. This page says exactly what that promises.

## What 1.x will never break

1. **The document format.** Every 1.x release writes schema version 1 documents that match [`schema/document-v1.schema.json`](../schema/document-v1.schema.json), and reads every document written by any earlier release.
2. **Opening older documents.** Documents from 0.x releases, and plain Fabric JSON from Fabric 5, 6 and 7, keep opening through migration. A reference document written by 1.0 and a Fabric 5 document are part of the test suite, and every release must load them with the same ids, types and positions.
3. **The public API** in [api.md](./api.md): function names, option names, return shapes, event names and payloads, and error codes. New options, events, fields and error codes may be added. Existing ones are not removed or renamed, and their meaning does not change.
4. **The adapter contracts.**
   - Storage: `loadDocument`, and `saveDocument(document, { expectedRevision, signal })`, with the revision rules checked by `verifyStorageAdapter`.
   - Versions: `saveVersion`, `listVersions`, `loadVersion`, `deleteVersion`.
   - Recovery stores: `get`, `set`, `delete`, `keys`, and the optional `setNow`.

   An adapter written for 1.0 keeps working in every 1.x release.
5. **Safety defaults.** Later releases may make the safety checks stricter only when an unsafe document would otherwise be loaded. They never block documents that 1.0 accepts as safe.

## What may change in a minor release

- New optional document fields. Readers must ignore fields they do not know. The JSON Schema allows extra fields for this reason.
- New features, options, events and error codes.
- Better error messages. Match on `error.code`, never on `error.message`.
- Performance improvements, and new browsers or Fabric versions added to the supported list.

## What needs a major release

- A new schema version. It will come with a migration from schema 1, and the reader for schema 1 documents stays for at least one more major version.
- Removing or renaming anything in the public API.
- Dropping a Fabric major version or a browser engine.

Deprecations are announced in the changelog at least one minor release before removal, and work unchanged until the next major release.

## Supported environments

| | Supported in 1.x |
| --- | --- |
| Fabric.js | 6.x and 7.x |
| Browsers | Current Chromium, Firefox and WebKit (Safari) releases, all tested on every release |
| React | 18 and 19, through `fabricjs-document-engine/react` |
| Node.js | 18 and later with Fabric 6, and 20 and later with Fabric 7, which needs Node 20 itself. Node covers importing, validation, migration, safety checks and storage adapters. The canvas-dependent parts need a browser. |

## Reporting a compatibility problem

Open an issue with the document that fails, with private content removed, the Fabric version, the browser and the error `code`. A document that 1.x wrote but cannot read back is treated as a data-loss bug and gets fixed first.
