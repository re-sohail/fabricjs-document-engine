import { describe, expect, it } from 'vitest';

describe('server side import', () => {
  it('imports every entry without a browser', async () => {
    const core = await import('../src/index');
    const storage = await import('../src/storage');
    const recovery = await import('../src/recovery');
    const react = await import('../src/react');
    const pdf = await import('../src/pdf');
    expect(typeof core.createDocumentEngine).toBe('function');
    expect(typeof pdf.exportPdf).toBe('function');
    expect(typeof storage.createMemoryStorage).toBe('function');
    expect(typeof recovery.createMemoryRecovery).toBe('function');
    expect(typeof react.useDocumentEngine).toBe('function');
  }, 120_000);

  it('validates and migrates documents on the server', async () => {
    const { migrateDocument, validateDocument } = await import('../src/index');
    const { document } = migrateDocument({ objects: [{ type: 'rect' }] }, { canvasWidth: 100, canvasHeight: 100 });
    expect(validateDocument(document)).toEqual([]);
  });

  it('keeps memory recovery working without window', async () => {
    const { createMemoryRecovery } = await import('../src/recovery');
    const store = createMemoryRecovery();
    await store.set('a', 1);
    expect(await store.get('a')).toBe(1);
  });

  it('refuses a PDF export without a browser, before loading any PDF library', async () => {
    const { exportPdf } = await import('../src/pdf');
    const error = await exportPdf({ schemaVersion: 1, objects: [] }).catch((reason: unknown) => reason);
    expect((error as { code?: string }).code).toBe('PDF_UNAVAILABLE');
  });
});
