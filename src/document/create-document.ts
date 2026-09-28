import { createId } from './ids';
import type { DocumentInfo } from './document-format';

export interface NewDocumentOptions {
  id?: string;
  metadata?: Record<string, unknown>;
}

export function createDocumentInfo(options: NewDocumentOptions = {}): DocumentInfo {
  const now = new Date().toISOString();
  return {
    id: options.id ?? createId(),
    createdAt: now,
    updatedAt: now,
    metadata: { ...options.metadata },
  };
}
