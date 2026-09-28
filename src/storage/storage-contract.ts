import type { FabricDocument } from '../document/document-format';

export interface SaveContext {
  expectedRevision: number | null;
  signal: AbortSignal;
}

export interface SaveResult {
  revision?: number;
}

export interface DocumentStorage {
  loadDocument(id: string): Promise<unknown>;
  saveDocument(document: FabricDocument, context: SaveContext): Promise<void | SaveResult>;
}
