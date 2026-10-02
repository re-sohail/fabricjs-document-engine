import type { AssetManifest } from '../assets/asset-manifest';

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
  /** A color, gradient or pattern behind everything. */
  background?: unknown;
  /** A Fabric image drawn behind every object. */
  backgroundImage?: SerializedFabricObject;
  /** A color, gradient or pattern drawn over every object. */
  overlay?: unknown;
  /** A Fabric image drawn over every object. */
  overlayImage?: SerializedFabricObject;
  /** A Fabric object that clips the whole canvas. */
  clipPath?: SerializedFabricObject;
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
  assets?: AssetManifest;
  metadata: Record<string, unknown>;
}

export interface DocumentInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  /**
   * Goes up each time the canvas shows a different document: a load, a new
   * document or a restore. Async work started under one session must not
   * change the canvas in another. Set by `getDocumentInfo()`.
   */
  session?: number;
}
