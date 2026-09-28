export { createDocumentEngine } from './engine/create-document-engine';
export type {
  DocumentEngine,
  DocumentEngineEvents,
  DocumentEngineOptions,
  DocumentStorage,
  LoadOptions,
} from './engine/create-document-engine';
export { DocumentEngineError, isDocumentEngineError } from './engine/errors';
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
