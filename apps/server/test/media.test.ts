import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type BookDetail, type ClubDetail, type Edition, type Publication } from '@bookclub/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COVER_DRAWING } from '../src/ingest/covers';
import { sha256Hex } from '../src/lib/crypto';
import {
  ALICE_EPUB,
  ALICE_PDF,
  SYNTHETIC_AUDIO,
  type Client,
  type Res,
  type TestApp,
  audioTracks,
  closeApp,
  bookDetail,
  fileFrom,
  fileOf,
  makeEpub,
  makeTestApp,
  rawRequest,
  setupOwner,
  uploadBook,
} from './helpers';

const IMMUTABLE_PRIVATE = 'private, max-age=31536000, immutable';
const PRIVATE_DAY = 'private, max-age=86400';
const EPUB_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const RESOURCE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox";

/** v1 lesson: auth-gated media is never publicly cacheable, never cross-origin readable, never sniffed. */
function expectPrivateMedia(res: { headers: Record<string, string | string[] | undefined> }): void {
  const cache = String(res.headers['cache-control']);
  expect(cache).toContain('private');
  expect(cache).not.toContain('public');
  expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
}

describe('media', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let alice: BookDetail;
  let epub: Edition;
  let pub: Publication;
  let pdf: Edition;
  let audio: Edition;
  let plainBookId: string;
  let track: Uint8Array;
  let trackUrl: string;
  let etag: string;
  const seen: Res[] = [];

  /** GET and remember the response for the header sweep at the end. */
  const get = async (url: string, headers?: Record<string, string>) => {
    const res = await owner.get(url, headers);
    seen.push(res);
    return res;
  };

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    const a = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    const p = await uploadBook(owner, club.id, 'pdf', [fileFrom(ALICE_PDF, 'main', 'application/pdf')], { title: 'Alice PDF', author: 'Lewis Carroll' });
    const s = await uploadBook(owner, club.id, 'audio', audioTracks(SYNTHETIC_AUDIO), { title: 'The Synthetic Tale', author: 'Ada Tone' });
    plainBookId = (await uploadBook(owner, club.id, 'epub', [fileOf('plain.epub', makeEpub(['<p>No pictures here.</p>']), 'main', 'application/epub+zip')], { title: 'A Plain Book', author: 'Nobody' })).bookId;
    await t.settle();
    alice = await bookDetail(owner, a.bookId);
    epub = alice.editions[0]!;
    pub = await owner.json<Publication>(owner.get(epub.publicationUrl!), 200);
    pdf = (await bookDetail(owner, p.bookId)).editions[0]!;
    audio = (await bookDetail(owner, s.bookId)).editions[0]!;
    track = new Uint8Array(readFileSync(path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3')));
    trackUrl = audio.tracks[0]!.url;
    etag = `"${sha256Hex(track)}"`;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  describe('audio tracks', () => {
    it('serve the whole file with a strong ETag and byte ranges advertised', async () => {
      const res = await get(trackUrl);
      expect(res.statusCode).toBe(200);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.headers['content-length']).toBe(String(track.byteLength));
      expect(res.headers['cache-control']).toBe(IMMUTABLE_PRIVATE);
      expect(res.headers.etag).toBe(etag);
      expect(Buffer.from(res.bytes).equals(Buffer.from(track))).toBe(true);
      expectPrivateMedia(res);
    });

    it.each([
      ['a closed range', 'bytes=0-99', 0, 99],
      ['a range in the middle', 'bytes=1000-1999', 1000, 1999],
      ['an open-ended range', 'bytes=1000-', 1000, -1],
      ['a suffix range', 'bytes=-500', -500, -1],
      ['a range past the end (clamped)', 'bytes=100-99999999', 100, -1],
      ['two touching ranges (merged)', 'bytes=0-9, 10-19', 0, 19],
    ])('answer %s with 206 and exactly those bytes', async (_label, range, from, to) => {
      const size = track.byteLength;
      const start = from < 0 ? size + from : from;
      const end = to < 0 ? size - 1 : to;
      const res = await get(trackUrl, { range });
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes ${start}-${end}/${size}`);
      expect(res.headers['content-length']).toBe(String(end - start + 1));
      expect(Buffer.from(res.bytes).equals(Buffer.from(track.subarray(start, end + 1)))).toBe(true);
      expect(res.headers.etag).toBe(etag);
      expectPrivateMedia(res);
    });

    it('answer an unsatisfiable range with 416 and the size', async () => {
      for (const range of [`bytes=${track.byteLength}-`, 'bytes=99999999-99999999', 'bytes=-0']) {
        const res = await get(trackUrl, { range });
        expect(res.statusCode, range).toBe(416);
        expect(res.headers['content-range']).toBe(`bytes */${track.byteLength}`);
        expect(res.bytes.byteLength).toBe(0);
        expectPrivateMedia(res);
      }
    });

    it('ignore malformed or multi-part ranges and send the whole file', async () => {
      for (const range of ['bytes=abc', 'items=0-10', 'bytes=10-5', 'bytes=0-9,100-109']) {
        const res = await get(trackUrl, { range });
        expect(res.statusCode, range).toBe(200);
        expect(res.bytes.byteLength).toBe(track.byteLength);
      }
    });

    it('honour If-Range: the range only when the file is unchanged', async () => {
      const same = await get(trackUrl, { range: 'bytes=0-9', 'if-range': etag });
      expect(same.statusCode).toBe(206);
      for (const ifRange of ['"some-other-version"', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
        const changed = await get(trackUrl, { range: 'bytes=0-9', 'if-range': ifRange });
        expect(changed.statusCode).toBe(200);
        expect(changed.bytes.byteLength).toBe(track.byteLength);
      }
    });

    it('revalidate with If-None-Match (304) unless a range is asked for', async () => {
      const notModified = await get(trackUrl, { 'if-none-match': etag });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.bytes.byteLength).toBe(0);
      expect(notModified.headers.etag).toBe(etag);
      expectPrivateMedia(notModified);
      expect((await get(trackUrl, { 'if-none-match': '"stale"' })).statusCode).toBe(200);
      expect((await get(trackUrl, { 'if-none-match': etag, range: 'bytes=0-9' })).statusCode).toBe(206);
    });

    it('answer HEAD with the headers only', async () => {
      const head = await owner.request({ method: 'HEAD', url: trackUrl });
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-length']).toBe(String(track.byteLength));
      expect(head.headers['accept-ranges']).toBe('bytes');
      expectPrivateMedia(head);
      const ranged = await owner.request({ method: 'HEAD', url: trackUrl, headers: { range: 'bytes=0-99' } });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.headers['content-length']).toBe('100');
      expect(ranged.headers['content-range']).toBe(`bytes 0-99/${track.byteLength}`);
    });

    it('serve every track of the edition and nothing beyond it', async () => {
      for (const tr of audio.tracks) expect((await get(tr.url, { range: 'bytes=0-0' })).statusCode).toBe(206);
      for (const bad of ['3', '-1', 'first']) {
        expect((await owner.get(`/media/editions/${audio.id}/tracks/${bad}`)).statusCode, bad).toBe(404);
      }
      expect((await owner.get(`/media/editions/${pdf.id}/tracks/0`)).statusCode).toBe(404);
    });
  });

  describe('EPUB resources', () => {
    const chapterOne = () => pub.sections[pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section]!;

    it('serve documents as XHTML under a CSP that allows no script at all', async () => {
      const res = await get(`${pub.baseUrl}${chapterOne().href}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/xhtml+xml; charset=utf-8');
      const csp = res.headers['content-security-policy']!;
      expect(csp).toBe(EPUB_CSP);
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('script-src');
      expect(res.headers['cache-control']).toBe(IMMUTABLE_PRIVATE);
      expectPrivateMedia(res);
      const again = await get(`${pub.baseUrl}${chapterOne().href}`, { 'if-none-match': res.headers.etag! });
      expect(again.statusCode).toBe(304);
    });

    it('serve images and stylesheets with their own types, sandboxed should anyone open one on its own', async () => {
      const image = pub.resources.find((r) => /\.(jpe?g|png)$/i.test(r))!;
      const css = pub.resources.find((r) => r.endsWith('.css'))!;
      const img = await get(`${pub.baseUrl}${image}`);
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toMatch(/^image\/(jpeg|png)$/);
      expect(img.headers['content-security-policy']).toBe(RESOURCE_CSP);
      expectPrivateMedia(img);
      const style = await get(`${pub.baseUrl}${css}`);
      expect(style.statusCode).toBe(200);
      expect(style.headers['content-type']).toBe('text/css');
      expect(style.headers['content-security-policy']).toBe(RESOURCE_CSP);
      expectPrivateMedia(style);
    });

    it('serves a file whose name has a percent sign or a space in it', async () => {
      const css = 'p { color: gold; }\n'.repeat(80);
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf('pct.epub', makeEpub(['<p>Styled.</p>'], { extraFiles: { 'OEBPS/100% gold.css': css } }), 'main', 'application/epub+zip')], { title: 'Percent', author: 'X' });
      await t.settle();
      const edition = (await bookDetail(owner, bookId)).editions[0]!;
      const p = await owner.json<Publication>(owner.get(edition.publicationUrl!), 200);
      const resource = p.resources.find((r) => r.endsWith('.css'))!;
      expect(resource).toBe('OEBPS/100% gold.css');
      const res = await get(`${p.baseUrl}${resource.split('/').map(encodeURIComponent).join('/')}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(css);
    });

    it('never serves a file as a type an EPUB declared, even for a book ingested before that was decided', async () => {
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf('old.epub', makeEpub(['<p>Old ingest.</p>']), 'main', 'application/epub+zip')], { title: 'Old', author: 'X' });
      await t.settle();
      const old = (await bookDetail(owner, bookId)).editions[0]!;
      const oldPub = await owner.json<Publication>(owner.get(old.publicationUrl!), 200);
      const section = oldPub.sections[0]!.href;
      // What an older ingest stored: the types the EPUB's own manifest declared.
      const list = t.ctx.storage.pubFile(old.id, '.media-types.json')!;
      writeFileSync(list, JSON.stringify({ [section]: 'text/html;charset=utf-8', 'notes.txt': 'text/plain' }));
      writeFileSync(t.ctx.storage.pubFile(old.id, 'notes.txt')!, '<script>alert(1)</script>');
      const doc = await get(`${oldPub.baseUrl}${section}`);
      expect(doc.statusCode).toBe(200);
      expect(doc.headers['content-type']).toBe('application/xhtml+xml; charset=utf-8');
      expect(doc.headers['content-security-policy']).toBe(EPUB_CSP);
      expect((await owner.get(`${oldPub.baseUrl}notes.txt`)).statusCode).toBe(404);
    });

    it('answer 404 to path traversal attempts, never with the file', async () => {
      const cookie = owner.cookieHeader;
      const base = pub.baseUrl;
      const attempts = [
        `${base}../../bookclub.db`,
        `${base}..%2F..%2F..%2Fbookclub.db`,
        `${base}OEBPS/..%2F..%2F..%2F..%2Fbookclub.db`,
        `${base}OEBPS/../../../../../bookclub.db`,
        `${base}%2e%2e/%2e%2e/%2e%2e/bookclub.db`,
        `${base}%252e%252e%252f%252e%252e%252fbookclub.db`,
        `${base}%2Fetc%2Fpasswd`,
        `${base}OEBPS/../../../../../../../../etc/passwd`,
        // Decodes once to a malformed escape: refused, not an error.
        `${base}%25E0%25A4%25A`,
      ];
      for (const attempt of attempts) {
        const res = await rawRequest(t.baseUrl, 'GET', attempt, { cookie });
        expect(res.statusCode, attempt).toBe(404);
        expect(res.body).not.toContain('SQLite format');
        expect(res.body).not.toContain('root:');
      }
    });

    it('never serve the hidden manifest files or other dotfiles', async () => {
      expect(existsSync(t.ctx.storage.pubFile(epub.id, '.publication.json')!)).toBe(true);
      for (const name of ['.publication.json', '.media-types.json', 'OEBPS/.hidden', 'OEBPS/./x.xhtml']) {
        expect((await owner.get(`${pub.baseUrl}${name}`)).statusCode, name).toBe(404);
      }
      expect((await owner.get(`${pub.baseUrl}OEBPS/missing.xhtml`)).statusCode).toBe(404);
    });

    it('exist only for ready EPUB editions', async () => {
      expect((await owner.get(`/media/editions/${pdf.id}/epub/${chapterOne().href}`)).statusCode).toBe(404);
      expect((await owner.get(`/api/editions/${pdf.id}/publication`)).statusCode).toBe(404);
      expect((await owner.get(`/media/editions/missingEdition1/epub/${chapterOne().href}`)).statusCode).toBe(404);
    });
  });

  describe('book files', () => {
    it('serve the PDF inline with its name, its hash as ETag, and ranges', async () => {
      const bytes = readFileSync(ALICE_PDF);
      const res = await get(pdf.fileUrl!);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('inline; filename="alice.pdf"');
      expect(res.headers.etag).toBe(`"${sha256Hex(bytes)}"`);
      expect(Buffer.from(res.bytes).equals(bytes)).toBe(true);
      expectPrivateMedia(res);
      const head = await get(pdf.fileUrl!, { range: 'bytes=0-4' });
      expect(head.statusCode).toBe(206);
      expect(head.body).toBe('%PDF-');
    });

    it('serve the original EPUB as a download', async () => {
      const res = await get(`/media/editions/${epub.id}/file`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/epub+zip');
      expect(res.headers['content-disposition']).toBe('inline; filename="alice-gutenberg-11.epub"');
      expect(res.bytes.byteLength).toBe(readFileSync(ALICE_EPUB).byteLength);
      expectPrivateMedia(res);
    });

    it('do not exist for audiobooks', async () => {
      expect((await owner.get(`/media/editions/${audio.id}/file`)).statusCode).toBe(404);
    });
  });

  describe('covers', () => {
    it.each([160, 320, 640])('are WebP thumbnails %i px wide, cached privately', async (width) => {
      const res = await get(`/media/books/${alice.id}/cover?w=${width}&v=${alice.coverUrl.split('v=')[1]}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe(IMMUTABLE_PRIVATE);
      expectPrivateMedia(res);
      const meta = await sharp(res.bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', width, width * 1.5]);
      const blobId = t.ctx.db.get<{ cover_blob_id: string }>('SELECT cover_blob_id FROM books WHERE id = ?', [alice.id])!.cover_blob_id;
      expect(res.headers.etag).toBe(`"${blobId}-${width}-v${COVER_DRAWING}"`);
      expect(existsSync(path.join(t.ctx.storage.derivedDir, 'covers', `${blobId}-${width}-v${COVER_DRAWING}.webp`))).toBe(true);
    });

    it('snap other widths to the nearest size and are revalidated daily without a version', async () => {
      for (const [w, expected] of [
        ['1000', 640],
        ['abc', 320],
        ['100', 160],
      ] as const) {
        const res = await get(`/media/books/${alice.id}/cover?w=${w}`);
        expect((await sharp(res.bytes).metadata()).width, w).toBe(expected);
        expect(res.headers['cache-control']).toBe(PRIVATE_DAY);
      }
      const plain = await get(`/media/books/${alice.id}/cover`);
      expect((await sharp(plain.bytes).metadata()).width).toBe(320);
      expect((await get(`/media/books/${alice.id}/cover`, { 'if-none-match': plain.headers.etag! })).statusCode).toBe(304);
    });

    it.each([96, 192, 256, 384, 512])('are square artwork %i px for the lock screen, the whole cover on its own blurred ground (D190)', async (size) => {
      const res = await get(`/media/books/${alice.id}/cover?shape=square&w=${size}&v=${alice.coverUrl.split('v=')[1]}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe(IMMUTABLE_PRIVATE);
      expectPrivateMedia(res);
      const meta = await sharp(res.bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', size, size]);
      const blobId = t.ctx.db.get<{ cover_blob_id: string }>('SELECT cover_blob_id FROM books WHERE id = ?', [alice.id])!.cover_blob_id;
      expect(res.headers.etag).toBe(`"${blobId}-sq${size}-v${COVER_DRAWING}"`);
      // The cover is whole in the middle: its centre column is the cover, its corners the dark blur.
      const { data, info } = await sharp(res.bytes).raw().toBuffer({ resolveWithObject: true });
      const at = (x: number, y: number) => { const i = (y * info.width + x) * info.channels; return data[i]! + data[i + 1]! + data[i + 2]!; };
      expect(at(1, 1)).toBeLessThan(at(size >> 1, size >> 1) + 1);
    });

    it('snap other square sizes to the nearest, and square a generated cover too', async () => {
      for (const [w, expected] of [['1000', 512], ['abc', 512], ['50', 96], ['200', 256]] as const) {
        const res = await get(`/media/books/${alice.id}/cover?shape=square&w=${w}`);
        const meta = await sharp(res.bytes).metadata();
        expect([meta.width, meta.height], w).toEqual([expected, expected]);
      }
      const generated = await get(`/media/books/${plainBookId}/cover?v=generated&shape=square&w=384`);
      expect(generated.statusCode).toBe(200);
      const meta = await sharp(generated.bytes).metadata();
      expect([meta.width, meta.height]).toEqual([384, 384]);
      expect(generated.headers.etag).toMatch(/^"gen-[0-9a-f]{16}-sq384"$/);
    });

    it('are generated for a book without one', async () => {
      const book = await bookDetail(owner, plainBookId);
      expect(book.hasCover).toBe(false);
      expect(book.coverUrl).toBe(`/media/books/${plainBookId}/cover?v=generated`);
      const res = await get(book.coverUrl);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      // A generated cover changes with the title, so it is never cached as immutable.
      expect(res.headers['cache-control']).toBe(PRIVATE_DAY);
      expect(res.headers.etag).toMatch(/^"gen-[0-9a-f]{16}-320"$/);
      const meta = await sharp(res.bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 320, 480]);
      const key = res.headers.etag!.slice(5, 21);
      expect(existsSync(path.join(t.ctx.storage.derivedDir, 'covers', `gen-${key}-320.webp`))).toBe(true);
      // Renaming the book changes the generated cover.
      await owner.json(owner.patch(`/api/books/${plainBookId}`, { title: 'A Renamed Book' }), 200);
      expect((await get(book.coverUrl)).headers.etag).not.toBe(res.headers.etag);
    });

    it('are 404 for unknown books', async () => {
      expect((await owner.get('/media/books/unknownBook12/cover')).statusCode).toBe(404);
    });
  });

  it('every media response above was private, same-origin and nosniff', () => {
    expect(seen.length).toBeGreaterThan(30);
    for (const res of seen) expectPrivateMedia(res);
  });

  it('every successful media response above carries a CSP: sandboxed unless it is a page of the book', () => {
    const ok = seen.filter((res) => res.statusCode === 200 || res.statusCode === 206);
    expect(ok.length).toBeGreaterThan(20);
    for (const res of ok) {
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      if (!String(res.headers['content-type']).startsWith('application/xhtml+xml')) expect(csp.split('; ')).toContain('sandbox');
    }
  });
});
