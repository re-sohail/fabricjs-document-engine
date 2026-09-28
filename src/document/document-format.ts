export const CURRENT_SCHEMA_VERSION = 1;

export interface SerializedFabricObject {
  type: string;
  id?: string;
  objects?: SerializedFabricObject[];
  clipPath?: SerializedFabricObject;
  [property: string]: unknown;
}

export interface DocumentCanvas {
  width: number;
  height: number;
  background?: unknown;
}

export interface FabricDocument {
  schemaVersion: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  revision?: number;
  fabricVersion?: string;
  canvas: DocumentCanvas;
  objects: SerializedFabricObject[];
  metadata: Record<string, unknown>;
}

export interface DocumentInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}
