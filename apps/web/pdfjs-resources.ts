import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type Plugin } from 'vite';

/*
 * What the browser's pdf.js fetches while it draws a PDF, served by the app itself (D102): the
 * decoders of scanned pages (JPEG 2000 and JBIG2, as WebAssembly, with their plain-JavaScript
 * fallbacks), the colour-profile engine and its CMYK profile, the fourteen standard fonts and the
 * character maps of CJK fonts: what the server's pdf.js reads from its own copy
 * (apps/server/src/ingest/pdf.ts). Under a path that changes with pdf.js's version, so the server
 * may tell browsers to keep them for good; the service worker keeps them for offline reading once
 * a PDF is kept (src/lib/pdf.ts). pdf.js's script engine (quickjs) is left out: no PDF's scripts run.
 */

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

/** Where the resources are served: `/assets/pdfjs-<version>/`, beside the app's other immutable files. */
export const PDFJS_BASE = `/assets/pdfjs-${version}/`;
/** pdf.js's folders of them, as its getDocument options name them (wasmUrl, iccUrl, standardFontDataUrl, cMapUrl). */
const FOLDERS = ['wasm', 'iccs', 'standard_fonts', 'cmaps'] as const;

/** Every file served, as `<folder>/<name>`: the resources and their licences. */
const served = FOLDERS.flatMap((folder) =>
  readdirSync(path.join(root, folder))
    .filter((name) => !name.startsWith('quickjs'))
    .sort()
    .map((name) => `${folder}/${name}`),
);
/** The files pdf.js may fetch (the licences are served, not fetched). */
export const PDFJS_FILES = served.filter((file) => !/\/LICENSE/.test(file));

const VIRTUAL = 'virtual:pdfjs-resources';

/**
 * The Vite plugin: `virtual:pdfjs-resources` (PDFJS_BASE and PDFJS_FILES, for the app), the files
 * copied into the build, and served from node_modules by the development server.
 */
export function pdfjsResources(): Plugin {
  return {
    name: 'bookclub-pdfjs-resources',
    resolveId: (id) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
    load: (id) => (id === `\0${VIRTUAL}` ? `export const PDFJS_BASE = ${JSON.stringify(PDFJS_BASE)};\nexport const PDFJS_FILES = ${JSON.stringify(PDFJS_FILES)};\n` : null),
    generateBundle() {
      for (const file of served) this.emitFile({ type: 'asset', fileName: `${PDFJS_BASE.slice(1)}${file}`, source: readFileSync(path.join(root, file)) });
    },
    configureServer(server) {
      server.middlewares.use(PDFJS_BASE, (req, res, next) => {
        const file = decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\/+/, ''));
        if (!served.includes(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        createReadStream(path.join(root, file)).pipe(res);
      });
    },
  };
}
