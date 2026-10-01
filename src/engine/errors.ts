import type { FontAsset, ImageAsset } from '../assets/asset-manifest';
import type { ExportProblem } from '../export/preflight-export';

export type DocumentErrorCode =
  | 'INVALID_DOCUMENT'
  | 'UNSAFE_DOCUMENT'
  | 'UNSUPPORTED_SCHEMA'
  | 'UNKNOWN_OBJECT_TYPE'
  | 'INVALID_CUSTOM_OBJECT'
  | 'LOAD_ABORTED'
  | 'LOAD_FAILED'
  | 'MISSING_ASSETS'
  | 'MISSING_FONTS'
  | 'ASSET_UPLOAD_FAILED'
  | 'STORAGE_MISSING'
  | 'UNSAVED_CHANGES'
  | 'SAVE_FAILED'
  | 'SAVE_CONFLICT'
  | 'SAVE_CANCELLED'
  | 'DOCUMENT_NOT_FOUND'
  | 'HISTORY_FAILED'
  | 'RECOVERY_MISSING'
  | 'RECOVERY_NOT_FOUND'
  | 'RECOVERY_FAILED'
  | 'MIGRATION_FAILED'
  | 'VERSIONS_UNSUPPORTED'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_FAILED'
  | 'INVALID_EXPORT_OPTIONS'
  | 'EXPORT_BLOCKED'
  | 'EXPORT_FAILED'
  | 'EXPORT_ABORTED'
  | 'SVG_IMPORT_FAILED'
  | 'PDF_UNAVAILABLE'
  | 'PDF_FAILED'
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
  problems?: ExportProblem[];
  migrationFrom?: number;
  cause?: unknown;
  retryable?: boolean;
}

export class DocumentEngineError extends Error {
  readonly code: DocumentErrorCode;
  readonly issues: DocumentIssue[];
  readonly unknownTypes: string[];
  readonly missingAssets: ImageAsset[];
  readonly missingFonts: FontAsset[];
  readonly problems: ExportProblem[];
  readonly migrationFrom: number | undefined;
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
    this.problems = details.problems ?? [];
    this.migrationFrom = details.migrationFrom;
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
