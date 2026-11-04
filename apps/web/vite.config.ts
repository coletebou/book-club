import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pdfjsResources } from './pdfjs-resources.ts';

const api = process.env.BOOKCLUB_API ?? 'http://127.0.0.1:47100';

export default defineConfig({
  plugins: [
    react(),
    pdfjsResources(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,webmanifest,woff2}'],
        // pdf.js's decoders, fonts and maps are kept once a PDF is kept, not by everyone (src/lib/pdf.ts).
        globIgnores: ['assets/pdfjs-*/**'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 47173,
    strictPort: true,
    proxy: {
      '/api': api,
      '/media': api,
      '/healthz': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
  preview: { host: '127.0.0.1', port: 47174, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
  },
});
