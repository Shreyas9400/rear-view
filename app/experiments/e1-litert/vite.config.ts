import { defineConfig } from 'vite';

// Throwaway build of the E1 probe. public/ is populated by `npm run prep` (wasm + model copied from node_modules / models).
export default defineConfig({
  root: '.',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
