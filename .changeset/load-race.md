---
'fabricjs-document-engine': patch
---

`load(id)` now claims the load before it reads storage. Before, when storage answered out of order, an older `load` could replace a newer one that had already finished. The older call now rejects with `LOAD_ABORTED`.
