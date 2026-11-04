import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { type ClubDetail, type Edition, type Publication } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compressedCopy, isCompressible, preferredEncoding } from '../src/lib/compress';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, makeTestApp, setupOwner, uploadBook } from './helpers';

interface Raw {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A request with exactly these headers and the body exactly as sent (fetch would decode it). */
function raw(baseUrl: string, urlPath: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Raw> {
  const url = new URL(urlPath, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: url.pathname + url.search, headers }, (res) => {
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

describe('content negotiation', () => {
  it('prefers brotli, then gzip, and honours q=0 and wildcards', () => {
    expect(preferredEncoding(undefined)).toBeNull();
    expect(preferredEncoding('')).toBeNull();
    expect(preferredEncoding('gzip, deflate, br, zstd')).toBe('br');
    expect(preferredEncoding('gzip, deflate')).toBe('gzip');
    expect(preferredEncoding('BR')).toBe('br');
    expect(preferredEncoding('br;q=0, gzip;q=0.5')).toBe('gzip');
    expect(preferredEncoding('br;q=0, gzip;q=0')).toBeNull();
    expect(preferredEncoding('identity')).toBeNull();
    expect(preferredEncoding('deflate')).toBeNull();
    expect(preferredEncoding('*')).toBe('br');
    expect(preferredEncoding('*;q=0')).toBeNull();
    expect(preferredEncoding('*, br;q=0')).toBe('gzip');
    expect(preferredEncoding('gzip;q=garbage, br;q=0')).toBeNull();
  });

  it('compresses text only: markup, styles, scripts, JSON and SVG, never media or archives', () => {
    for (const type of ['text/html; charset=utf-8', 'text/css', 'text/javascript; charset=utf-8', 'application/json', 'application/xhtml+xml; charset=utf-8', 'image/svg+xml', 'application/manifest+json', 'application/wasm']) {
      expect(isCompressible(type)).toBe(true);
    }
    for (const type of ['audio/mpeg', 'audio/mp4', 'image/webp', 'image/jpeg', 'application/pdf', 'application/epub+zip', 'application/octet-stream', 'font/woff2']) {
      expect(isCompressible(type)).toBe(false);
    }
  });
});

describe('compressed copies next to the file', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bookclub-z-'));
  });
  afterAll(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes a copy once, reuses it, and remakes it when the file is newer', async () => {
    const file = path.join(dir, 'chapter.xhtml');
    writeFileSync(file, '<p>Down the rabbit hole.</p>'.repeat(200));
    const first = await compressedCopy(file, 'br');
    expect(first?.path).toBe(`${file}.br`);
    expect(zlib.brotliDecompressSync(readFileSync(first!.path)).toString()).toBe(readFileSync(file, 'utf8'));
    const madeAt = statSync(first!.path).mtimeMs;
    const again = await compressedCopy(file, 'br');
    expect(statSync(again!.path).mtimeMs).toBe(madeAt);

    writeFileSync(file, '<p>The pool of tears.</p>'.repeat(200));
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    const remade = await compressedCopy(file, 'br');
    expect(zlib.brotliDecompressSync(readFileSync(remade!.path)).toString()).toContain('pool of tears');
  });

  it('makes one copy for many simultaneous requests, and gzip next to brotli', async () => {
    const file = path.join(dir, 'style.css');
    writeFileSync(file, 'p { color: gold; }\n'.repeat(500));
    const copies = await Promise.all(Array.from({ length: 8 }, () => compressedCopy(file, 'gzip')));
    expect(new Set(copies.map((c) => c?.path))).toEqual(new Set([`${file}.gz`]));
    expect(zlib.gunzipSync(readFileSync(`${file}.gz`)).toString()).toBe(readFileSync(file, 'utf8'));
  });

  it('gives up quietly where it cannot write (a read-only build directory)', async () => {
    const ro = path.join(dir, 'ro');
    mkdirSync(ro);
    const file = path.join(ro, 'app.js');
    writeFileSync(file, 'console.log("x");\n'.repeat(500));
    chmodSync(ro, 0o555);
    expect(await compressedCopy(file, 'br')).toBeNull();
    chmodSync(ro, 0o755);
  });
});

describe('compressed responses', () => {
  let t: TestApp;
  let base: string;
  let owner: Client;
  let club: ClubDetail;
  let epub: Edition;
  let pub: Publication;
  let cookie: string;
  const APP_JS = `export const story = ${JSON.stringify('Alice was beginning to get very tired of sitting by her sister on the bank. '.repeat(100))};\n`;

  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'bookclub-zweb-'));
    const web = path.join(base, 'web');
    mkdirSync(path.join(web, 'assets'), { recursive: true });
    writeFileSync(path.join(web, 'index.html'), `<!doctype html><html><head><title>Book Club</title></head><body>${'<div></div>'.repeat(200)}</body></html>`);
    writeFileSync(path.join(web, 'assets', 'app-1.js'), APP_JS);
    // As the web build leaves them: precompressed copies next to the asset.
    writeFileSync(path.join(web, 'assets', 'app-1.js.br'), zlib.brotliCompressSync(APP_JS));
    writeFileSync(path.join(web, 'assets', 'app-1.js.gz'), zlib.gzipSync(APP_JS));
    writeFileSync(path.join(web, 'assets', 'tiny-1.css'), 'p{color:gold}');
    writeFileSync(path.join(web, 'assets', 'icon-1.png'), Buffer.alloc(4096, 7));
    t = await makeTestApp({ WEB_DIST: web });
    ({ owner, club } = await setupOwner(t));
    const a = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    await t.settle();
    epub = (await bookDetail(owner, a.bookId)).editions[0]!;
    pub = await owner.json<Publication>(owner.get(epub.publicationUrl!), 200);
    cookie = owner.cookieHeader;
  });

  afterAll(async () => {
    await closeApp(t);
    rmSync(base, { recursive: true, force: true });
  });

  it('sends the build’s brotli or gzip copy of an asset, and the file itself to clients that accept neither', async () => {
    const br = await raw(t.baseUrl, '/assets/app-1.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['vary']).toBe('Accept-Encoding');
    expect(br.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(Number(br.headers['content-length'])).toBe(br.body.length);
    expect(br.body.equals(readFileSync(path.join(base, 'web', 'assets', 'app-1.js.br')))).toBe(true);
    expect(br.body.length).toBeLessThan(APP_JS.length / 5);

    const gz = await raw(t.baseUrl, '/assets/app-1.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(decode(gz).toString()).toBe(APP_JS);

    const plain = await raw(t.baseUrl, '/assets/app-1.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers['vary']).toBe('Accept-Encoding');
    expect(plain.headers['accept-ranges']).toBe('bytes');
    expect(plain.body.toString()).toBe(APP_JS);
  });

  it('gives each encoding its own validator and answers revalidation with 304', async () => {
    const br = await raw(t.baseUrl, '/assets/app-1.js', { 'accept-encoding': 'br' });
    const gz = await raw(t.baseUrl, '/assets/app-1.js', { 'accept-encoding': 'gzip' });
    const plain = await raw(t.baseUrl, '/assets/app-1.js');
    const tags = [br, gz, plain].map((r) => String(r.headers.etag));
    expect(new Set(tags).size).toBe(3);
    expect(tags[0]).toMatch(/-br"$/);
    expect(tags[1]).toMatch(/-gz"$/);
    const again = await raw(t.baseUrl, '/assets/app-1.js', { 'accept-encoding': 'br', 'if-none-match': tags[0]! });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    // A validator of another encoding does not match this one.
    expect((await raw(t.baseUrl, '/assets/app-1.js', { 'accept-encoding': 'br', 'if-none-match': tags[2]! })).status).toBe(200);
    expect((await raw(t.baseUrl, '/assets/app-1.js', { 'if-none-match': tags[2]! })).status).toBe(304);
  });

  it('answers a byte range from the file itself, never from a compressed copy', async () => {
    const res = await raw(t.baseUrl, '/assets/app-1.js', { 'accept-encoding': 'br', range: 'bytes=0-9' });
    expect(res.status).toBe(206);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['content-range']).toBe(`bytes 0-9/${APP_JS.length}`);
    expect(res.body.toString()).toBe(APP_JS.slice(0, 10));
  });

  it('compresses the app shell (made on first use), but not tiny files or images', async () => {
    const shell = await raw(t.baseUrl, '/clubs/anything', { 'accept-encoding': 'br' });
    expect(shell.headers['content-encoding']).toBe('br');
    expect(shell.headers['content-security-policy']).toContain("default-src 'self'");
    expect(decode(shell).toString()).toContain('<title>Book Club</title>');
    const tiny = await raw(t.baseUrl, '/assets/tiny-1.css', { 'accept-encoding': 'br' });
    expect(tiny.headers['content-encoding']).toBeUndefined();
    expect(tiny.headers['vary']).toBeUndefined();
    const png = await raw(t.baseUrl, '/assets/icon-1.png', { 'accept-encoding': 'br' });
    expect(png.headers['content-encoding']).toBeUndefined();
    expect(png.body.length).toBe(4096);
  });

  it('compresses book chapters, keeps a copy with the book, and still serves ranges and privacy headers', async () => {
    const section = pub.sections.find((s) => s.textLength > 5000)!;
    const url = `/media/editions/${epub.id}/epub/${section.href}`;
    const file = t.ctx.storage.pubFile(epub.id, section.href)!;
    const br = await raw(t.baseUrl, url, { 'accept-encoding': 'gzip, br', cookie });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-security-policy']).toContain("default-src 'none'");
    expect(br.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(br.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(decode(br).equals(readFileSync(file))).toBe(true);
    expect(existsSync(`${file}.br`)).toBe(true);

    const ranged = await raw(t.baseUrl, url, { 'accept-encoding': 'br', range: 'bytes=0-99', cookie });
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-encoding']).toBeUndefined();
    expect(ranged.body.equals(readFileSync(file).subarray(0, 100))).toBe(true);
    // Without a session the copy is no way round the membership check.
    expect((await raw(t.baseUrl, url, { 'accept-encoding': 'br' })).status).toBe(401);
  });

  it('compresses JSON answers of a kilobyte or more, and leaves small ones alone', async () => {
    const plain = await raw(t.baseUrl, epub.publicationUrl!, { cookie });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers['vary']).toBe('Accept-Encoding');
    const br = await raw(t.baseUrl, epub.publicationUrl!, { cookie, 'accept-encoding': 'br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toMatch(/^application\/json/);
    expect(br.body.length).toBeLessThan(plain.body.length / 2);
    expect(JSON.parse(decode(br).toString())).toEqual(JSON.parse(plain.body.toString()));
    const gz = await raw(t.baseUrl, epub.publicationUrl!, { cookie, 'accept-encoding': 'gzip' });
    expect(JSON.parse(decode(gz).toString())).toEqual(pub);

    const small = await raw(t.baseUrl, '/api/session', { 'accept-encoding': 'br' });
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(small.body.toString())).toMatchObject({ user: null });
  });
});
