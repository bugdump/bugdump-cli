import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  // Customer CI often runs an older Node than this repository; package.json engines says >=18.
  target: 'node18',
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
});
