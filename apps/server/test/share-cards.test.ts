import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeTestApp } from './helpers';

/** D213: the app shell's share-card meta carries this instance's own address, templated in. */
const SHELL = (
  '<!doctype html><html><head><title>Book Club</title>' +
  '<meta property="og:url" content="__PUBLIC_ORIGIN__/" />' +
  '<meta property="og:image" content="__PUBLIC_ORIGIN__/landing/og-image.png" />' +
  '</head><body><div id="root"></div></body></html>'
).repeat(1) + '<!-- padding -->'.repeat(100); // over MIN_COMPRESS_BYTES, like the real build's shell

interface Raw {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

function raw(baseUrl: string, urlPath: string, headers: Record<string, string> = {}): Promise<Raw> {
  const url = new URL(urlPath, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'GET', path: url.pathname + url.search, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const decode = (r: Raw): Buffer =>
  r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body;

describe('share-card meta in the app shell (D213)', () => {
  let base: string;

  function web(): string {
    return path.join(base, 'web');
  }

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), 'bookclub-share-'));
    mkdirSync(web(), { recursive: true });
    writeFileSync(path.join(web(), 'index.html'), SHELL);
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('templates the configured PUBLIC_ORIGIN into the share-card meta, absolute, and keeps compressing the shell', async () => {
    const t = await makeTestApp({ WEB_DIST: web(), PUBLIC_ORIGIN: 'https://books.example.org' });
    try {
      const res = await raw(t.baseUrl, '/', { 'accept-encoding': 'br' });
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('br');
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      const body = decode(res).toString();
      expect(body).toContain('<meta property="og:url" content="https://books.example.org/" />');
      expect(body).toContain('<meta property="og:image" content="https://books.example.org/landing/og-image.png" />');
      expect(body).not.toContain('__PUBLIC_ORIGIN__');
    } finally {
      await closeApp(t);
    }
  });

  it('without PUBLIC_ORIGIN set, falls back to the address the request actually arrived on', async () => {
    const t = await makeTestApp({ WEB_DIST: web() });
    try {
      const res = await raw(t.baseUrl, '/');
      const body = res.body.toString();
      expect(body).toContain(`<meta property="og:url" content="${t.baseUrl}/" />`);
    } finally {
      await closeApp(t);
    }
  });

  it('a client that accepts neither encoding gets the plain, templated body', async () => {
    const t = await makeTestApp({ WEB_DIST: web(), PUBLIC_ORIGIN: 'https://books.example.org' });
    try {
      const res = await raw(t.baseUrl, '/');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString()).toContain('https://books.example.org/landing/og-image.png');
    } finally {
      await closeApp(t);
    }
  });

  it('a crafted Host header cannot break out of the attribute it is templated into (D213)', async () => {
    // PUBLIC_ORIGIN unset (the documented default): publicOrigin() falls back to the request's
    // own Host, which is whatever the client sent, not something this server can trust by shape
    // alone. Each payload tries a different way out of `content="__PUBLIC_ORIGIN__/..."`.
    const t = await makeTestApp({ WEB_DIST: web() });
    try {
      const payloads = [
        'evil.example"><meta http-equiv="refresh" content="0;url=http://evil.example/">',
        "evil.example'><script>1</script>",
        'evil.example" onmouseover="alert(1)',
      ];
      for (const host of payloads) {
        const res = await raw(t.baseUrl, '/', { Host: host });
        const body = res.body.toString();
        expect(body, host).not.toContain('<meta http-equiv');
        expect(body, host).not.toContain('<script>');
        expect(body, host).not.toContain('onmouseover');
        // Nothing of the payload reached the page unescaped; it fell back to the relative address.
        expect(body, host).toContain('<meta property="og:url" content="/" />');
        expect(body, host).toContain('<meta property="og:image" content="/landing/og-image.png" />');
      }
    } finally {
      await closeApp(t);
    }
  });

  it('a normal Host still yields the right absolute og:url when PUBLIC_ORIGIN is unset', async () => {
    const t = await makeTestApp({ WEB_DIST: web() });
    try {
      const res = await raw(t.baseUrl, '/', { Host: 'books.example.org:4443' });
      const body = res.body.toString();
      expect(body).toContain('<meta property="og:url" content="http://books.example.org:4443/" />');
    } finally {
      await closeApp(t);
    }
  });

  it('is marked Vary: Host when the body depends on it (no PUBLIC_ORIGIN), and not when it does not', async () => {
    const dependent = await makeTestApp({ WEB_DIST: web() });
    const fixed = await makeTestApp({ WEB_DIST: web(), PUBLIC_ORIGIN: 'https://books.example.org' });
    try {
      expect((await raw(dependent.baseUrl, '/')).headers['vary']).toBe('Accept-Encoding, Host');
      expect((await raw(fixed.baseUrl, '/')).headers['vary']).toBe('Accept-Encoding');
    } finally {
      await closeApp(dependent);
      await closeApp(fixed);
    }
  });
});
