import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The rear app runs in a current Chromium WebView; the viewer also has to run in the iPhone's Safari, so keep the syntax conservative.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['es2020', 'safari14'],
    rollupOptions: { input: { main: 'index.html', viewer: 'viewer.html' } },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
