import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/storage.ts',
    'src/recovery.ts',
    'src/react.ts',
    'src/pdf.ts',
    'src/text.ts',
    'src/performance.ts',
    'src/filters.ts',
    'src/filters/worker-entry.ts',
  ],
  format: ['esm', 'cjs'],
  unbundle: true,
  platform: 'neutral',
  target: 'es2020',
  dts: true,
  deps: {
    neverBundle: ['fabric', /^fabric\//, 'react', /^react\//, 'jspdf', /^jspdf\//, 'svg2pdf.js'],
  },
  exports: false,
  treeshake: true,
  sourcemap: false,
  clean: true,
  plugins: [
    {
      name: 'browser-safe-cjs-worker-url',
      renderChunk(code: string, _chunk: unknown, options: { format: string }) {
        if (options.format !== 'cjs' || !code.includes('pathToFileURL(__filename)')) return null;
        return code.replace(/require\("url"\)\.pathToFileURL\(__filename\)\.href/g, 'undefined');
      },
    },
  ],
});
