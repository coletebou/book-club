import { existsSync, readFileSync, readdirSync, rmSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { ApiErrorSchema, ImportSchema, MAX_COVER_BYTES, type ClubDetail, type Import } from '@bookclub/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeBook } from '../src/services/removal';
import { sha256Hex } from '../src/lib/crypto';
import { cleanUpUploads, createTus } from '../src/routes/imports';
import {
  ALICE_EPUB,
  SYNTHETIC_AUDIO,
  type Client,
  type Res,
  type TestApp,
  type UploadFile,
  audioTracks,
  closeApp,
  bookDetail,
  createImport,
  fileFrom,
  fileOf,
  joinClub,
  makeEpub,
  makeTestApp,
  outsider,
  setupOwner,
  tusCreate,
  tusCreateRequest,
  tusHead,
  tusPatch,
  uploadAll,
  uploadBook,
  waitUntil,
} from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;
const uploadIdOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);
const MAX_UPLOAD = 5_000_000;

describe('uploads and imports', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ozzy: Client;
  let epub: UploadFile;

  beforeAll(async () => {
    t = await makeTestApp({ MAX_UPLOAD_BYTES: String(MAX_UPLOAD) });
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ozzy = await outsider(t, owner, 'Ozzy');
    epub = fileFrom(ALICE_EPUB, 'main', 'application/epub+zip');
  });

  afterAll(async () => {
    await closeApp(t);
  });

  const importOf = async (c: Client, id: string) => ImportSchema.parse(await c.json(c.get(`/api/imports/${id}`), 200));
  const finalize = (c: Client, id: string, body: Record<string, unknown> = { title: 'A Book', author: 'Someone' }) =>
    c.post(`/api/imports/${id}/finalize`, body);
  const bookCount = async () => (await owner.json<unknown[]>(owner.get(`/api/clubs/${club.id}/books`), 200)).length;

  describe('declaring an import', () => {
    it('reports a fresh import with every declared file still to upload', async () => {
      const cover = fileOf('cover.jpg', 'jpeg bytes', 'cover', 'image/jpeg');
      const imp = ImportSchema.parse(await createImport(owner, club.id, 'epub', [epub, cover]));
      expect(imp).toMatchObject({ clubId: club.id, kind: 'epub', status: 'uploading' });
      expect(imp.files).toEqual([
        { index: 0, name: 'alice-gutenberg-11.epub', size: epub.bytes.byteLength, role: 'main', uploadId: null, offset: 0, complete: false },
        { index: 1, name: 'cover.jpg', size: 10, role: 'cover', uploadId: null, offset: 0, complete: false },
      ]);
      expect(await importOf(owner, imp.id)).toEqual(imp);
    });

    const f = (name: string, role: string, size = 10) => ({ name, size, type: 'application/octet-stream', role });
    it.each([
      ['an EPUB without its book file', { kind: 'epub', files: [f('cover.jpg', 'cover')] }, 'Choose one EPUB file.'],
      ['an EPUB with two book files', { kind: 'epub', files: [f('a.epub', 'main'), f('b.epub', 'main')] }, 'Choose one EPUB file.'],
      ['a PDF declared as a track', { kind: 'pdf', files: [f('a.pdf', 'track')] }, 'Ebook files must be the main file.'],
      ['an audiobook with a non-track file', { kind: 'audio', files: [f('01.mp3', 'track'), f('book.epub', 'main')] }, 'Audiobook files must be tracks.'],
      ['two cover images', { kind: 'audio', files: [f('01.mp3', 'track'), f('a.jpg', 'cover'), f('b.jpg', 'cover')] }, 'Choose at most one cover image.'],
      ['no files at all', { kind: 'audio', files: [] }, undefined],
      ['an unknown format', { kind: 'mobi', files: [f('a.mobi', 'main')] }, undefined],
      ['a negative size', { kind: 'pdf', files: [f('a.pdf', 'main', -1)] }, undefined],
    ])('refuses %s (400)', async (_label, body, message) => {
      const res = await owner.post(`/api/clubs/${club.id}/imports`, body);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('bad_request');
      if (message) expect(errorOf(res).message).toBe(message);
    });

    it(`refuses a cover image declared larger than ${MAX_COVER_BYTES} bytes, which no track is held to`, async () => {
      const declare = (trackSize: number, coverSize: number) =>
        owner.post(`/api/clubs/${club.id}/imports`, {
          kind: 'audio',
          files: [
            { name: '01.mp3', size: trackSize, type: 'audio/mpeg', role: 'track' },
            { name: 'scan.png', size: coverSize, type: 'image/png', role: 'cover' },
          ],
        });
      const res = await declare(10, MAX_COVER_BYTES + 1);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({ message: 'A cover image can be at most 32 MB.', fields: { 'files.1.size': 'A cover image can be at most 32 MB.' } });
      expect((await declare(MAX_COVER_BYTES + 1, MAX_COVER_BYTES)).statusCode).toBe(201);
    });

    it('only members of the club can declare imports in it', async () => {
      const body = { kind: 'epub', files: [{ name: 'a.epub', size: 1, type: '', role: 'main' }] };
      expect((await ozzy.post(`/api/clubs/${club.id}/imports`, body)).statusCode).toBe(404);
      expect((await t.client().post(`/api/clubs/${club.id}/imports`, body)).statusCode).toBe(401);
      expect((await ana.post(`/api/clubs/${club.id}/imports`, body)).statusCode).toBe(201);
    });
  });

  describe('tus uploads', () => {
    it('checks the declared size when an upload is created', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      const res = await tusCreateRequest(owner, { importId: imp.id, fileIndex: '0', filename: epub.name }, epub.bytes.byteLength + 1);
      expect(res.statusCode).toBe(400);
      expect(res.body).toBe('Size of alice-gutenberg-11.epub does not match.');
    });

    it('refuses unknown files and unknown imports', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      const unknownFile = await tusCreateRequest(owner, { importId: imp.id, fileIndex: '7' }, 10);
      expect([unknownFile.statusCode, unknownFile.body]).toEqual([400, 'Unknown file.']);
      expect((await tusCreateRequest(owner, { importId: imp.id, fileIndex: 'first' }, 10)).statusCode).toBe(400);
      const noImport = await tusCreateRequest(owner, { fileIndex: '0' }, 10);
      expect([noImport.statusCode, noImport.body]).toEqual([404, 'Upload session not found.']);
      expect((await tusCreateRequest(owner, { importId: 'doesnotexist1', fileIndex: '0' }, 10)).statusCode).toBe(404);
    });

    it('nobody can upload into someone else’s import, not even a fellow member', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      for (const c of [ana, ozzy]) {
        const res = await tusCreateRequest(c, { importId: imp.id, fileIndex: '0' }, epub.bytes.byteLength);
        expect([res.statusCode, res.body]).toEqual([404, 'Upload session not found.']);
      }
      expect((await tusCreateRequest(t.client(), { importId: imp.id, fileIndex: '0' }, epub.bytes.byteLength)).statusCode).toBe(401);
      expect((await importOf(owner, imp.id)).files[0]!.uploadId).toBeNull();
    });

    it('nobody else can look at or write to someone’s upload (404)', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      const url = await tusCreate(owner, imp.id, 0, epub);
      const onDisk = path.join(t.ctx.storage.uploadsDir, uploadIdOf(url));
      for (const c of [ana, ozzy]) {
        expect((await tusHead(c, url)).statusCode).toBe(404);
        expect((await tusPatch(c, url, epub.bytes.subarray(0, 1000), 0)).statusCode).toBe(404);
        expect((await c.request({ method: 'DELETE', url, headers: { 'tus-resumable': '1.0.0' } })).statusCode).toBe(404);
      }
      expect((await tusHead(t.client(), url)).statusCode).toBe(401);
      expect(readFileSync(onDisk).byteLength).toBe(0);
      const head = await tusHead(owner, url);
      expect([head.statusCode, head.headers['upload-offset']]).toEqual([200, '0']);
    });

    it('a member removed from the club cannot go on sending an upload they had started (SA25)', async () => {
      const rhea = await joinClub(t, club, 'Rhea Removed');
      const rheaId = (await rhea.json<{ user: { id: string } }>(rhea.get('/api/me'), 200)).user.id;
      const imp = await createImport(rhea, club.id, 'epub', [epub]);
      const url = await tusCreate(rhea, imp.id, 0, epub);
      const half = Math.floor(epub.bytes.byteLength / 2);
      expect((await tusPatch(rhea, url, epub.bytes.subarray(0, half), 0)).statusCode).toBe(204);
      expect((await owner.delete(`/api/clubs/${club.id}/members/${rheaId}`)).statusCode).toBe(204);
      expect((await tusPatch(rhea, url, epub.bytes.subarray(half), half)).statusCode).toBe(404);
      expect((await tusHead(rhea, url)).statusCode).toBe(404);
      // Nothing more was written.
      expect(readFileSync(path.join(t.ctx.storage.uploadsDir, uploadIdOf(url))).byteLength).toBe(half);
    });

    it('an interrupted upload resumes from the offset the server reports, byte for byte', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      const url = await tusCreate(owner, imp.id, 0, epub);
      const half = Math.floor(epub.bytes.byteLength / 2);

      const first = await tusPatch(owner, url, epub.bytes.subarray(0, half), 0);
      expect([first.statusCode, first.headers['upload-offset']]).toEqual([204, String(half)]);
      // The client lost its state: it asks the server where to continue.
      const head = await tusHead(owner, url);
      expect(head.statusCode).toBe(200);
      expect(head.headers['upload-offset']).toBe(String(half));
      expect(head.headers['upload-length']).toBe(String(epub.bytes.byteLength));
      expect((await importOf(owner, imp.id)).files[0]).toMatchObject({ uploadId: uploadIdOf(url), offset: half, complete: false });

      const rest = await tusPatch(owner, url, epub.bytes.subarray(Number(head.headers['upload-offset'])), Number(head.headers['upload-offset']));
      expect([rest.statusCode, rest.headers['upload-offset']]).toEqual([204, String(epub.bytes.byteLength)]);
      expect((await importOf(owner, imp.id)).files[0]).toMatchObject({ offset: epub.bytes.byteLength, complete: true });
      expect(sha256Hex(readFileSync(path.join(t.ctx.storage.uploadsDir, uploadIdOf(url))))).toBe(sha256Hex(epub.bytes));

      const { bookId, editionId } = await owner.json<{ bookId: string; editionId: string }>(finalize(owner, imp.id, { title: 'Resumed', author: 'Lewis Carroll' }), 201);
      await t.settle();
      const book = await bookDetail(owner, bookId);
      expect(book.editions[0]).toMatchObject({ id: editionId, status: 'ready', sizeBytes: epub.bytes.byteLength });
      const blob = t.ctx.db.get<{ sha256: string }>('SELECT b.sha256 FROM edition_files f JOIN blobs b ON b.id = f.blob_id WHERE f.edition_id = ?', [editionId]);
      expect(blob?.sha256).toBe(sha256Hex(epub.bytes));
      expect(existsSync(path.join(t.ctx.storage.uploadsDir, uploadIdOf(url)))).toBe(false);
      expect(existsSync(path.join(t.ctx.storage.uploadsDir, `${uploadIdOf(url)}.json`))).toBe(false);
    });

    it('never takes a file twice, and a new attempt replaces an unfinished one', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      const stale = await tusCreate(owner, imp.id, 0, epub);
      await tusPatch(owner, stale, epub.bytes.subarray(0, 1000), 0);
      // The client lost its upload URL and starts the file again: the unfinished upload goes.
      const fresh = await tusCreate(owner, imp.id, 0, epub);
      expect((await tusHead(owner, stale)).statusCode).toBe(404);
      expect(existsSync(path.join(t.ctx.storage.uploadsDir, uploadIdOf(stale)))).toBe(false);
      expect((await importOf(owner, imp.id)).files[0]).toMatchObject({ uploadId: uploadIdOf(fresh), offset: 0, complete: false });
      expect((await tusPatch(owner, fresh, epub.bytes, 0)).statusCode).toBe(204);
      // Once received, the file is not accepted again.
      const twice = await tusCreateRequest(owner, { importId: imp.id, fileIndex: '0' }, epub.bytes.byteLength);
      expect([twice.statusCode, twice.body]).toEqual([409, 'alice-gutenberg-11.epub is already uploaded.']);
      expect((await importOf(owner, imp.id)).files[0]).toMatchObject({ uploadId: uploadIdOf(fresh), complete: true });
      expect((await finalize(owner, imp.id)).statusCode).toBe(201);
      await t.settle();
    });

    it('refuses a chunk at the wrong offset (409) without writing it', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      const url = await tusCreate(owner, imp.id, 0, epub);
      await tusPatch(owner, url, epub.bytes.subarray(0, 1000), 0);
      const wrong = await tusPatch(owner, url, epub.bytes.subarray(2000, 3000), 2000);
      expect(wrong.statusCode).toBe(409);
      expect((await tusHead(owner, url)).headers['upload-offset']).toBe('1000');
    });

    it('refuses an upload larger than MAX_UPLOAD_BYTES (413)', async () => {
      const big = { name: 'huge.epub', bytes: new Uint8Array(0), type: 'application/epub+zip', role: 'main' as const };
      const imp = await owner.json<Import>(
        owner.post(`/api/clubs/${club.id}/imports`, { kind: 'epub', files: [{ name: big.name, size: MAX_UPLOAD + 1, type: big.type, role: 'main' }] }),
        201,
      );
      expect((await tusCreateRequest(owner, { importId: imp.id, fileIndex: '0' }, MAX_UPLOAD + 1)).statusCode).toBe(413);
    });

    it('accepts no new uploads once the import is finished', async () => {
      const { importId } = await uploadBook(owner, club.id, 'epub', [epub], { title: 'Done', author: '' });
      const res = await tusCreateRequest(owner, { importId, fileIndex: '0' }, epub.bytes.byteLength);
      expect([res.statusCode, res.body]).toEqual([404, 'Upload session not found.']);
      await t.settle();
    });
  });

  describe('finishing an import', () => {
    it('refuses to finish before the book file is fully uploaded (400)', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      const nothing = await finalize(owner, imp.id);
      expect(nothing.statusCode).toBe(400);
      expect(errorOf(nothing).message).toBe('alice-gutenberg-11.epub has not finished uploading yet.');
      const url = await tusCreate(owner, imp.id, 0, epub);
      await tusPatch(owner, url, epub.bytes.subarray(0, 100), 0);
      expect(errorOf(await finalize(owner, imp.id)).message).toBe('alice-gutenberg-11.epub has not finished uploading yet.');
      expect((await importOf(owner, imp.id)).status).toBe('uploading');
    });

    it('a declared cover that never arrived is simply skipped', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub, fileOf('cover.png', 'never sent', 'cover', 'image/png')]);
      const url = await tusCreate(owner, imp.id, 0, epub);
      expect((await tusPatch(owner, url, epub.bytes, 0)).statusCode).toBe(204);
      expect((await finalize(owner, imp.id)).statusCode).toBe(201);
      await t.settle();
    });

    it('finishing again (a retry after a lost answer) answers with the same book and makes no second one', async () => {
      const before = await bookCount();
      const first = await uploadBook(owner, club.id, 'epub', [epub], { title: 'Twice', author: '' });
      const again = await owner.json<{ bookId: string; editionId: string }>(finalize(owner, first.importId, { title: 'Other title', author: '' }), 201);
      expect(again).toEqual({ bookId: first.bookId, editionId: first.editionId });
      expect(await bookCount()).toBe(before + 1);
      expect((await importOf(owner, first.importId)).status).toBe('finalized');
      await t.settle();
      expect((await bookDetail(owner, first.bookId)).title).toBe('Twice');
    });

    it('two finishes at once make one book; the later one is told the upload is being finished', async () => {
      const before = await bookCount();
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      await uploadAll(owner, imp.id, [epub]);
      const answers = await Promise.all([finalize(owner, imp.id), finalize(owner, imp.id), finalize(owner, imp.id)]);
      const made = answers.filter((r) => r.statusCode === 201);
      expect(made.length).toBeGreaterThanOrEqual(1);
      expect(new Set(made.map((r) => r.json<{ bookId: string }>().bookId)).size).toBe(1);
      for (const r of answers.filter((x) => x.statusCode !== 201)) {
        expect(r.statusCode).toBe(409);
        expect(errorOf(r)).toEqual({ code: 'finishing', message: 'This upload is being finished already.' });
      }
      expect(await bookCount()).toBe(before + 1);
      await t.settle();
    });

    it('keeps a file uploaded twice once, and keeps it while any book still uses it', async () => {
      const once = fileOf('only-here.epub', makeEpub(['<p>A book uploaded twice, and nowhere else.</p>']), 'main', 'application/epub+zip');
      const first = await uploadBook(owner, club.id, 'epub', [once], { title: 'Copy one', author: '' });
      const second = await uploadBook(owner, club.id, 'epub', [once], { title: 'Copy two', author: '' });
      await t.settle();
      const blobOf = (editionId: string) => t.ctx.db.get<{ blob_id: string }>('SELECT blob_id FROM edition_files WHERE edition_id = ?', [editionId])!.blob_id;
      expect(blobOf(first.editionId)).toBe(blobOf(second.editionId));
      expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blobs WHERE sha256 = ?', [sha256Hex(once.bytes)])!.n).toBe(1);
      expect((await owner.delete(`/api/books/${first.bookId}`)).statusCode).toBe(204);
      await purgeBook(t.ctx, first.bookId);
      expect(existsSync(t.ctx.storage.blobPath(blobOf(second.editionId)))).toBe(true);
      const file = await owner.get(`/media/editions/${second.editionId}/file`);
      expect(file.statusCode).toBe(200);
      expect(sha256Hex(file.bytes)).toBe(sha256Hex(once.bytes));
      expect((await owner.delete(`/api/books/${second.bookId}`)).statusCode).toBe(204);
      await purgeBook(t.ctx, second.bookId);
      expect(t.ctx.db.get('SELECT 1 AS x FROM blobs WHERE sha256 = ?', [sha256Hex(once.bytes)])).toBeUndefined();
    });

    it('a book deleted while another with the same file is being finished cannot take the file from it', async () => {
      const same = fileOf('shared.epub', makeEpub(['<p>The same file, deleted in one book as it is finished in another.</p>']), 'main', 'application/epub+zip');
      const sha = sha256Hex(same.bytes);
      for (let round = 0; round < 3; round++) {
        const first = await uploadBook(owner, club.id, 'epub', [same], { title: `First ${round}`, author: '' });
        await t.settle();
        const imp = await createImport(owner, club.id, 'epub', [same]);
        await uploadAll(owner, imp.id, [same]);
        // While the second is being finished (its file measured), the first book goes.
        const measure = t.ctx.storage.measure.bind(t.ctx.storage);
        t.ctx.storage.measure = async (file) => {
          t.ctx.storage.measure = measure;
          const deleting = owner.delete(`/api/books/${first.bookId}`).then(async (res) => {
            await purgeBook(t.ctx, first.bookId);
            return res;
          });
          if (round === 0) expect((await deleting).statusCode).toBe(204);
          else void deleting;
          return measure(file);
        };
        const res = await finalize(owner, imp.id, { title: `Second ${round}`, author: '' });
        expect(res.statusCode, res.body).toBe(201);
        const { editionId, bookId } = res.json<{ bookId: string; editionId: string }>();
        await t.settle();
        await waitUntil(async () => (await owner.get(`/api/books/${first.bookId}`)).statusCode === 404, 5000, 'the first book to go');
        const file = await owner.get(`/media/editions/${editionId}/file`);
        expect(file.statusCode).toBe(200);
        expect(sha256Hex(file.bytes)).toBe(sha);
        expect((await owner.delete(`/api/books/${bookId}`)).statusCode).toBe(204);
        await purgeBook(t.ctx, bookId);
      }
      expect(t.ctx.db.get('SELECT 1 AS x FROM blobs WHERE sha256 = ?', [sha])).toBeUndefined();
    });

    it('an upload whose files have gone answers 410, not a server error', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      await uploadAll(owner, imp.id, [epub]);
      for (const name of readdirSync(t.ctx.storage.uploadsDir)) if (!name.endsWith('.json')) rmSync(path.join(t.ctx.storage.uploadsDir, name), { force: true });
      const res = await finalize(owner, imp.id);
      expect(res.statusCode).toBe(410);
      expect(errorOf(res).code).toBe('upload_gone');
    });

    /** Run `work` with the app's error (or warning) log recorded; the test app's logger is otherwise silent. */
    const recordingLog = async (level: 'error' | 'warn', work: () => Promise<void>): Promise<unknown[][]> => {
      const original = t.ctx.log[level];
      const logged: unknown[][] = [];
      t.ctx.log[level] = (...args: unknown[]) => void logged.push(args);
      try {
        await work();
      } finally {
        t.ctx.log[level] = original;
      }
      return logged;
    };

    it('any other failure to read an upload (a disk error) is the server’s, logged, and the upload can still be finished', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      await uploadAll(owner, imp.id, [epub]);
      const measure = t.ctx.storage.measure.bind(t.ctx.storage);
      t.ctx.storage.measure = () => Promise.reject(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));
      const logged = await recordingLog('error', async () => {
        try {
          const res = await finalize(owner, imp.id);
          expect(res.statusCode).toBe(500);
          expect(errorOf(res).code).toBe('internal');
        } finally {
          t.ctx.storage.measure = measure;
        }
      });
      expect(logged).toContainEqual([{ err: expect.objectContaining({ code: 'EIO' }) as unknown }, 'unhandled error']);
      expect((await importOf(owner, imp.id)).status).toBe('uploading');
      expect((await finalize(owner, imp.id)).statusCode).toBe(201);
      await t.settle();
    });

    it('an upload cancelled while it is being finished makes no book', async () => {
      const before = await bookCount();
      const own = fileOf('cancelled.epub', makeEpub(['<p>A book cancelled as it was being finished.</p>']), 'main', 'application/epub+zip');
      const imp = await createImport(owner, club.id, 'epub', [own]);
      await uploadAll(owner, imp.id, [own]);
      // Its files measured, the upload is cancelled before the book is recorded.
      const measure = t.ctx.storage.measure.bind(t.ctx.storage);
      t.ctx.storage.measure = async (file) => {
        t.ctx.storage.measure = measure;
        const measured = await measure(file);
        expect((await owner.delete(`/api/imports/${imp.id}`)).statusCode).toBe(204);
        return measured;
      };
      const res = await finalize(owner, imp.id);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toEqual({ code: 'conflict', message: 'This upload was cancelled.' });
      expect(await bookCount()).toBe(before);
      expect(await importOf(owner, imp.id)).toMatchObject({ status: 'cancelled' });
      expect(t.ctx.db.get('SELECT book_id, edition_id FROM imports WHERE id = ?', [imp.id])).toEqual({ book_id: null, edition_id: null });
      expect(t.ctx.db.get('SELECT 1 AS x FROM blobs WHERE sha256 = ?', [sha256Hex(own.bytes)])).toBeUndefined();
    });

    it('someone removed from the club while their upload is being finished adds no book to it', async () => {
      // A removal renews the club's invite: join with the current one.
      const current = await owner.json<ClubDetail>(owner.get(`/api/clubs/${club.id}`), 200);
      const rena = await joinClub(t, current, 'Rena Removed');
      const renaId = (await rena.json<{ user: { id: string } }>(rena.get('/api/me'), 200)).user.id;
      const before = await bookCount();
      const own = fileOf('renas.epub', makeEpub(['<p>A book its uploader was removed from the club with.</p>']), 'main', 'application/epub+zip');
      const imp = await createImport(rena, club.id, 'epub', [own]);
      await uploadAll(rena, imp.id, [own]);
      const measure = t.ctx.storage.measure.bind(t.ctx.storage);
      t.ctx.storage.measure = async (file) => {
        t.ctx.storage.measure = measure;
        expect((await owner.delete(`/api/clubs/${club.id}/members/${renaId}`)).statusCode).toBe(204);
        return measure(file);
      };
      const res = await finalize(rena, imp.id);
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).message).toBe('Upload session not found.');
      expect(await bookCount()).toBe(before);
      expect(t.ctx.db.get<{ status: string }>('SELECT status FROM imports WHERE id = ?', [imp.id])?.status).toBe('uploading');
    });

    it('reads a cover file whole only if it really is the size of a picture', async () => {
      const png = new Uint8Array(await sharp({ create: { width: 10, height: 15, channels: 3, background: '#123456' } }).png().toBuffer());
      const files = [fileOf('covered.epub', makeEpub(['<p>A book whose cover grew on disk.</p>']), 'main', 'application/epub+zip'), fileOf('cover.png', png, 'cover', 'image/png')];
      const imp = await createImport(owner, club.id, 'epub', files);
      await uploadAll(owner, imp.id, files);
      // Once stored, the picture is far larger than any cover may be (whatever the upload said).
      const moveInto = t.ctx.storage.moveInto.bind(t.ctx.storage);
      t.ctx.storage.moveInto = async (src, id) => {
        const isCover = readFileSync(src).subarray(1, 4).toString('latin1') === 'PNG';
        await moveInto(src, id);
        if (isCover) truncateSync(t.ctx.storage.blobPath(id), MAX_COVER_BYTES + 1);
      };
      let bookId = '';
      const warned = await recordingLog('warn', async () => {
        try {
          ({ bookId } = await owner.json<{ bookId: string }>(finalize(owner, imp.id, { title: 'Covered', author: '' }), 201));
        } finally {
          t.ctx.storage.moveInto = moveInto;
        }
      });
      expect(warned).toContainEqual([{ err: expect.objectContaining({ message: `the cover file has ${MAX_COVER_BYTES + 1} bytes, more than ${MAX_COVER_BYTES}` }) as unknown }, 'uploaded cover could not be read']);
      await t.settle();
      expect((await bookDetail(owner, bookId)).hasCover).toBe(false);
    });

    it('a cancelled upload cannot be finished (409)', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      await uploadAll(owner, imp.id, [epub]);
      expect((await owner.delete(`/api/imports/${imp.id}`)).statusCode).toBe(204);
      const res = await finalize(owner, imp.id);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toEqual({ code: 'conflict', message: 'This upload was cancelled.' });
    });

    it('validates the finish form', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      await uploadAll(owner, imp.id, [epub]);
      for (const body of [{ author: 'x' }, { title: '   ', author: 'x' }]) {
        const res = await finalize(owner, imp.id, body);
        expect(res.statusCode).toBe(400);
        expect(errorOf(res).fields).toEqual({ title: expect.any(String) as string });
      }
      expect(errorOf(await finalize(owner, imp.id, { title: '   ', author: 'x' })).message).toBe('Enter the title');
      expect((await finalize(owner, imp.id, { title: 'x', author: 'y', bookId: 'not ok!' })).statusCode).toBe(400);
    });

    const notes = 'These are my reading notes. They are not a book.';
    it.each([
      ['epub' as const, [fileOf('notes.txt', notes, 'main', 'application/epub+zip')], 'notes.txt is not an EPUB file.'],
      ['pdf' as const, [fileOf('notes.txt', notes, 'main', 'application/pdf')], 'notes.txt is not a PDF file.'],
      ['audio' as const, [fileOf('notes.txt', notes, 'track', 'audio/mpeg')], 'notes.txt is not an audio file we can play.'],
    ])('checks the content, not the name: a text file declared as %s is refused', async (kind, files, message) => {
      const before = await bookCount();
      const imp = await createImport(owner, club.id, kind, files);
      await uploadAll(owner, imp.id, files);
      const res = await finalize(owner, imp.id);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).message).toBe(message);
      expect(await bookCount()).toBe(before);
      expect((await importOf(owner, imp.id)).status).toBe('uploading');
    });

    it('checks that a cover really is an image', async () => {
      const files = [epub, fileOf('cover.jpg', notes, 'cover', 'image/jpeg')];
      const imp = await createImport(owner, club.id, 'epub', files);
      await uploadAll(owner, imp.id, files);
      const res = await finalize(owner, imp.id);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).message).toBe('cover.jpg is not a JPEG, PNG, GIF or WebP image.');
    });

    it('orders tracks by filename by default, or as chosen, with optional titles', async () => {
      const tracks = audioTracks(SYNTHETIC_AUDIO).reverse();
      const natural = await uploadBook(owner, club.id, 'audio', tracks, { title: 'Natural order', author: 'Ada Tone' });
      const chosen = await uploadBook(owner, club.id, 'audio', tracks, { title: 'Chosen order', author: 'Ada Tone', trackOrder: [1, 0, 2] });
      const titled = await uploadBook(owner, club.id, 'audio', tracks, { title: 'Titled', author: 'Ada Tone', trackOrder: [2, 1, 0], trackTitles: [' One ', 'Two', ''] });
      await t.settle();
      const titlesOf = async (bookId: string) => (await bookDetail(owner, bookId)).editions[0]!.tracks.map((tr) => tr.title);
      expect(await titlesOf(natural.bookId)).toEqual(['The Beginning', 'The Middle', 'The End']);
      expect(await titlesOf(chosen.bookId)).toEqual(['The Middle', 'The End', 'The Beginning']);
      // A blank title falls back to the track's own tag.
      expect(await titlesOf(titled.bookId)).toEqual(['One', 'Two', 'The End']);
    });

    it.each([
      ['repeats a track', [0, 0, 1]],
      ['leaves a track out', [0, 1]],
      ['names a file that is not a track', [0, 1, 5]],
    ])('refuses a track order that %s', async (_label, trackOrder) => {
      const tracks = audioTracks(SYNTHETIC_AUDIO);
      const imp = await createImport(owner, club.id, 'audio', tracks);
      await uploadAll(owner, imp.id, tracks);
      const res = await finalize(owner, imp.id, { title: 'Bad order', author: '', trackOrder });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).message).toBe('The track order does not match the uploaded tracks.');
    });

    it('can only add a format to a book of the same club', async () => {
      const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Elsewhere' }), 201);
      const small = fileOf('small.epub', makeEpub(['<p>Hello.</p>']), 'main', 'application/epub+zip');
      const elsewhere = await uploadBook(owner, other.id, 'epub', [small], { title: 'Elsewhere book', author: '' });
      await t.settle();
      const imp = await createImport(owner, club.id, 'epub', [small]);
      await uploadAll(owner, imp.id, [small]);
      const res = await finalize(owner, imp.id, { title: 'x', author: '', bookId: elsewhere.bookId });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).message).toBe('That book belongs to another club.');
      // Someone who is not in that club cannot even find it.
      const anas = await createImport(ana, club.id, 'epub', [small]);
      await uploadAll(ana, anas.id, [small]);
      const hidden = await finalize(ana, anas.id, { title: 'x', author: '', bookId: elsewhere.bookId });
      expect(hidden.statusCode).toBe(404);
      expect(errorOf(hidden).message).toBe('Book not found.');
    });

    it('someone else’s import is not found (404); anonymous requests are 401', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      for (const c of [ana, ozzy]) {
        expect((await c.get(`/api/imports/${imp.id}`)).statusCode).toBe(404);
        expect((await finalize(c, imp.id)).statusCode).toBe(404);
        expect((await c.delete(`/api/imports/${imp.id}`)).statusCode).toBe(404);
      }
      const anon = t.client();
      expect((await anon.get(`/api/imports/${imp.id}`)).statusCode).toBe(401);
      expect((await finalize(anon, imp.id)).statusCode).toBe(401);
      expect((await anon.delete(`/api/imports/${imp.id}`)).statusCode).toBe(401);
      expect((await importOf(owner, imp.id)).status).toBe('uploading');
    });
  });

  describe('cancelling and clean-up', () => {
    it('cancelling deletes the partial upload from disk', async () => {
      const imp = await createImport(owner, club.id, 'epub', [epub]);
      const url = await tusCreate(owner, imp.id, 0, epub);
      await tusPatch(owner, url, epub.bytes.subarray(0, 50_000), 0);
      const data = path.join(t.ctx.storage.uploadsDir, uploadIdOf(url));
      expect(readFileSync(data).byteLength).toBe(50_000);
      expect(existsSync(`${data}.json`)).toBe(true);

      expect((await owner.delete(`/api/imports/${imp.id}`)).statusCode).toBe(204);
      expect(existsSync(data)).toBe(false);
      expect(existsSync(`${data}.json`)).toBe(false);
      expect((await importOf(owner, imp.id)).status).toBe('cancelled');
      expect((await tusHead(owner, url)).statusCode).toBe(404);
      expect((await finalize(owner, imp.id)).statusCode).toBe(409);
    });

    it('cancelling a finished import leaves the book alone', async () => {
      const { importId, bookId } = await uploadBook(owner, club.id, 'epub', [epub], { title: 'Keep me', author: '' });
      await t.settle();
      expect((await owner.delete(`/api/imports/${importId}`)).statusCode).toBe(204);
      expect((await importOf(owner, importId)).status).toBe('finalized');
      expect((await bookDetail(owner, bookId)).editions[0]!.status).toBe('ready');
    });

    it('expired imports are cancelled and their partial files deleted by the housekeeping job', async () => {
      const stale = await createImport(owner, club.id, 'epub', [epub]);
      const staleUrl = await tusCreate(owner, stale.id, 0, epub);
      await tusPatch(owner, staleUrl, epub.bytes.subarray(0, 1000), 0);
      const fresh = await createImport(owner, club.id, 'epub', [epub]);
      const freshUrl = await tusCreate(owner, fresh.id, 0, epub);
      t.ctx.db.exec('UPDATE imports SET created_at = ? WHERE id = ?', [Date.now() - 8 * 24 * 3600_000, stale.id]);

      await cleanUpUploads(t.ctx, createTus(t.ctx));
      expect((await importOf(owner, stale.id)).status).toBe('cancelled');
      expect(existsSync(path.join(t.ctx.storage.uploadsDir, uploadIdOf(staleUrl)))).toBe(false);
      expect((await importOf(owner, fresh.id)).status).toBe('uploading');
      expect(existsSync(path.join(t.ctx.storage.uploadsDir, uploadIdOf(freshUrl)))).toBe(true);
    });
  });
});
