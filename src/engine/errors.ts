export type DocumentErrorCode =
  | 'INVALID_DOCUMENT'
  | 'UNSUPPORTED_SCHEMA'
  | 'UNKNOWN_OBJECT_TYPE'
  | 'INVALID_CUSTOM_OBJECT'
  | 'LOAD_ABORTED'
  | 'LOAD_FAILED'
  | 'STORAGE_MISSING'
  | 'SAVE_FAILED'
  | 'ENGINE_DESTROYED';

export interface DocumentIssue {
  code: DocumentErrorCode;
  path: string;
  message: string;
}

export interface DocumentEngineErrorDetails {
  issues?: DocumentIssue[];
  unknownTypes?: string[];
  cause?: unknown;
}

export class DocumentEngineError extends Error {
  readonly code: DocumentErrorCode;
  readonly issues: DocumentIssue[];
  readonly unknownTypes: string[];
  readonly cause: unknown;

  constructor(code: DocumentErrorCode, message: string, details: DocumentEngineErrorDetails = {}) {
    super(message);
    this.name = 'DocumentEngineError';
    this.code = code;
    this.issues = details.issues ?? [];
    this.unknownTypes = details.unknownTypes ?? [];
    this.cause = details.cause;
  }
}

export function isDocumentEngineError(value: unknown): value is DocumentEngineError {
  return value instanceof DocumentEngineError;
}
