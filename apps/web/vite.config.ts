import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pdfjsResources } from './pdfjs-resources.ts';

const api = process.env.BOOKCLUB_API ?? 'http://127.0.0.1:47100';

const entry = normalizePath(fileURLToPath(new URL('index.html', import.meta.url)));
const source = normalizePath(fileURLToPath(new URL('src/', import.meta.url)));
const framework = /[\\/]node_modules[\\/](react|react-dom|react-router|scheduler|@tanstack[\\/](query-core|react-query))[\\/]/;
let shellModules: Set<string> | undefined;

function isInShell(id: string, graph: { getModuleInfo(id: string): { readonly importedIds: readonly string[] } | null }): boolean {
  if (!shellModules) {
    const visited = new Set<string>();
    function visit(moduleId: string): void {
      if (visited.has(moduleId)) return;
      visited.add(moduleId);
      for (const dependency of graph.getModuleInfo(moduleId)?.importedIds ?? []) visit(dependency);
    }
    visit(entry);
    shellModules = visited;
  }
  return shellModules.has(id);
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'static-shell-imports',
      apply: 'build',
      buildStart() { shellModules = undefined; },
    },
    pdfjsResources(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,webmanifest,woff2}'],
        globIgnores: [
          'assets/pdfjs-*/**', // Kept with downloaded PDFs (D102, D242, D246).
          'assets/livekit-*.js', // A live voice connection needs the network (D297).
          'landing/*.png', // Public previews load on request (D239).
          'fonts/italianno-latin-400-normal.woff2', // Available for future use (D247).
          'fonts/jetbrains-mono-latin-wght-normal.woff2',
        ],
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
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              debugName: 'static framework imports',
              priority: 1,
              test: framework,
              name: (id, graph) => isInShell(id, graph) ? 'shell-framework' : null,
            },
            {
              // Group application source reached through static imports (D301). Shared package roots
              // keep automatic splitting, including lazy validation and media entry points.
              debugName: 'static shell imports',
              test: (id) => id.startsWith(source) && id !== `${source}main.tsx`,
              name: (id, graph) => isInShell(id, graph) ? 'shell-code' : null,
            },
          ],
        },
      },
    },
  },
});
