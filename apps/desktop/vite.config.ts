import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@interview/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    // Electron's Chromium supports <link rel="modulepreload"> natively, so we
    // drop Vite's inline polyfill script. This keeps the packaged-app CSP strict
    // (`script-src 'self'`) without needing 'unsafe-inline'.
    modulePreload: { polyfill: false },
  },
});