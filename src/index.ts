export { createDocumentEngine } from './engine/create-document-engine';
export type {
  DocumentEngine,
  DocumentEngineEvents,
  DocumentEngineOptions,
  ExportResult,
  ImportOptions,
  NewDocumentRequest,
  LoadOptions,
  LoadProgress,
  LoadStage,
} from './engine/create-document-engine';
export { DocumentEngineError, createConflictError, isDocumentEngineError } from './engine/errors';
export type { DocumentErrorCode, DocumentIssue, DocumentEngineErrorDetails } from './engine/errors';
export type { Unsubscribe } from './engine/event-emitter';
export { CURRENT_SCHEMA_VERSION } from './document/document-format';
export type {
  DocumentCanvas,
  DocumentInfo,
  FabricDocument,
  SerializedFabricObject,
} from './document/document-format';
export type { NewDocumentOptions } from './document/create-document';
export { validateDocument } from './document/validate-document';
export type { CustomObjectDefinition } from './fabric/object-registry';
export type { HistoryOptions, HistoryState } from './history/create-history';
export { bindKeyboardShortcuts } from './history/keyboard-shortcuts';
export type { KeyboardShortcutOptions, UndoRedoTarget } from './history/keyboard-shortcuts';
export type { DocumentStorage, SaveContext, SaveResult } from './storage/storage-contract';
export type { SaveOptions, SaveRetryEvent, SaveState, SaveStatus } from './save/save-controller';
export type { AutosaveOptions } from './save/autosave-scheduler';
export type { RetryOptions } from './save/retry';
export { bindUnsavedChangesWarning } from './save/unsaved-changes-warning';
export type { UnsavedChangesSource } from './save/unsaved-changes-warning';
export type { AssetManifest, FontAsset, ImageAsset } from './assets/asset-manifest';
export type {
  AssetOptions,
  AssetReport,
  AssetWarning,
  AssetWarningCode,
  UploadRequest,
} from './assets/asset-pipeline';
export type { FontLoader } from './assets/font-check';
export type { ImageFailureReason, ImageLoadFailure } from './assets/image-check';
export type { InterruptedLoad, RecoveryOptions, RecoveryRecord } from './recovery/recovery-controller';
export type { RecoveryStore } from './recovery/recovery-store';
export type {
  ExportArea,
  ExportBackground,
  ExportFormat,
  ExportOptions,
  ExportRect,
  FontSource,
  SvgExportOptions,
} from './export/export-options';
export type { ExportPreflight, ExportProblem, ExportProblemCode } from './export/preflight-export';
export { downloadExport } from './export/download-export';
export { renderDocuments } from './export/batch-render';
export type { RenderDocumentsOptions, RenderedDocument } from './export/batch-render';
export type { DownloadableExport } from './export/download-export';
export { detectSchemaVersion, migrateDocument } from './migrations/migrate-document';
export type { Migration, MigrationContext, MigrationResult } from './migrations/migrate-document';
export type {
  DocumentVersion,
  VersionKind,
  VersionOptions,
  VersionStorage,
  VersionSummary,
} from './versions/document-version';
export { createDocumentStateStore } from './state/document-state-store';
export type { DocumentState, DocumentStateStore } from './state/document-state-store';
export { isSafeImageUrl, refuseUnsafeImageUrls, secureDocument } from './security/content-limits';
export type { ContentLimits } from './security/content-limits';
export type { SvgImportOptions, SvgImportResult, SvgImportWarning, SvgImportWarningCode } from './import/svg-import';
export { CLIPBOARD_FORMAT, createClipboard } from './commands/clipboard';
export type { Clipboard, ClipboardContent, ClipboardOptions, PasteOptions } from './commands/clipboard';
export { bringForward, bringToFront, getLayers, moveToIndex, sendBackward, sendToBack } from './commands/layers';
export type { LayerInfo, LayerOptions, LayerPin } from './commands/layers';
