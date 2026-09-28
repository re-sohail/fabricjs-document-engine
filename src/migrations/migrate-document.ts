import { CURRENT_SCHEMA_VERSION } from '../document/document-format';
import { createId } from '../document/ids';
import { DocumentEngineError } from '../engine/errors';

export interface MigrationContext {
  canvasWidth: number;
  canvasHeight: number;
  id?: string;
  metadata?: Record<string, unknown>;
}

export type Migration = (document: Record<string, unknown>, context: MigrationContext) => Record<string, unknown>;

export interface MigrationResult {
  document: unknown;
  migratedFrom: number | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function fromFabricJson(json: Record<string, unknown>, context: MigrationContext): Record<string, unknown> {
  const now = new Date().toISOString();
  const document: Record<string, unknown> = {
    schemaVersion: 1,
    id: context.id ?? (typeof json.id === 'string' && json.id.length > 0 ? json.id : createId()),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    canvas: {
      width: positiveNumberOr(json.width, context.canvasWidth),
      height: positiveNumberOr(json.height, context.canvasHeight),
      ...(json.background === undefined ? {} : { background: json.background }),
    },
    objects: json.objects,
    metadata: { ...context.metadata },
  };
  if (typeof json.version === 'string') document.fabricVersion = json.version;
  return document;
}

export const migrations: Readonly<Record<number, Migration>> = {
  0: fromFabricJson,
};

export function detectSchemaVersion(value: unknown): number | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.schemaVersion === 'number' && Number.isInteger(value.schemaVersion)) return value.schemaVersion;
  if (value.schemaVersion === undefined && Array.isArray(value.objects)) return 0;
  return undefined;
}

export function migrateDocument(
  value: unknown,
  context: MigrationContext,
  steps: Readonly<Record<number, Migration>> = migrations,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): MigrationResult {
  const startVersion = detectSchemaVersion(value);
  if (startVersion === undefined || startVersion >= targetVersion || startVersion < 0) {
    return { document: value, migratedFrom: undefined };
  }

  let document = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (let version = startVersion; version < targetVersion; version += 1) {
    const step = steps[version];
    if (!step) {
      throw new DocumentEngineError('MIGRATION_FAILED', `There is no migration from schema version ${version}`, {
        migrationFrom: version,
      });
    }
    try {
      document = step(document, context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new DocumentEngineError(
        'MIGRATION_FAILED',
        `Could not migrate the document from schema version ${version} to ${version + 1}: ${reason}`,
        { cause: error, migrationFrom: version },
      );
    }
    if (document.schemaVersion !== version + 1) {
      throw new DocumentEngineError(
        'MIGRATION_FAILED',
        `The migration from schema version ${version} produced version ${String(document.schemaVersion)} instead of ${version + 1}`,
        { migrationFrom: version },
      );
    }
  }
  return { document, migratedFrom: startVersion };
}
