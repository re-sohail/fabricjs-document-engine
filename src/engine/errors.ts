import type { FontAsset, ImageAsset } from '../assets/asset-manifest';

export type DocumentErrorCode =
  | 'INVALID_DOCUMENT'
  | 'UNSUPPORTED_SCHEMA'
  | 'UNKNOWN_OBJECT_TYPE'
  | 'INVALID_CUSTOM_OBJECT'
  | 'LOAD_ABORTED'
  | 'LOAD_FAILED'
  | 'MISSING_ASSETS'
  | 'MISSING_FONTS'
  | 'ASSET_UPLOAD_FAILED'
  | 'STORAGE_MISSING'
  | 'SAVE_FAILED'
  | 'SAVE_CONFLICT'
  | 'SAVE_CANCELLED'
  | 'DOCUMENT_NOT_FOUND'
  | 'HISTORY_FAILED'
  | 'RECOVERY_MISSING'
  | 'RECOVERY_NOT_FOUND'
  | 'RECOVERY_FAILED'
  | 'ENGINE_DESTROYED';

export interface DocumentIssue {
  code: DocumentErrorCode;
  path: string;
  message: string;
}

export interface DocumentEngineErrorDetails {
  issues?: DocumentIssue[];
  unknownTypes?: string[];
  missingAssets?: ImageAsset[];
  missingFonts?: FontAsset[];
  cause?: unknown;
  retryable?: boolean;
}

export class DocumentEngineError extends Error {
  readonly code: DocumentErrorCode;
  readonly issues: DocumentIssue[];
  readonly unknownTypes: string[];
  readonly missingAssets: ImageAsset[];
  readonly missingFonts: FontAsset[];
  readonly cause: unknown;
  readonly retryable: boolean;

  constructor(code: DocumentErrorCode, message: string, details: DocumentEngineErrorDetails = {}) {
    super(message);
    this.name = 'DocumentEngineError';
    this.code = code;
    this.issues = details.issues ?? [];
    this.unknownTypes = details.unknownTypes ?? [];
    this.missingAssets = details.missingAssets ?? [];
    this.missingFonts = details.missingFonts ?? [];
    this.cause = details.cause;
    this.retryable = details.retryable ?? false;
  }
}

export function isDocumentEngineError(value: unknown): value is DocumentEngineError {
  return value instanceof DocumentEngineError;
}

export function createConflictError(documentId: string, expectedRevision: number, actualRevision: number): DocumentEngineError {
  return new DocumentEngineError(
    'SAVE_CONFLICT',
    `Document "${documentId}" was saved somewhere else: expected revision ${expectedRevision} but storage has ${actualRevision}`,
  );
}
