import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { resolveRendererApiUrl } from './electron/rendererApiUrl';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');
  const apiUrl = resolveRendererApiUrl(
    mode,
    process.env.VITE_API_URL ?? env.VITE_API_URL,
  );

  return {
    plugins: [react()],
    base: './',
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '@interview/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
    },
    server: {
      // PORT задаёт превью-тулинг; Electron-dev и ручной запуск живут на 5173.
      port: Number(process.env.PORT) || 5173,
      strictPort: true,
    },
    build: {
      outDir: 'dist',
      // Electron's Chromium supports <link rel="modulepreload"> natively, so we
      // drop Vite's inline polyfill script. This keeps the packaged-app CSP strict
      // (`script-src 'self'`) without needing 'unsafe-inline'.
      modulePreload: { polyfill: false },
    },
  };
});
