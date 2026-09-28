import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/storage.ts', 'src/recovery.ts', 'src/react.ts'],
  format: ['esm', 'cjs'],
  unbundle: true,
  platform: 'neutral',
  target: 'es2020',
  dts: true,
  deps: {
    neverBundle: ['fabric', /^fabric\//, 'react', /^react\//],
  },
  exports: false,
  treeshake: true,
  sourcemap: false,
  clean: true,
});
