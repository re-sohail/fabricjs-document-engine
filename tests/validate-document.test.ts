import { describe, expect, it } from 'vitest';
import { validateDocument } from '../src/document/validate-document';
import { CURRENT_SCHEMA_VERSION } from '../src/document/document-format';

function validDocument(): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'doc-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    canvas: { width: 800, height: 600 },
    objects: [{ type: 'Rect', id: 'a' }, { type: 'Group', objects: [{ type: 'Circle' }] }],
    metadata: {},
  };
}

describe('validateDocument', () => {
  it('accepts a well formed document', () => {
    expect(validateDocument(validDocument())).toEqual([]);
  });

  it('rejects values that are not objects', () => {
    expect(validateDocument(null)[0]?.code).toBe('INVALID_DOCUMENT');
    expect(validateDocument([])[0]?.code).toBe('INVALID_DOCUMENT');
  });

  it('reports a newer schema as unsupported', () => {
    const issues = validateDocument({ ...validDocument(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('UNSUPPORTED_SCHEMA');
  });

  it('points at the exact nested object that is broken', () => {
    const document = validDocument();
    document.objects = [{ type: 'Group', objects: [{ type: 'Rect' }, { id: 5 }] }];
    const paths = validateDocument(document).map((issue) => issue.path);
    expect(paths).toContain('objects[0].objects[1].type');
    expect(paths).toContain('objects[0].objects[1].id');
  });

  it('checks canvas size and required fields', () => {
    const document = validDocument();
    document.canvas = { width: 0, height: 'tall' };
    delete document.id;
    const paths = validateDocument(document).map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['id', 'canvas.width', 'canvas.height']));
  });

  it('validates clip paths too', () => {
    const document = validDocument();
    document.objects = [{ type: 'Rect', clipPath: { notAType: true } }];
    expect(validateDocument(document).map((issue) => issue.path)).toContain('objects[0].clipPath.type');
  });
});
