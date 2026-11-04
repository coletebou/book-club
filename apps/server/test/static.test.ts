import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, makeTestApp, rawRequest, closeApp } from './helpers';

const INDEX = '<!doctype html><html lang="en"><head><title>Book Club</title></head><body><div id="root"></div></body></html>';
const APP_JS = 'console.log("the app");';
const SW_JS = "self.addEventListener('fetch', () => {});";

describe('serving the web app', () => {
  let t: TestApp;
  let base: string;

  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'bookclub-static-'));
    const web = path.join(base, 'web');
    mkdirSync(path.join(web, 'assets'), { recursive: true });
    writeFileSync(path.join(web, 'index.html'), INDEX);
    writeFileSync(path.join(web, 'assets', 'app-123.js'), APP_JS);
    writeFileSync(path.join(web, 'assets', 'style-abc.css'), 'body { color: gold; }');
    writeFileSync(path.join(web, 'sw.js'), SW_JS);
    writeFileSync(path.join(web, 'manifest.webmanifest'), '{"name":"Book Club"}');
    writeFileSync(path.join(web, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(path.join(web, 'data.bin'), 'binary-ish');
    writeFileSync(path.join(web, 'empty.txt'), '');
    // pdf.js's decoders, fonts, maps and colour profile, as the web build copies them (apps/web/pdfjs-resources.ts).
    for (const file of ['wasm/openjpeg.wasm', 'wasm/openjpeg_nowasm_fallback.js', 'standard_fonts/FoxitSerif.pfb', 'standard_fonts/LiberationSans-Regular.ttf', 'cmaps/UniJIS-UCS2-H.bcmap', 'iccs/CGATS001Compat-v2-micro.icc']) {
      mkdirSync(path.join(web, 'assets', 'pdfjs-6.4.299', path.dirname(file)), { recursive: true });
      writeFileSync(path.join(web, 'assets', 'pdfjs-6.4.299', file), `bytes of ${file}`);
    }
    // Files next to the web root that must never be reachable through it.
    writeFileSync(path.join(base, 'secret.txt'), 'TOP SECRET');
    mkdirSync(path.join(base, 'web-private'));
    writeFileSync(path.join(base, 'web-private', 'secret.txt'), 'TOP SECRET');
    t = await makeTestApp({ WEB_DIST: web });
  });

  afterAll(async () => {
    await closeApp(t);
    rmSync(base, { recursive: true, force: true });
  });

  const expectShell = (res: { statusCode: number; headers: Record<string, string>; body: string }) => {
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toBe(INDEX);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'");
  };

  it('serves the app shell at / under a strict CSP, revalidated on every load', async () => {
    const res = await t.client().get('/');
    expectShell(res);
    const csp = res.headers['content-security-policy']!.split('; ');
    expect(csp).toEqual(
      expect.arrayContaining([
        "default-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        `connect-src 'self' ${t.baseUrl.replace(/^http/, 'ws')}`,
      ]),
    );
    expect(csp.some((d) => d.startsWith('script-src') && d.includes('unsafe-inline'))).toBe(false);
  });

  it('answers app routes with the shell, for client-side routing', async () => {
    for (const route of ['/join/abc123', '/clubs/x/books/y', '/reset/some-token', '/?v=1', '/assets']) {
      expectShell(await t.client().get(route));
    }
  });

  it('serves hashed assets as immutable', async () => {
    const js = await t.client().get('/assets/app-123.js?cache-bust=1');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['content-security-policy']).toBeUndefined();
    expect(js.body).toBe(APP_JS);
    const css = await t.client().get('/assets/style-abc.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('serves pdf.js’s decoders, fonts, maps and colour profile from the app, immutable, as what they are (fidelity review round 17)', async () => {
    for (const [file, type] of [
      ['wasm/openjpeg.wasm', 'application/wasm'],
      // Imported by pdf.js's worker as a module where WebAssembly cannot run: a script's type.
      ['wasm/openjpeg_nowasm_fallback.js', 'text/javascript; charset=utf-8'],
      ['standard_fonts/FoxitSerif.pfb', 'application/octet-stream'],
      ['standard_fonts/LiberationSans-Regular.ttf', 'font/ttf'],
      ['cmaps/UniJIS-UCS2-H.bcmap', 'application/octet-stream'],
      ['iccs/CGATS001Compat-v2-micro.icc', 'application/vnd.iccprofile'],
    ]) {
      const res = await t.client().get(`/assets/pdfjs-6.4.299/${file}`);
      expect(res.statusCode, file).toBe(200);
      expect(res.headers['content-type'], file).toBe(type);
      expect(res.headers['cache-control'], file).toBe('public, max-age=31536000, immutable');
      expect(res.body, file).toBe(`bytes of ${file}`);
    }
  });

  it('serves the service worker uncached, allowed to control the whole origin', async () => {
    const res = await t.client().get('/sw.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['service-worker-allowed']).toBe('/');
    expect(res.body).toBe(SW_JS);
  });

  it('serves other root files with their types', async () => {
    expect((await t.client().get('/manifest.webmanifest')).headers['content-type']).toBe('application/manifest+json');
    expect((await t.client().get('/favicon.svg')).headers['content-type']).toBe('image/svg+xml');
    expect((await t.client().get('/data.bin')).headers['content-type']).toBe('application/octet-stream');
  });

  it('answers a missing file with an extension with a real 404, not the shell', async () => {
    for (const missing of ['/assets/x.js', '/favicon.png', '/assets/app-999.css']) {
      const res = await t.client().get(missing);
      expect(res.statusCode, missing).toBe(404);
      expect(res.body).not.toContain('<div id="root">');
    }
  });

  it('never answers API, media or socket paths with the shell', async () => {
    for (const url of ['/api/unknown', '/media/unknown/thing', '/api/books/x/y/z']) {
      const res = await t.client().get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
    const post = await t.client().post('/api/unknown', {});
    expect(post.statusCode).toBe(404);
    expect(post.json()).toEqual({ error: { code: 'not_found', message: 'No route for POST /api/unknown' } });
    expect((await t.client().get('/ws')).statusCode).toBe(404);
    expect((await t.client().get('/api/session')).json()).toMatchObject({ user: null, setupRequired: true });
  });

  it('never serves files outside the web root', async () => {
    for (const attempt of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/../web-private/secret.txt', '/%2e%2e%2fweb-private%2fsecret.txt']) {
      const res = await rawRequest(t.baseUrl, 'GET', attempt);
      expect(res.statusCode, attempt).toBe(404);
      expect(res.body).not.toContain('TOP SECRET');
    }
  });

  it('answers HEAD with the real length, and ranges like any file', async () => {
    const head = await t.client().request({ method: 'HEAD', url: '/' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(INDEX)));
    const headAsset = await t.client().request({ method: 'HEAD', url: '/assets/app-123.js' });
    expect(headAsset.headers['content-length']).toBe(String(Buffer.byteLength(APP_JS)));
    // An empty file is a 200 with an empty body, by GET and by HEAD.
    const empty = await t.client().get('/empty.txt');
    expect([empty.statusCode, empty.headers['content-length'], empty.body]).toEqual([200, '0', '']);
    expect((await t.client().request({ method: 'HEAD', url: '/empty.txt' })).headers['content-length']).toBe('0');
    const ranged = await t.client().get('/assets/app-123.js', { range: 'bytes=0-6' });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('console');
  });

  it('adds the security headers to everything it serves', async () => {
    for (const url of ['/', '/assets/app-123.js', '/sw.js']) {
      const res = await t.client().get(url);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      // camera and microphone are allowed from this app's own pages only (D140: media notes).
      expect(res.headers['permissions-policy']).toContain('camera=(self)');
    }
  });
});

describe('without a web build', () => {
  it('serves only the API: unknown paths are JSON 404s', async () => {
    const t = await makeTestApp();
    try {
      const res = await t.client().get('/some/page?with=query');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No route for GET /some/page' } });
    } finally {
      await closeApp(t);
    }
  });
});
