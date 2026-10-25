import { defineConfig } from 'vitest/config';
import { buildInfo } from './scripts/build-info.mjs';

// Tauri expects a fixed port and loads the dev server from it.
export default defineConfig({
  clearScreen: false,
  define: { __SKETCH_BUILD__: JSON.stringify(buildInfo()) },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
