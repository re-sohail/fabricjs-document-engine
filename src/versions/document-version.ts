import type { FabricDocument } from '../document/document-format';

export type VersionKind = 'named' | 'auto';

export interface VersionSummary {
  id: string;
  documentId: string;
  name: string;
  kind: VersionKind;
  createdAt: string;
  revision: number;
}

export interface DocumentVersion extends VersionSummary {
  document: FabricDocument;
}

export interface VersionStorage {
  saveVersion(version: DocumentVersion): Promise<void>;
  listVersions(documentId: string): Promise<VersionSummary[]>;
  loadVersion(documentId: string, versionId: string): Promise<DocumentVersion>;
  deleteVersion(documentId: string, versionId: string): Promise<void>;
}

export interface VersionOptions {
  keepAuto?: number;
  autoEvery?: number;
}

export function summarize(version: DocumentVersion): VersionSummary {
  const { document: _document, ...summary } = version;
  return summary;
}

export function newestFirst(first: VersionSummary, second: VersionSummary): number {
  return second.createdAt.localeCompare(first.createdAt);
}

export function versionsToPrune(versions: readonly VersionSummary[], keepAuto: number): VersionSummary[] {
  return versions
    .filter((version) => version.kind === 'auto')
    .sort(newestFirst)
    .slice(Math.max(0, keepAuto));
}

export function supportsVersions(storage: unknown): storage is VersionStorage {
  const candidate = storage as Partial<VersionStorage> | undefined;
  return (
    typeof candidate?.saveVersion === 'function' &&
    typeof candidate.listVersions === 'function' &&
    typeof candidate.loadVersion === 'function' &&
    typeof candidate.deleteVersion === 'function'
  );
}
