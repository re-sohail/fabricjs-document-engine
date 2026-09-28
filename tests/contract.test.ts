import { describe, expect, it } from 'vitest';
import Ajv from 'ajv/dist/2020';
import schema from '../schema/document-v1.schema.json';
import golden from './fixtures/document-v1.json';
import fabricFive from './fixtures/fabric-v5.json';
import { CURRENT_SCHEMA_VERSION, migrateDocument, validateDocument } from '../src';

const checkAgainstSchema = new Ajv({ strict: false }).compile(schema);

describe('frozen document format', () => {
  it('is still schema version 1', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  it('accepts the golden 1.0 document in the JSON Schema and the validator', () => {
    expect(checkAgainstSchema(golden), JSON.stringify(checkAgainstSchema.errors)).toBe(true);
    expect(validateDocument(golden)).toEqual([]);
  });

  it('migrates plain Fabric 5 JSON into a document that matches the schema', () => {
    const { document, migratedFrom } = migrateDocument(fabricFive, { canvasWidth: 800, canvasHeight: 600 });
    expect(migratedFrom).toBe(0);
    expect(checkAgainstSchema(document), JSON.stringify(checkAgainstSchema.errors)).toBe(true);
    expect(validateDocument(document)).toEqual([]);
  });

  it('agrees with the validator about broken documents', () => {
    const broken = [
      { ...golden, schemaVersion: 2 },
      { ...golden, id: '' },
      { ...golden, canvas: { width: 0, height: 10 } },
      { ...golden, objects: [{ id: 'no-type' }] },
      { ...golden, revision: -1 },
    ];
    for (const document of broken) {
      expect(checkAgainstSchema(document)).toBe(false);
      expect(validateDocument(document).length).toBeGreaterThan(0);
    }
  });
});
