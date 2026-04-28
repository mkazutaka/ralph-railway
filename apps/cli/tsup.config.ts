import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.tsx' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: false,
  splitting: false,
  minify: false,
  // The src shebang (#!/usr/bin/env node) is preserved by esbuild.
  // Dependencies are externalized by default; users install them from npm.
});
