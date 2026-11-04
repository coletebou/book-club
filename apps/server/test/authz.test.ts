import { ApiErrorSchema, type ClubDetail, type CommentView, type Import, type Locator, type Publication } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  createImport,
  fileFrom,
  fileOf,
  joinClub,
  makeEpub,
  makeTestApp,
  openSocket,
  outsider,
  setupOwner,
  tusCreate,
  tusHead,
  tusPatch,
  uploadAll,
  uploadBook,
} from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

/** Everything the tests below need to address the club's resources. */
interface Ids {
  clubId: string;
  anaId: string;
  bookId: string;
  epubId: string;
  pdfBookId: string;
  pdfId: string;
  audioId: string;
  commentId: string;
  importId: string;
  uploadUrl: string;
  sectionUrl: string;
  imageUrl: string;
  coverUrl: string;
}

const locator: Locator = { kind: 'epub', section: 3, offset: 10 };

type Request = readonly [method: string, url: string, body?: unknown];

const API: [string, (ids: Ids) => Request][] = [
  ['club detail', (i) => ['GET', `/api/clubs/${i.clubId}`]],
  ['rename club', (i) => ['PATCH', `/api/clubs/${i.clubId}`, { name: 'Taken over' }]],
  ['club books', (i) => ['GET', `/api/clubs/${i.clubId}/books`]],
  ['book matches', (i) => ['GET', `/api/clubs/${i.clubId}/book-matches?title=Alice&author=`]],
  ['declare an import', (i) => ['POST', `/api/clubs/${i.clubId}/imports`, { kind: 'epub', files: [{ name: 'a.epub', size: 1, type: '', role: 'main' }] }]],
  ['rotate invite', (i) => ['POST', `/api/clubs/${i.clubId}/invite/rotate`]],
  ['remove member', (i) => ['DELETE', `/api/clubs/${i.clubId}/members/${i.anaId}`]],
  ['change role', (i) => ['PUT', `/api/clubs/${i.clubId}/members/${i.anaId}/role`, { role: 'owner' }]],
  ['issue reset link', (i) => ['POST', `/api/clubs/${i.clubId}/members/${i.anaId}/reset-link`]],
  ['book detail', (i) => ['GET', `/api/books/${i.bookId}`]],
  ['edit book', (i) => ['PATCH', `/api/books/${i.bookId}`, { title: 'Mine now' }]],
  ['delete book', (i) => ['DELETE', `/api/books/${i.bookId}`]],
  ['list comments', (i) => ['GET', `/api/books/${i.bookId}/comments`]],
  ['post comment', (i) => ['POST', `/api/books/${i.bookId}/comments`, { editionId: i.epubId, locator, text: 'Hello from outside' }]],
  ['delete comment', (i) => ['DELETE', `/api/comments/${i.commentId}`]],
  ['read progress', (i) => ['GET', `/api/books/${i.bookId}/progress`]],
  ['save progress', (i) => ['PUT', `/api/books/${i.bookId}/progress`, { editionId: i.epubId, locator, readSpans: [], at: Date.now() }]],
  ['progress beacon', (i) => ['POST', `/api/books/${i.bookId}/progress/beacon`, { editionId: i.epubId, locator, readSpans: [], at: Date.now() }]],
  ['read up to', (i) => ['POST', `/api/books/${i.bookId}/progress/read-up-to`, { editionId: i.epubId, locator }]],
  ['your history of a book', (i) => ['GET', `/api/books/${i.bookId}/history`]],
  ['forget a book’s history', (i) => ['DELETE', `/api/books/${i.bookId}/history`]],
  ['publication manifest', (i) => ['GET', `/api/editions/${i.epubId}/publication`]],
  ['align edition', (i) => ['PUT', `/api/editions/${i.audioId}/alignment`, { unitToChapter: [] }]],
  ['delete edition', (i) => ['DELETE', `/api/editions/${i.pdfId}`]],
  ['someone’s import', (i) => ['GET', `/api/imports/${i.importId}`]],
  ['finish someone’s import', (i) => ['POST', `/api/imports/${i.importId}/finalize`, { title: 'x', author: '' }]],
  ['cancel someone’s import', (i) => ['DELETE', `/api/imports/${i.importId}`]],
];

const MEDIA: [string, (ids: Ids) => Request][] = [
  ['the cover', (i) => ['GET', i.coverUrl]],
  ['a cover thumbnail', (i) => ['GET', `/media/books/${i.bookId}/cover?w=640`]],
  ['the lock screen’s square cover', (i) => ['GET', `/media/books/${i.bookId}/cover?shape=square&w=512`]],
  ['an EPUB section', (i) => ['GET', i.sectionUrl]],
  ['an EPUB image', (i) => ['GET', i.imageUrl]],
  ['the EPUB file', (i) => ['GET', `/media/editions/${i.epubId}/file`]],
  ['the PDF file', (i) => ['GET', `/media/editions/${i.pdfId}/file`]],
  ['an audio track', (i) => ['GET', `/media/editions/${i.audioId}/tracks/0`]],
];

describe('authorization', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ozzy: Client;
  const ids = {} as Ids;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ozzy = await outsider(t, owner, 'Ozzy');
    const alice = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    const audio = await uploadBook(owner, club.id, 'audio', audioTracks(SYNTHETIC_AUDIO), { title: 'Alice', author: 'Lewis Carroll', bookId: alice.bookId });
    const pdf = await uploadBook(owner, club.id, 'pdf', [fileFrom(ALICE_PDF, 'main', 'application/pdf')], { title: 'Alice PDF', author: 'Lewis Carroll' });
    await t.settle();
    const pub = await owner.json<Publication>(owner.get(`/api/editions/${alice.editionId}/publication`), 200);
    const comment = await owner.json<CommentView>(owner.post(`/api/books/${alice.bookId}/comments`, { editionId: alice.editionId, locator, text: 'Members only', reaction: '😱' }), 201);
    await owner.json(owner.put(`/api/books/${alice.bookId}/progress`, { editionId: alice.editionId, locator, readSpans: [{ from: locator, to: { ...locator, offset: 500 } }], at: Date.now() }), 200);
    const epub = fileFrom(ALICE_EPUB, 'main', 'application/epub+zip');
    const imp = await createImport(owner, club.id, 'epub', [epub]);
    const uploadUrl = await tusCreate(owner, imp.id, 0, epub);
    await tusPatch(owner, uploadUrl, epub.bytes.subarray(0, 1000), 0);
    Object.assign(ids, {
      clubId: club.id,
      anaId: (await ana.json<{ user: { id: string } }>(ana.get('/api/me'), 200)).user.id,
      bookId: alice.bookId,
      epubId: alice.editionId,
      pdfBookId: pdf.bookId,
      pdfId: pdf.editionId,
      audioId: audio.editionId,
      commentId: comment.id,
      importId: imp.id,
      uploadUrl,
      sectionUrl: `${pub.baseUrl}${pub.sections[3]!.href}`,
      imageUrl: `${pub.baseUrl}${pub.resources.find((r) => /\.(jpe?g|png)$/i.test(r))!}`,
      coverUrl: (await bookDetail(owner, alice.bookId)).coverUrl,
    } satisfies Ids);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  const send = (c: Client, [method, url, body]: Request) => c.request({ method, url, ...(body === undefined ? {} : { payload: body }) });

  describe('members get through', () => {
    it.each(MEDIA)('a member can fetch %s', async (_name, make) => {
      const res = await send(ana, make(ids));
      expect(res.statusCode).toBe(200);
    });

    it('a member reads the club, its books and comments', async () => {
      for (const [, make] of API.filter(([, make]) => make(ids)[0] === 'GET' && !make(ids)[1].startsWith('/api/imports/'))) {
        const request = make(ids);
        expect((await send(ana, request)).statusCode, request.join(' ')).toBe(200);
      }
    });
  });

  describe('an outsider (a member of another club) is told nothing exists', () => {
    it.each(API)('404 for %s', async (_name, make) => {
      const res = await send(ozzy, make(ids));
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
    });

    it.each(MEDIA)('404 for %s', async (_name, make) => {
      const res = await send(ozzy, make(ids));
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('Members only');
    });

    it('404 for someone else’s upload, whatever the method', async () => {
      expect((await tusHead(ozzy, ids.uploadUrl)).statusCode).toBe(404);
      expect((await tusPatch(ozzy, ids.uploadUrl, new Uint8Array(10), 1000)).statusCode).toBe(404);
      expect((await tusHead(owner, ids.uploadUrl)).headers['upload-offset']).toBe('1000');
    });

    it('the 404 is the same as for an id that does not exist at all', async () => {
      const pairs: [Request, Request][] = [
        [['GET', `/api/books/${ids.bookId}`], ['GET', '/api/books/doesNotExist1']],
        [['GET', `/api/clubs/${ids.clubId}`], ['GET', '/api/clubs/doesNotExist1']],
        [['DELETE', `/api/comments/${ids.commentId}`], ['DELETE', '/api/comments/doesNotExist1']],
        [['GET', `/api/editions/${ids.epubId}/publication`], ['GET', '/api/editions/doesNotExist1/publication']],
      ];
      for (const [real, fake] of pairs) {
        const a = await send(ozzy, real);
        const b = await send(owner, fake);
        expect([a.statusCode, errorOf(a)]).toEqual([b.statusCode, errorOf(b)]);
      }
    });

    it('nothing the outsider tried changed anything', async () => {
      const book = await bookDetail(owner, ids.bookId);
      expect(book.title).toBe('Alice');
      expect(book.editions).toHaveLength(2);
      const comments = await owner.json<CommentView[]>(owner.get(`/api/books/${ids.bookId}/comments`), 200);
      expect(comments.map((c) => c.id)).toEqual([ids.commentId]);
      const detail = await owner.json<ClubDetail>(owner.get(`/api/clubs/${ids.clubId}`), 200);
      expect(detail.name).toBe('Thursday Readers');
      expect(detail.invite!.code).toBe(club.invite!.code);
      expect(detail.members.map((m) => m.role)).toEqual(['owner', 'member']);
      expect((await owner.json<Import>(owner.get(`/api/imports/${ids.importId}`), 200)).status).toBe('uploading');
    });

    it('cannot use the club’s editions from a book of their own', async () => {
      const own = await owner.json<{ id: string }[]>(ozzy.get('/api/clubs'), 200);
      const theirs = await uploadBook(ozzy, own[0]!.id, 'epub', [fileOf('mine.epub', makeEpub(['<p>Mine.</p>']), 'main', 'application/epub+zip')], { title: 'Mine', author: '' });
      await t.settle();
      const body = { editionId: ids.epubId, locator, readSpans: [{ from: locator, to: { ...locator, offset: 900 } }], at: Date.now() };
      const progress = await ozzy.put(`/api/books/${theirs.bookId}/progress`, body);
      expect(progress.statusCode).toBe(400);
      expect(errorOf(progress).message).toBe('That edition does not belong to this book.');
      const comment = await ozzy.post(`/api/books/${theirs.bookId}/comments`, { editionId: ids.epubId, locator, text: 'sneaky' });
      expect(errorOf(comment).message).toBe('That edition does not belong to this book.');
      // ... nor attach a new format to the club's book.
      const tracks = audioTracks(SYNTHETIC_AUDIO);
      const imp = await createImport(ozzy, own[0]!.id, 'audio', tracks);
      await uploadAll(ozzy, imp.id, tracks);
      const attach = await ozzy.post(`/api/imports/${imp.id}/finalize`, { title: 'x', author: '', bookId: ids.bookId });
      expect(attach.statusCode).toBe(404);
    });

    it('cannot subscribe to the club or report reading its books over the WebSocket', async () => {
      const socket = await openSocket(t, ozzy);
      try {
        socket.send({ type: 'subscribe', clubId: ids.clubId });
        expect((await socket.next('error')).message).toBe('Club not found.');
        socket.send({ type: 'reading', bookId: ids.bookId, editionId: ids.epubId, locator, label: 'x' });
        expect((await socket.next('error')).message).toBe('Book not found.');
        expect(socket.messages.some((m) => m.type === 'presence')).toBe(false);
      } finally {
        await socket.close();
      }
    });
  });

  describe('anonymous visitors are asked to sign in', () => {
    it.each([...API, ...MEDIA])('401 for %s', async (_name, make) => {
      const res = await send(t.client(), make(ids));
      expect(res.statusCode).toBe(401);
      expect(errorOf(res)).toEqual({ code: 'unauthorized', message: 'Sign in to continue.' });
    });

    it.each([
      ['GET', '/api/me'],
      ['GET', '/api/clubs'],
      ['POST', '/api/clubs'],
      ['POST', '/api/auth/signout-everywhere'],
      ['POST', '/api/me/password'],
    ])('401 for %s %s', async (method, url) => {
      expect((await t.client().request({ method, url, ...(method === 'GET' ? {} : { payload: {} }) })).statusCode).toBe(401);
    });

    it('401 for uploads', async () => {
      const anon = t.client();
      expect((await tusHead(anon, ids.uploadUrl)).statusCode).toBe(401);
      expect((await anon.request({ method: 'POST', url: '/api/uploads', headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' } })).statusCode).toBe(401);
    });

    it('only the session, invite previews and the health check are public', async () => {
      const anon = t.client();
      expect((await anon.get('/api/session')).statusCode).toBe(200);
      expect((await anon.get(`/api/invites/${club.invite!.code}`)).statusCode).toBe(200);
      const health = await anon.get('/healthz');
      expect([health.statusCode, health.json()]).toEqual([200, { ok: true }]);
    });
  });

  describe('membership ends at once', () => {
    it('a removed member loses every book, file, comment and live update immediately', async () => {
      const ben = await joinClub(t, club, 'Ben');
      const benId = (await ben.json<{ user: { id: string } }>(ben.get('/api/me'), 200)).user.id;
      for (const [, make] of MEDIA) expect((await send(ben, make(ids))).statusCode).toBe(200);
      expect((await ben.get(`/api/books/${ids.bookId}/comments`)).statusCode).toBe(200);
      const bens = await openSocket(t, ben);
      const anas = await openSocket(t, ana);
      try {
        bens.send({ type: 'subscribe', clubId: ids.clubId });
        anas.send({ type: 'subscribe', clubId: ids.clubId });
        await bens.next('presence');
        await anas.next('presence');

        expect((await owner.delete(`/api/clubs/${ids.clubId}/members/${benId}`)).statusCode).toBe(204);
        // Ana hears that the club changed; Ben's socket is no longer subscribed.
        await anas.next('club:changed');
        for (const [, make] of [...API.filter(([, m]) => !m(ids)[1].startsWith('/api/imports/')), ...MEDIA]) {
          const request = make(ids);
          expect((await send(ben, request)).statusCode, request.join(' ')).toBe(404);
        }
        await owner.json(owner.post(`/api/books/${ids.bookId}/comments`, { editionId: ids.epubId, locator, text: 'After Ben left' }), 201);
        await anas.next('comment:new');
        expect(await bens.quiet('comment:new')).toBe(true);
        bens.send({ type: 'subscribe', clubId: ids.clubId });
        expect((await bens.next('error')).message).toBe('Club not found.');
      } finally {
        await bens.close();
        await anas.close();
      }
    });
  });
});
