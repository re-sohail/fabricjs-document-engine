import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const reference = readFileSync('docs/api.md', 'utf8');
const engineSource = readFileSync('src/engine/create-document-engine.ts', 'utf8');
const errorSource = readFileSync('src/engine/errors.ts', 'utf8');

function blockOf(source: string, header: string): string {
  const start = source.indexOf(header);
  return source.slice(start, source.indexOf('\n}', start));
}

function undocumented(names: readonly string[]): string[] {
  return names.filter((name) => !reference.includes(`\`${name}`));
}

describe('API reference', () => {
  it('documents every runtime export of every entry', async () => {
    const entries = await Promise.all([
      import('../src/index'),
      import('../src/storage'),
      import('../src/recovery'),
      import('../src/react'),
      import('../src/pdf'),
      import('../src/text'),
      import('../src/performance'),
      import('../src/filters'),
    ]);
    const names = entries.flatMap((entry) => Object.keys(entry));
    expect(undocumented(names)).toEqual([]);
  }, 120_000);

  it('documents every engine method', () => {
    const members = [...blockOf(engineSource, 'export interface DocumentEngine {').matchAll(/^ {2}(?:readonly )?([a-zA-Z]+)[(<:]/gm)].map(
      (match) => match[1]!,
    );
    expect(members.length).toBeGreaterThan(30);
    expect(undocumented(members)).toEqual([]);
  });

  it('documents every event', () => {
    const events = [...blockOf(engineSource, 'export interface DocumentEngineEvents {').matchAll(/'([a-z]+:[a-z]+)'/g)].map((match) => match[1]!);
    expect(events.length).toBeGreaterThan(15);
    expect(undocumented(events)).toEqual([]);
  });

  it('documents every error code', () => {
    const codes = [...blockOf(errorSource, 'export type DocumentErrorCode').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
    expect(codes.length).toBeGreaterThan(25);
    expect(undocumented(codes)).toEqual([]);
  });
});
