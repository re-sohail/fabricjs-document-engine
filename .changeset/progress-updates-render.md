---
"fabricjs-document-engine": patch
---

Load progress now reaches the screen. Between chunks of objects the engine yielded with `scheduler.yield()`, which in Chromium resumes ahead of other queued work, so a React or Vue progress bar fed by `onProgress` only re-rendered once the load had finished, and a Cancel button enabled from progress could never be pressed. The engine now yields with a message-channel task, which lets queued work such as a framework's re-render run first, without the delay of `setTimeout`.
