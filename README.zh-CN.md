# fabricjs-document-engine

为现有的 [Fabric.js](https://fabricjs.com) 画布提供保存、加载、撤销和重做。对象的 id 始终不变，慢的旧保存也不会覆盖新的改动。

[![npm version](https://img.shields.io/npm/v/fabricjs-document-engine.svg)](https://www.npmjs.com/package/fabricjs-document-engine)
[![bundle size](https://img.shields.io/bundlephobia/minzip/fabricjs-document-engine)](https://bundlephobia.com/package/fabricjs-document-engine)
[![types](https://img.shields.io/npm/types/fabricjs-document-engine.svg)](https://www.npmjs.com/package/fabricjs-document-engine)
[![license](https://img.shields.io/npm/l/fabricjs-document-engine.svg)](https://github.com/re-sohail/fabricjs-document-engine/blob/main/LICENSE)

[中文文档](https://fabricjs-document-engine.jscrate.dev/zh) · [在线示例](https://fabricjs-document-engine.jscrate.dev/zh#examples-heading) · [fabric.js 使用教程](https://fabricjs-document-engine.jscrate.dev/zh/docs/overview/tutorial) · [API](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/api.md) · [English](https://github.com/re-sohail/fabricjs-document-engine/blob/main/README.md)

画布、工具栏和界面都由你自己掌控。这个包在旁边工作，把画布上的内容变成一份可以保存、重新打开、继续编辑的文档。它支持 Fabric 6 和 7，可以用在 React、Next.js、Vue、Svelte 或原生 JavaScript 中。

## 为什么需要它

做过 fabricjs 编辑器的人，基本都踩过同样的坑。Fabric.js 的序列化和绘制都做得很好，但一份文档需要的不止这些：

- **没有撤销功能。** Fabric 没有内置历史记录，每个团队都得自己写撤销和重做（上一步/下一步），而且往往在这个过程中丢掉对象引用（[fabric.js#10011](https://github.com/fabricjs/fabric.js/issues/10011)）。
- **自定义属性会丢失。** `toJSON` 和 `loadFromJSON` 会丢掉 Fabric 不认识的字段，除非你每次调用都把它们列出来（[fabric.js#10887](https://github.com/fabricjs/fabric.js/issues/10887)）。
- **加载后找不到对象。** Fabric 不给对象分配稳定的 id，所以加载之后没法按 id 获取对象。编组里的子对象更是完全没有 id。
- **保存互相冲突。** 旧的请求可能最后才返回，覆盖掉新的改动；另一个标签页也可能覆盖这一个的保存。

这个包解决这四个问题，以及它们背后的问题：图片缺失、字体加载失败、标签页崩溃和旧的文件格式。

## 安装

从 npm 安装，同时安装 Fabric：

```bash
npm install fabricjs-document-engine fabric
```

这个包用 TypeScript 编写，自带类型定义。它没有运行时依赖。`fabric` 是 peer dependency，只有使用 hooks 时才需要 React。

## 快速开始

把 Fabric.js 画布保存为 JSON，再加载回来（回显）：

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

第一次试用，这些就够了。这里用 localStorage 没问题；在真实应用中，你会传入一个存储适配器，让自动保存来完成工作，下文会讲到。[快速开始指南](https://fabricjs-document-engine.jscrate.dev/zh/docs/overview/quick-start)会一步步带你完成。

## 它能做什么

- **稳定的对象 id。** 每个对象，包括编组里的子对象，都有一个 id，移动、改样式、编组、保存和重新打开后都不会变。`engine.getObjectById(id)` 可以再次找到它。
- **带版本号的文档格式。** 它记录 schema 版本、画布尺寸、背景、对象顺序和你自己的元数据。
- **安全加载。** 文档会先经过校验。未知的对象类型会在动画布之前被拒绝。图片缺失会让加载失败，而不是悄悄消失。多次加载重叠时，以最新的一次为准。
- **自定义对象。** 注册你自己的 Fabric 类，以及它们需要保留的额外属性。
- **安全保存。** 它会跟踪未保存的改动，也可以自动保存。同一时间只运行一次保存，所以慢的旧保存永远不会覆盖新的改动。修订号检查能发现另一个标签页或设备保存了同一份文档，失败的保存会按退避策略重试。
- **你自己的存储。** 用两个函数接入任意后端，或者使用内置的内存和 localStorage 适配器。不需要任何托管服务。
- **图片和字体。** 文档会记录它需要的图片和字体。打开文档时，会先检查每张图片和每种字体。你会拿到缺失内容的准确列表，可以提供替换，只存在于当前标签页的图片会在保存时上传。
- **恢复。** 用户编辑时，未保存的内容会被复制到 IndexedDB；关闭或刷新标签页的那一刻还会再复制一次。崩溃或刷新之后，你可以提示用户恢复，包括只存在于旧标签页中的图片。
- **导出。** 支持 PNG、JPEG、WebP、SVG 和可编辑的 JSON。区域、缩放和背景由你选择。导出前的预检意味着导出要么成功，要么准确告诉你是哪张图片或哪种字体导致失败。
- **版本和迁移。** 保存命名版本，把任意版本恢复为新的修订，还能打开纯 Fabric JSON 或旧版本这个包保存的文档。
- **撤销和重做。** 用户的一次操作就是一步撤销。事务可以把代码里的多处改动合成一个带标签的步骤，撤销和重做后 id 保持不变。
- **支持 React，不绑定框架。** 为 React 提供 hooks，为其他框架提供一个小的状态 store。
- **经过加固。** 导入的文档会被清理并限制大小，撤销历史有内存上限，每个功能都在 Chromium、Firefox 和 WebKit 中测试过。

## React、Next.js、Vue 和 Svelte

一个 Fabric.js React 示例，工具栏显示撤销和保存状态：

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

- `useDocumentEngine(canvas, options)` 在 Fabric 画布创建后创建引擎，并在组件卸载时销毁它。在那之前返回 `null`。选项只在创建引擎时读取。
- `useDocumentState(engine)` 返回 `{ documentId, isLoading, loadError, saveStatus, isDirty, isSaving, revision, lastSavedAt, saveError, canUndo, canRedo, undoLabel, redoLabel, assetWarnings }`，其中任意一项变化都会重新渲染。
- `useDocumentEvent(engine, 'save:error', handler)` 用最新的 handler 订阅任意事件。
- `DocumentEngineProvider` 和 `useEngine()` 把引擎传给嵌套很深的工具栏。
- React 入口标记了 `'use client'`。在 Next.js 中使用 Fabric.js 时，要在客户端组件中渲染编辑器，并用跳过服务端的动态导入加载它，因为 Fabric 需要 `window`。React 是可选的 peer dependency，核心代码从不导入它。

对于其他框架，`createDocumentStateStore(engine)` 以 `{ getSnapshot, subscribe }` 的形式提供同样的状态，适用于 Svelte store、Vue 的 `shallowRef` 等工具。

框架指南：[React](https://fabricjs-document-engine.jscrate.dev/zh/docs/frameworks/react) · [Next.js](https://fabricjs-document-engine.jscrate.dev/zh/docs/frameworks/next-js) · [Fabric.js 与 Vue 3](https://fabricjs-document-engine.jscrate.dev/zh/docs/frameworks/vue)（用 `toRaw` 让画布避开深层响应式） · [Fabric.js 与 Svelte](https://fabricjs-document-engine.jscrate.dev/zh/docs/frameworks/svelte) · [原生 JavaScript](https://fabricjs-document-engine.jscrate.dev/zh/docs/frameworks/vanilla-js)

## 保存到数据库或 API，并从中加载

内置适配器是最快的起步方式：

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

两个适配器都提供 `listDocuments()` 和 `deleteDocument(id)`。要基于其他键值存储构建，使用 `createKeyValueStorage({ read, write, remove, keys }, prefix)`。

更多适配器，包括带修订号检查和图片上传的 REST API，见 [docs/storage-examples.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/storage-examples.md)。

### 你自己的后端

一个存储适配器就是两个函数：

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

- `expectedRevision` 是这个编辑器上次保存或加载时的修订号。当存储中的文档修订号不同时，拒绝这次保存。用户选择覆盖时，它是 `null`。
- `document.revision` 是下一个修订号。如果你的后端自己分配编号，返回 `{ revision }`。
- 抛出带 `code: 'SAVE_CONFLICT'` 的错误，或使用 `createConflictError(id, expected, actual)`，来报告冲突。冲突永远不会重试。
- 对于重试也无法解决的失败，抛出带 `retryable: false` 的错误。其他错误都会重试。
- 把 `signal` 传给 `fetch`。打开另一份文档时，引擎会中止它。

## 自动保存和保存冲突

Fabric.js 自动保存只是一个选项。本节主要讲保存出错时会发生什么，因为编辑器正是在这里丢失内容的。

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

`status` 是 `saved`、`unsaved`、`saving`、`error` 或 `conflict` 之一。

- **未保存的改动。** 每一步记录下来的历史、撤销、重做和元数据修改，都会把文档标记为已修改。`engine.isDirty()` 告诉你是否有未保存的内容。保存进行时做的修改，会一直保持未保存状态，直到下一次保存。
- **自动保存。** 停止编辑 `delay` 毫秒后保存；即使用户一直在编辑，最迟也会在第一次未保存修改后的 `maxWait` 毫秒保存。`autosave: true` 使用上面示例中的默认值。
- **同一时间只有一次保存。** 保存进行中再调用 `save()`，只会排队一次后续保存，保存的是最新内容。响应永远不会乱序到达。
- **过期的响应。** 保存进行中如果加载了另一份文档，这次保存的响应会被忽略，排队中的保存会以 `SAVE_CANCELLED` 取消。
- **冲突。** 当另一个标签页或设备先保存时，保存会以 `SAVE_CONFLICT` 失败，状态变为 `conflict`。你可以用 `engine.load(id)` 重新加载文档，或者用 `engine.save({ overwrite: true })` 保留你的版本。
- **重试。** 临时失败会按指数退避加随机抖动重试。每次重试都会触发 `save:retry`，带有 `{ attempt, delay, error }`。
- **未保存的内容不会被悄悄替换。** 使用存储适配器时，只要有未保存的改动，`load`、`loadDocument`、`importFabricJson` 和 `newDocument` 都会以 `UNSAVED_CHANGES` 拒绝。先保存，或者在用户选择丢弃改动时传入 `{ discardUnsavedChanges: true }`。

### 离开前提醒

```ts
import { bindUnsavedChangesWarning } from 'fabricjs-document-engine';

const unbind = bindUnsavedChangesWarning(engine);
```

完整指南：[自动保存](https://fabricjs-document-engine.jscrate.dev/zh/docs/guides/autosave)和[保存冲突](https://fabricjs-document-engine.jscrate.dev/zh/docs/guides/save-conflicts)。

## 图片、字体和 CORS

每份保存的文档都带有一个 `assets` 清单，列出每个图片 URL 和字体变体，以及使用它们的对象 id。以 `data:` URL 内嵌的图片不需要请求，所以不在清单中。

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

### 打开文档时

1. `resolveUrl` 可以改写每个存储的 URL，例如给它签名，或者把资源 id 映射到 CDN。
2. `loadFont` 对每个字体变体运行一次。之后引擎会检查字体是否真的能渲染，而不是悄悄回退到默认字体。
3. 所有图片并行加载。如果有缺失，`replaceMissingImage` 可以为每一张提供替换 URL。返回 `null` 则保持缺失。
4. 如果仍有图片缺失，加载会以 `MISSING_ASSETS` 失败，`error.missingAssets` 列出每个 `{ url, objectIds }`。画布不会被改动。

不可用的 Fabric.js 字体会产生 `FONT_UNAVAILABLE` 警告，文字使用后备字体。设置 `requireFonts: true` 则改为以 `MISSING_FONTS` 失败。警告也会随 `load:success` 以 `{ document, warnings }` 的形式传递。

### 保存文档时

只存在于当前标签页的图片（`blob:` URL）和内嵌的 `data:` 图片，会各传给 `upload` 一次，文档中保存返回的 URL。没有 `upload` 处理函数时，`blob:` 图片会产生 `ASSET_NOT_PORTABLE` 警告，因为其他设备无法打开它们。

### 跨域图片

Fabric.js 的 CORS 图片问题是导出失败最常见的原因。来自其他站点、没有设置 `crossOrigin: 'anonymous'` 的图片会污染画布，导出就会失败。引擎会以 `IMAGE_CROSS_ORIGIN` 发出警告，让你在用户导出之前修复它。

### 随时检查和替换

```ts
const report = await engine.checkAssets();
report.missingImages;
report.unavailableFonts;
report.warnings;

await engine.replaceImage('/old-logo.png', '/new-logo.png');
```

`replaceImage` 会替换所有使用某个 URL 的图片。每张图片在页面上的尺寸保持不变，这次修改算一步撤销。`engine.getAssetManifest()` 返回当前画布的清单。

## 导出图片、SVG 或 JSON

Fabric.js 导出 PNG、JPEG、WebP 或 SVG（fabricjs 导出 svg、导出图片），一次调用就能完成。结果是一个 `Blob`，可以下载或上传。

```ts
import { downloadExport } from 'fabricjs-document-engine';

const result = await engine.export({ format: 'png', scale: 2 });
downloadExport(result, 'poster.png');
```

`result` 是 `{ format, mimeType, blob, width, height, warnings }`。JSON 导出还包含 `document`。

| 选项 | 取值 | 默认值 |
| --- | --- | --- |
| `format` | `'png'`、`'jpeg'`、`'webp'`、`'svg'` 或 `'json'` | 必填 |
| `scale` | 输出尺寸倍数，例如 `2` 用于高分屏 | `1` |
| `quality` | 0 到 1，用于 JPEG 和 WebP | `0.92` |
| `area` | `'canvas'`、`'content'`（所有对象）、`'selection'`，或 `{ left, top, width, height }` | `'canvas'` |
| `padding` | `content` 或 `selection` 周围的额外空白 | `0` |
| `background` | `'keep'`、`'transparent'` 或任意 CSS 颜色 | `'keep'` |
| `signal` | 用于取消的 `AbortSignal` | |

- 当前的缩放和平移不影响结果。导出始终使用文档坐标，之后会恢复视图。
- JPEG 没有透明通道，所以空的或透明的背景会变成白色，而不是黑色。
- 导出不会改变画布、历史记录或未保存状态。
- JSON 导出就是保存时生成的那份可移植文档；设置了 `assets.upload` 时，也包括上传后的图片。
- 不支持导出 PDF。如果需要，把 PNG 或 SVG 结果交给 PDF 库处理。

### 预检和错误

渲染之前，引擎会检查画布上的对象：

- **`MISSING_IMAGE`**：某张图片加载失败。
- **`CROSS_ORIGIN_IMAGE`**：来自其他站点、没有 CORS 的图片会让浏览器阻止 PNG、JPEG 或 WebP 导出。SVG 和 JSON 不受影响。
- **`MISSING_FONT`**：某种字体不可用，且开启了 `assets.requireFonts`。否则你会得到 `FONT_UNAVAILABLE` 警告。

只要发现问题，`export` 就会以 `EXPORT_BLOCKED` 拒绝，`error.problems` 列出每个 `{ code, message, url?, family?, objectIds }`。你可以先运行同样的检查，把结果显示在界面上：

```ts
const check = await engine.preflightExport({ format: 'png' });
if (!check.ok) showProblems(check.problems);
```

## 版本历史

```ts
const version = await engine.createVersion('Sent to client');
const versions = await engine.listVersions();
await engine.restoreVersion(version.id);
await engine.deleteVersion(version.id);
```

- 版本是文档的完整副本，保存在你的存储适配器中。内置适配器都支持版本。自定义适配器需要增加四个方法：`saveVersion(version)`、`listVersions(documentId)`、`loadVersion(documentId, versionId)` 和 `deleteVersion(documentId, versionId)`。
- `listVersions` 按从新到旧返回摘要：`{ id, documentId, name, kind, createdAt, revision }`。`kind` 是 `named` 或 `auto`。
- **恢复永远不会丢失内容。** 引擎会先保留一个名为 `Before restoring "..."` 的自动版本，然后把旧内容作为同一份文档的一个新的、未保存的修订加载。下一次保存会把它存为最新修订，历史保持线性。要撤销一次恢复，恢复那个自动版本即可。
- **自动版本。** 使用 `versions: { autoEvery: 10, keepAuto: 20 }`，每成功保存 10 次保留一个版本。命名版本永远不会被清理。自动版本只保留最新的 `keepAuto` 个，默认 20 个。
- 撤销和重做覆盖本次会话中最近的编辑。版本则把选定的状态保留下来，供以后使用。

## 加载 JSON 并从 Fabric 5 迁移

纯 Fabric JSON，例如 Fabric 5、6 或 7 中 `canvas.toJSON()` 的输出，可以直接打开：

```ts
await engine.importFabricJson(savedJsonText, { id: 'plan-42', metadata: { source: 'old editor' } });
```

`loadDocument` 和 `load(id)` 也能识别纯 Fabric JSON，所以现有 Fabric 应用存储的项目不需要单独的导入步骤就能打开。用 `load(id)` 加载的文档会保留这个 id，下一次保存时以当前格式存储。

每份文档都记录了自己的 `schemaVersion`，因此 Fabric.js 迁移是单向、逐步的升级。包的格式变化后，旧文档会在打开时升级。发生升级时，`load:success` 会报告 `migratedFrom`。某一步失败会以 `MIGRATION_FAILED` 拒绝，`error.migrationFrom` 指出它开始时的版本。来自更新版本的文档会以 `UNSUPPORTED_SCHEMA` 拒绝，而不会被误读。`migrateDocument(value, context)` 和 `detectSchemaVersion(value)` 也已导出，供服务端批量升级等工具使用。

## 恢复未保存的内容

用户编辑时，Fabric.js 的 IndexedDB 恢复在后台运行：

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

- **检查点。** 有未保存的改动时，最多每 `interval` 毫秒写一次副本（默认 2000）。文档已保存时不写入。
- **关闭或刷新。** 页面卸载时，浏览器不会让 IndexedDB 写完。所以标签页隐藏或关闭时，引擎还会立即往 localStorage 写一份副本。读取时以最新的副本为准。
- **只在当前标签页的图片。** `blob:` URL 的图片刷新后就没了。检查点会保留图片数据，恢复时为它们创建新的 URL。
- **保存之后。** 当一次保存覆盖了所有改动，副本会被删除。如果保存过程中标签页关闭了，副本会保留，所以从编辑到服务器之间的内容不会丢失。
- **恢复。** 恢复的文档会被标记为未保存，并保留它所基于的修订号。如果服务器在此期间有了更新，下一次保存会报告 `SAVE_CONFLICT`，而不是覆盖更新的内容。
- **中断的加载。** 文档加载时会保留一个标记。如果标签页在加载中崩溃，下次启动时 `engine.getInterruptedLoad()` 会返回 `{ documentId, startedAt }`，你可以跳过或丢弃那份文档，避免再次崩溃。
- `engine.flushRecovery()` 立即写一份副本。`engine.getRecovery(id?)` 读取一份。
- `createMemoryRecovery()` 把副本保存在内存中，适合测试。要使用你自己的存储，实现 `{ get, set, delete, keys }`，页面关闭时可以再加一个可选的同步方法 `setNow`。

## 自定义对象和属性

Fabric.js 自定义对象的额外字段，只有在保存时被列出来才会保留，否则就会出现丢失自定义属性的问题。注册一次类，它的属性就能在每次保存、加载、撤销和重做中保留下来：

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

如果文档中包含未注册的类型，加载会以 `UNKNOWN_OBJECT_TYPE` 失败，并列出缺少的类型。你的对象永远不会被变成别的东西。

## Fabric.js 撤销和重做

历史记录默认开启。引擎会自动记录这些操作：

- 添加和删除对象，同一个 tick 内的多次改动合为一步
- 指针移动、缩放和旋转（Fabric 的 `object:modified`）
- 完成的文字编辑

对于代码直接做的修改，例如 `object.set('fill', 'red')` 或 `canvas.bringObjectForward(object)`，Fabric 不会触发任何事件。把它们包在事务里，或者调用 `commit`：

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

- 事务可以嵌套，使用最外层的标签。事务也可以是异步的：`await engine.transaction('Import', async () => { ... })`。
- 要编组或取消编组，把删除和添加放在同一个事务里，它们就只占一步撤销。编组只是对象列表的普通修改。
- 撤销和重做会根据保存的状态重建被修改的对象，所以它们会以新实例、相同 id 的形式回来。请用 `engine.getObjectById(id)` 重新获取，而不是保留旧的引用。
- 用 `createDocumentEngine({ canvas, history: { limit: 50 } })` 只保留最近 50 步。默认是 100。

### 键盘快捷键

```ts
import { bindKeyboardShortcuts } from 'fabricjs-document-engine';

const unbind = bindKeyboardShortcuts(engine);
```

Ctrl/Cmd + Z 撤销。Ctrl/Cmd + Shift + Z 和 Ctrl + Y 重做。用户在 input、textarea、contenteditable 元素或 Fabric 文字中输入时，快捷键会被忽略，所以那里的原生文字撤销照常工作。传入 `{ target: element }` 可以监听 `window` 以外的元素。

### 工具栏状态

```ts
engine.on('history:change', ({ canUndo, canRedo, undoLabel, redoLabel }) => {
  undoButton.disabled = !canUndo;
  undoButton.title = undoLabel ? `Undo ${undoLabel}` : 'Undo';
});
```

[撤销和重做指南](https://fabricjs-document-engine.jscrate.dev/zh/docs/guides/undo-redo)有在线示例，并更详细地介绍了文字编辑。

## 文档格式

```ts
interface FabricDocument {
  schemaVersion: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  revision?: number;
  fabricVersion?: string;
  canvas: { width: number; height: number; background?: unknown };
  objects: SerializedFabricObject[];
  assets?: {
    images: Array<{ url: string; objectIds: string[] }>;
    fonts: Array<{ family: string; weight: string; style: string; objectIds: string[] }>;
  };
  metadata: Record<string, unknown>;
}
```

标题、所有者、标签等项目数据，请用 `engine.updateMetadata()` 放在 `metadata` 中，而不是放在 Fabric 对象上。

这个格式由包内附带的 JSON Schema 描述：

```ts
import schema from 'fabricjs-document-engine/schema/document-v1.json';
```

## 适用场景

当你在做 Fabric.js 画布编辑器时使用它：设计编辑器、图片编辑器、户型图工具、标签或证书生成器。绘制、选择和序列化仍然由 Fabric 完成。这个包在上面加了一层文档能力：id、历史记录、保存、加载、资源、导出和恢复。

如果你在比较画布编辑器 JS 库或撤销重做 JavaScript 库，注意它的范围。它不画工具栏，也不做实时协作。[对比页面](https://fabricjs-document-engine.jscrate.dev/zh/docs/overview/comparison)把它和 `fabric-history`、`fabricjs-react` 以及手写的 `toJSON` 放在一起比较。

## 兼容性

| | 支持情况 |
| --- | --- |
| Fabric | Fabric.js 6 和 Fabric.js 7（peer `^6.0.0 \|\| ^7.0.0`）；Fabric 5 的纯 JSON 通过迁移打开 |
| 浏览器 | 完整测试在 Chromium、Firefox 和 WebKit 中通过 |
| React | 18 和 19，可选 |
| Node | 18 或更高，用于服务端导入、校验和迁移 |
| 模块 | ESM 和 CommonJS，带 TypeScript 类型 |

测试过的版本和性能数据（5,000 个对象，除加载外每一步都在 50 ms 以内）见 [docs/compatibility.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/compatibility.md)。

## API 参考

每个函数、选项、事件和错误码都列在 [docs/api.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/api.md) 中。每个失败都是一个 `DocumentEngineError`，带有稳定的 `code`，可以直接用来判断，例如 `SAVE_CONFLICT`、`MISSING_ASSETS` 或 `UNSAVED_CHANGES`。加载失败永远不会清空画布，也不会只填一半。

## 稳定性

1.0 版冻结了文档格式和适配器约定：

- 文档由发布的 JSON Schema `fabricjs-document-engine/schema/document-v1.json` 校验。每个 1.x 版本都能读取之前版本写入的所有文档，以及 Fabric 5、6 和 7 的纯 Fabric JSON。
- 公开 API 的名称、选项、事件和错误码在 1.x 内不会改变，只可能新增。
- 为 1.0 编写的存储、版本和恢复适配器会继续可用。`fabricjs-document-engine/storage` 中的 `verifyStorageAdapter(storage)` 可以检查你的适配器是否遵守保存规则。

完整承诺见[兼容性策略](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/compatibility-policy.md)。完整配置见[生产环境指南](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/production.md)。

## 导入内容和限制

文档经常来自用户，所以引擎把它们当作不可信的内容：

- 名为 `__proto__`、`constructor` 或 `prototype` 的键会在 Fabric 看到之前被删除。Fabric 会把每个键复制到它创建的对象上，否则这些键可能改变对象的原型。
- 图片地址在 `assets.resolveUrl` 之后、任何请求之前检查。允许 `http:`、`https:`、`blob:`、相对地址和 `data:image/...`。`javascript:`、`file:` 和非图片的 `data:` 地址会以 `UNSAFE_DOCUMENT` 拒绝。
- 超过 50,000 个对象、或嵌套超过 100 层的文档会在加载前被拒绝，恶意文件无法卡死标签页。

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

`history.maxBytes` 限制撤销历史占用的内存。默认 64 MB，超出时先丢弃最早的步骤。SVG 导出会转义文字，所以文本框里的 `<script>` 这类内容仍然只是文字。

关于工具栏、状态文字和对话框的无障碍建议，见 [docs/accessibility.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/accessibility.md)。

## 问题排查

常见问题和解决方法见 [docs/troubleshooting.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/docs/troubleshooting.md)。大家问得最多的问题，例如 `loadFromJSON` 为什么会丢失自定义属性，在[常见问题](https://fabricjs-document-engine.jscrate.dev/zh/docs/overview/faq)中有解答。

## 帮助和贡献

- 文档和 Fabric.js 在线示例：[fabricjs-document-engine.jscrate.dev](https://fabricjs-document-engine.jscrate.dev/zh)
- Bug 和功能建议：[GitHub issues](https://github.com/re-sohail/fabricjs-document-engine/issues)
- 更新日志：[CHANGELOG.md](https://github.com/re-sohail/fabricjs-document-engine/blob/main/CHANGELOG.md)

由 [Sohail Khan](https://me.jscrate.dev) 维护。欢迎提交 Pull Request。每个面向用户的改动都需要一个 changeset（`npx changeset`）。

## 许可证

MIT
