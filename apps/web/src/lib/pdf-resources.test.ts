import { PDFJS_BASE, PDFJS_FILES } from 'virtual:pdfjs-resources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFJS_CACHE, keepPdfjsResources, pdfjsBase } from './pdf-resources';

/** Cache Storage in memory, keyed by path (jsdom has none). */
const buckets = new Map<string, Map<string, Response>>();
const pathOf = (url: string) => new URL(url, 'http://localhost').pathname;
const fakeCaches = {
  open: (name: string) => {
    const bucket = buckets.get(name) ?? new Map<string, Response>();
    buckets.set(name, bucket);
    return Promise.resolve({
      keys: () => Promise.resolve([...bucket.keys()].map((url) => new Request(new URL(url, 'http://localhost')))),
      delete: (request: Request) => Promise.resolve(bucket.delete(pathOf(request.url))),
      put: (url: string, res: Response) => Promise.resolve(void bucket.set(pathOf(url), res)),
    });
  },
};

describe('pdf.js’s resources, served by the app and kept for offline reading (fidelity review round 17)', () => {
  beforeEach(() => {
    buckets.clear();
    vi.stubGlobal('caches', fakeCaches);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('are the decoders, colour profiles, fonts and maps of this pdf.js, under a path that changes with its version', () => {
    expect(PDFJS_BASE).toMatch(/^\/assets\/pdfjs-\d+\.\d+\.\d+\/$/);
    expect(PDFJS_FILES).toEqual(expect.arrayContaining(['wasm/openjpeg.wasm', 'wasm/openjpeg_nowasm_fallback.js', 'wasm/jbig2.wasm', 'wasm/qcms_bg.wasm', 'iccs/CGATS001Compat-v2-micro.icc', 'standard_fonts/FoxitSerif.pfb', 'standard_fonts/LiberationSans-Regular.ttf', 'cmaps/UniJIS-UCS2-H.bcmap']));
    // No script engine (no PDF's scripts run), and the licences are served, not fetched.
    expect(PDFJS_FILES.some((f) => /quickjs|LICENSE/.test(f))).toBe(false);
    // pdf.js fetches from its worker: an absolute URL, with its trailing slash.
    expect(pdfjsBase()).toBe(`${window.location.origin}${PDFJS_BASE}`);
  });

  it('are all kept once, only what is missing fetched again, an older version’s let go', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(new Response(`bytes of ${url}`, { status: 200 }));
      }),
    );
    const older = fakeCaches.open(PDFJS_CACHE);
    await (await older).put('/assets/pdfjs-1.0.0/wasm/openjpeg.wasm', new Response('old'));
    const first = keepPdfjsResources();
    // Asked again meanwhile: the same keeping.
    expect(keepPdfjsResources()).toBe(first);
    await first;
    expect(fetched.sort()).toEqual(PDFJS_FILES.map((f) => `${PDFJS_BASE}${f}`).sort());
    expect([...buckets.get(PDFJS_CACHE)!.keys()].sort()).toEqual(PDFJS_FILES.map((f) => `${PDFJS_BASE}${f}`).sort());
    // One went missing: only it is fetched.
    buckets.get(PDFJS_CACHE)!.delete(`${PDFJS_BASE}wasm/jbig2.wasm`);
    fetched.length = 0;
    await keepPdfjsResources();
    expect(fetched).toEqual([`${PDFJS_BASE}wasm/jbig2.wasm`]);
  });

  it('fails when one cannot be fetched, and the next keeping fetches what is still missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(new Response('x', { status: url.endsWith('openjpeg.wasm') ? 503 : 200 }))),
    );
    await expect(keepPdfjsResources()).rejects.toThrow(/openjpeg\.wasm \(503\)/);
    const kept = buckets.get(PDFJS_CACHE)!.size;
    expect(kept).toBeLessThan(PDFJS_FILES.length);
    const fetch = vi.fn(() => Promise.resolve(new Response('x', { status: 200 })));
    vi.stubGlobal('fetch', fetch);
    await keepPdfjsResources();
    expect(fetch).toHaveBeenCalledTimes(PDFJS_FILES.length - kept);
    expect(buckets.get(PDFJS_CACHE)!.size).toBe(PDFJS_FILES.length);
  });

  it('are not kept in a browser without Cache Storage', async () => {
    vi.unstubAllGlobals();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect('caches' in window).toBe(false);
    await keepPdfjsResources();
    expect(fetch).not.toHaveBeenCalled();
  });
});
