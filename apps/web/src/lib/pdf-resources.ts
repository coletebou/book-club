import { PDFJS_BASE, PDFJS_FILES } from 'virtual:pdfjs-resources';

/*
 * pdf.js's resources (its decoders of scanned pages, colour profiles, standard fonts and CJK
 * character maps), served by the app itself under /assets/pdfjs-<version>/ (apps/web/pdfjs-resources.ts,
 * D102). The service worker answers them from PDFJS_CACHE, and keeps there what pdf.js fetches;
 * keeping a PDF for offline reading keeps all of them, so any kept PDF draws with no network.
 * Here, not in lib/pdf.ts: keeping a book must not load pdf.js.
 */

/** The cache the service worker answers pdf.js's resources from (sw.ts). Its files are no club's: wiped with the rest at sign-out all the same. */
export const PDFJS_CACHE = 'bc-pdfjs';

/** The resources' folder, as an absolute URL (pdf.js fetches from its worker), with its trailing slash. */
export function pdfjsBase(): string {
  return new URL(PDFJS_BASE, window.location.href).href;
}

/** How many files are fetched at once while they are kept. */
const AT_ONCE = 6;

let keeping: Promise<void> | null = null;

/**
 * Keep every file pdf.js may fetch on this device, in the background, once (about 3.5 MB, the
 * same for every PDF): those of an older pdf.js go. Only what is missing is fetched. Fails, to be
 * tried again at the next keeping, when one cannot be fetched.
 */
export function keepPdfjsResources(): Promise<void> {
  keeping ??= (async () => {
    if (!('caches' in window)) return;
    const cache = await caches.open(PDFJS_CACHE);
    const have = new Set<string>();
    for (const request of await cache.keys()) {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith(PDFJS_BASE)) have.add(pathname);
      else await cache.delete(request);
    }
    const missing = PDFJS_FILES.map((file) => `${PDFJS_BASE}${file}`).filter((url) => !have.has(url));
    let next = 0;
    let failed = false;
    const fetchers = await Promise.allSettled(
      Array.from({ length: Math.min(AT_ONCE, missing.length) }, async () => {
        while (next < missing.length && !failed) {
          const url = missing[next++]!;
          try {
            const res = await fetch(url, { credentials: 'same-origin' });
            if (!res.ok) throw new Error(`Could not download ${url} (${res.status}).`);
            await cache.put(url, res);
          } catch (err) {
            // The others stop too: what is still missing is fetched at the next keeping.
            failed = true;
            throw err;
          }
        }
      }),
    );
    const failure = fetchers.find((f) => f.status === 'rejected');
    if (failure) throw failure.reason;
  })().finally(() => {
    keeping = null;
  });
  return keeping;
}
