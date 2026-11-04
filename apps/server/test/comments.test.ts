import {
  ApiErrorSchema,
  BookSummarySchema,
  CommentViewSchema,
  HiddenCommentSchema,
  MAX_PAGE_CHARS,
  PlacesSchema,
  REACTIONS,
  RevealedCommentSchema,
  chapterIndexAt,
  locatorToT,
  tToLocator,
  type BookDetail,
  type ClubDetail,
  type CommentView,
  type Edition,
  type EpubLocator,
  type Locator,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUGH_STEP } from '../src/services/gating';
import {
  ALICE_EPUB,
  ALICE_PDF,
  ALICE_TINY_AUDIO,
  type Client,
  type Res,
  type TestApp,
  audioTracks,
  closeApp,
  bookDetail,
  fileFrom,
  joinClub,
  makeTestApp,
  outsider,
  setupOwner,
  uploadBook,
} from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;
const epubAt = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });
/** A note at a place you have not read: a marker, placed only roughly (`approx`, D80). */
const HIDDEN_KEYS = ['approx', 'authorName', 'bookId', 'color', 'createdAt', 'editionId', 'hasText', 'hidden', 'id', 'kind', 'locator', 'media', 'parentId', 'reaction', 't', 'userId'];

describe('comments and reactions', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let book: BookDetail;
  let epub: Edition;
  let audio: Edition;
  let pdfBook: BookDetail;
  let readers = 0;

  const reader = async () => joinClub(t, club, `Reader ${++readers}`);
  const tOf = (edition: Edition, locator: Locator) => locatorToT({ geometry: edition.geometry!, sync: edition.sync! }, locator);
  const post = (c: Client, body: Record<string, unknown>, bookId = book.id) => c.post(`/api/books/${bookId}/comments`, { editionId: epub.id, locator: epubAt(4, 10), ...body });
  const created = async (c: Client, body: Record<string, unknown>, bookId = book.id) => CommentViewSchema.parse(await c.json(post(c, body, bookId), 201));
  const list = async (c: Client, bookId = book.id) => (await c.json<unknown[]>(c.get(`/api/books/${bookId}/comments`), 200)).map((v) => CommentViewSchema.parse(v));
  const viewOf = async (c: Client, id: string) => (await list(c)).find((v) => v.id === id)!;
  const read = (c: Client, edition: Edition, from: Locator, to: Locator) =>
    c.json(c.put(`/api/books/${book.id}/progress`, { editionId: edition.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', audioTracks(ALICE_TINY_AUDIO), { title: 'Alice', author: 'Lewis Carroll', bookId });
    const pdf = await uploadBook(owner, club.id, 'pdf', [fileFrom(ALICE_PDF, 'main', 'application/pdf')], { title: 'Alice in print', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions.find((e) => e.kind === 'epub')!;
    audio = book.editions.find((e) => e.kind === 'audio')!;
    pdfBook = await bookDetail(owner, pdf.bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  describe('writing', () => {
    it('pins text, a quote, a reaction and a range to an exact place in the book', async () => {
      const res = await post(owner, { locator: epubAt(5, 120), endLocator: epubAt(5, 160), quote: '  Curiouser and curiouser!  ', text: 'Here it gets weird', reaction: '🤯' });
      expect(res.statusCode).toBe(201);
      const view = RevealedCommentSchema.parse(res.json());
      expect(view).toMatchObject({
        bookId: book.id,
        editionId: epub.id,
        kind: 'epub',
        authorName: 'Cole',
        locator: epubAt(5, 120),
        endLocator: epubAt(5, 160),
        quote: 'Curiouser and curiouser!',
        text: 'Here it gets weird',
        reaction: '🤯',
        hidden: false,
      });
      expect(view.t).toBeCloseTo(tOf(epub, epubAt(5, 120)), 12);
      expect(view.endT).toBeCloseTo(tOf(epub, epubAt(5, 160)), 12);
      expect(view.color).toMatch(/^#[0-9A-F]{6}$/);
      expect(Number.isNaN(Date.parse(view.createdAt))).toBe(false);
    });

    it('a reaction on its own is a comment too', async () => {
      const view = await created(ana, { reaction: '😂' });
      expect(view).toMatchObject({ hidden: false, text: null, quote: null, reaction: '😂', endLocator: null, endT: null });
    });

    it('needs text, a reaction, or media (D140)', async () => {
      for (const body of [{}, { text: '    ' }, { text: '' }, { quote: 'only a quote' }]) {
        const res = await post(owner, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(errorOf(res).message).toBe('A comment needs text, a reaction, or media');
      }
    });

    it.each(REACTIONS)('accepts the reaction %s', async (reaction) => {
      expect((await created(ben, { reaction })).reaction).toBe(reaction);
    });

    it('refuses any other reaction', async () => {
      for (const reaction of ['👍', 'love', '😱😱', '']) expect((await post(owner, { reaction, text: 'x' })).statusCode, reaction).toBe(400);
    });

    it('limits text to 2000 characters and quotes to 600', async () => {
      expect((await post(owner, { text: 'a'.repeat(2000) })).statusCode).toBe(201);
      const long = await post(owner, { text: 'a'.repeat(2001) });
      expect(long.statusCode).toBe(400);
      expect(errorOf(long).fields).toHaveProperty('text');
      expect((await post(owner, { text: 'q', quote: 'b'.repeat(600) })).statusCode).toBe(201);
      expect((await post(owner, { text: 'q', quote: 'b'.repeat(601) })).statusCode).toBe(400);
    });

    it('keeps the position in the format of its edition', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ locator: { kind: 'pdf', page: 1, y: 0 }, text: 'x' }, 'A pdf position does not belong to this epub edition.'],
        [{ locator: { kind: 'audio', track: 0, ms: 0 }, text: 'x' }, 'A audio position does not belong to this epub edition.'],
        [{ editionId: audio.id, locator: epubAt(1, 0), text: 'x' }, 'A epub position does not belong to this audio edition.'],
        [{ endLocator: { kind: 'audio', track: 0, ms: 10 }, text: 'x' }, 'A comment range must stay in one format.'],
        [{ editionId: pdfBook.editions[0]!.id, locator: { kind: 'pdf', page: 1, y: 0 }, text: 'x' }, 'That edition does not belong to this book.'],
        [{ editionId: 'unknownEdition', text: 'x' }, 'That edition does not belong to this book.'],
      ];
      for (const [body, message] of cases) {
        const res = await post(owner, body);
        expect(res.statusCode, message).toBe(400);
        expect(errorOf(res).message).toBe(message);
      }
    });

    it('drops a range end that comes before its start, and a blank quote', async () => {
      const view = await created(owner, { locator: epubAt(6, 500), endLocator: epubAt(6, 100), text: 'Backwards', quote: '   ' });
      expect(view).toMatchObject({ hidden: false, endT: null, quote: null });
    });

    it('can be written while listening and while reading a PDF', async () => {
      const heard = RevealedCommentSchema.parse(await created(ana, { editionId: audio.id, locator: { kind: 'audio', track: 2, ms: 1000 }, text: 'Heard this' }));
      expect(heard.kind).toBe('audio');
      expect(heard.t).toBeCloseTo(tOf(audio, { kind: 'audio', track: 2, ms: 1000 }), 12);
      const pdf = pdfBook.editions[0]!;
      const printed = RevealedCommentSchema.parse(await created(owner, { editionId: pdf.id, locator: { kind: 'pdf', page: 10, y: 0.25 }, text: 'Page 11' }, pdfBook.id));
      expect(printed.t).toBeCloseTo(10.25 / 91, 12);
    });

    it('is idempotent with a client id, per book', async () => {
      const body = { text: 'Written offline', clientId: 'offline-0001' };
      const first = await post(ana, body);
      expect(first.statusCode).toBe(201);
      const retry = await post(ana, body);
      expect(retry.statusCode).toBe(200);
      expect(retry.json<CommentView>().id).toBe(first.json<CommentView>().id);
      expect((await list(ana)).filter((v) => !v.hidden && v.text === 'Written offline')).toHaveLength(1);
      // Another member's identical client id is a different comment.
      expect((await post(ben, body)).statusCode).toBe(201);
      expect((await post(ana, { ...body, clientId: 'short' })).statusCode).toBe(400);
    });
  });

  describe('spoiler gating', () => {
    let twist: CommentView;

    beforeAll(async () => {
      // CHAPTER VII (section 8): the tea party.
      twist = await created(owner, { locator: epubAt(8, 50), quote: 'Why is a raven like a writing-desk?', text: 'The riddle has no answer!', reaction: '😱' });
    });

    it('someone who has not got there sees only a spoiler-free marker', async () => {
      const c = await reader();
      const res = await c.get(`/api/books/${book.id}/comments`);
      expect(res.body).not.toContain('riddle');
      expect(res.body).not.toContain('raven');
      const marker = res.json<Record<string, unknown>[]>().find((v) => v.id === twist.id)!;
      expect(Object.keys(marker).sort()).toEqual(HIDDEN_KEYS);
      const hidden = HiddenCommentSchema.parse(marker);
      expect(hidden).toMatchObject({ hidden: true, hasText: true, reaction: '😱', authorName: 'Cole', approx: true });
      // Its place only roughly: to half a per cent of the book, within its chapter; not its passage.
      expect(Math.abs(hidden.t - twist.t)).toBeLessThanOrEqual(ROUGH_STEP / 2 + 1e-9);
      expect(hidden.t).not.toBe(twist.t);
      expect(hidden.locator).not.toEqual(twist.locator);
      const chapters = (await bookDetail(owner, book.id)).chapters;
      expect(chapterIndexAt(chapters, hidden.t)).toBe(chapterIndexAt(chapters, twist.t));
    });

    it('tells a friend looking at the page of a note ahead of them where on it the note is, and no more than that page', async () => {
      const c = await reader();
      const places = (q: string) => c.get(`/api/books/${book.id}/places?edition=${epub.id}&${q}`);
      // The tea party's opening page: the twist is on it, exactly where it was written.
      const page = PlacesSchema.parse((await places('section=8&from=0&to=3000')).json());
      expect(page.places).toEqual([{ id: twist.id, t: twist.t, locator: twist.locator }]);
      // A page further on, or another section: not there.
      expect(PlacesSchema.parse((await places('section=8&from=3000&to=6000')).json()).places).toEqual([]);
      const other = PlacesSchema.parse((await places('section=4&from=0&to=3000')).json()).places;
      expect(other.map((p) => p.id)).not.toContain(twist.id);
      // Each on that page of the EPUB by the timeline, in whichever format it was made.
      const span = [locatorToT({ geometry: epub.geometry!, sync: epub.sync! }, epubAt(4, 0)), locatorToT({ geometry: epub.geometry!, sync: epub.sync! }, epubAt(4, 3000))];
      expect(other.every((p) => p.t >= span[0]! - 1e-9 && p.t <= span[1]! + 1e-9)).toBe(true);
      // No more than a page of characters at a time: a request for the whole book is cut to MAX_PAGE_CHARS.
      expect(PlacesSchema.parse((await places(`section=8&from=${MAX_PAGE_CHARS}&to=999999`)).json()).places).toEqual([]);
      // Nothing for a note already open, nor one's own: the list has their places.
      expect(PlacesSchema.parse((await owner.get(`/api/books/${book.id}/places?edition=${epub.id}&section=8&from=0&to=3000`)).json()).places).toEqual([]);
      expect((await places('section=8')).statusCode).toBe(400);
      expect((await places('section=9999&from=0&to=10')).statusCode).toBe(400);
      expect((await c.get(`/api/books/${book.id}/places?edition=nope&section=8&from=0&to=10`)).statusCode).toBe(400);
      const ozzy = await outsider(t, owner, 'Ozzy places');
      expect((await ozzy.get(`/api/books/${book.id}/places?edition=${epub.id}&section=8&from=0&to=3000`)).statusCode).toBe(404);
    });

    it('a note opens with its exact place once its place is read; until then it stays roughly placed', async () => {
      const c = await reader();
      // Read up to just before the twist: still a marker, still placed only roughly.
      await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: epubAt(8, 40), readSpans: [{ from: epubAt(8, 0), to: epubAt(8, 40) }], at: Date.now() }), 200);
      const closed = HiddenCommentSchema.parse((await c.json<CommentView[]>(c.get(`/api/books/${book.id}/comments`), 200)).find((v) => v.id === twist.id));
      expect(closed.approx).toBe(true);
      // Read past it: open, exactly where it was written.
      await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: epubAt(8, 80), readSpans: [{ from: epubAt(8, 40), to: epubAt(8, 80) }], at: Date.now() }), 200);
      const open = (await c.json<CommentView[]>(c.get(`/api/books/${book.id}/comments`), 200)).find((v) => v.id === twist.id)!;
      expect(open).toMatchObject({ hidden: false, t: twist.t, locator: twist.locator });
      expect('approx' in open).toBe(false);
    });

    it('the author always sees their own comment in full', async () => {
      expect(await viewOf(owner, twist.id)).toMatchObject({ hidden: false, text: 'The riddle has no answer!', quote: 'Why is a raven like a writing-desk?' });
    });

    it('reading past the place by jumping ahead does not reveal it', async () => {
      const c = await reader();
      await read(c, epub, epubAt(11, 0), epubAt(11, 2000));
      const view = await viewOf(c, twist.id);
      expect(view.hidden).toBe(true);
      expect(JSON.stringify(view)).not.toContain('riddle');
    });

    it('reading the passage reveals it', async () => {
      const c = await reader();
      await read(c, epub, epubAt(8, 0), epubAt(8, 400));
      expect(await viewOf(c, twist.id)).toMatchObject({ hidden: false, text: 'The riddle has no answer!', quote: 'Why is a raven like a writing-desk?' });
    });

    it('hearing the same chapter in the audiobook reveals it too', async () => {
      const c = await reader();
      const track = audio.tracks.findIndex((tr) => tr.chapter === book.chapters.findIndex((ch) => ch.title.startsWith('CHAPTER VII.')));
      expect(track).toBe(6);
      await read(c, audio, { kind: 'audio', track, ms: 0 }, { kind: 'audio', track, ms: audio.tracks[track]!.durationMs });
      expect((await viewOf(c, twist.id)).hidden).toBe(false);
    });

    it('a comment made while listening appears at the matching place for readers', async () => {
      const heard = await created(ana, { editionId: audio.id, locator: { kind: 'audio', track: 9, ms: 2500 }, text: 'Lobster quadrille!' });
      const place = tToLocator({ geometry: epub.geometry!, sync: epub.sync! }, heard.t) as EpubLocator;
      expect(place.section).toBe(11); // CHAPTER X
      const c = await reader();
      expect((await viewOf(c, heard.id)).hidden).toBe(true);
      await read(c, epub, { ...place, offset: Math.max(0, place.offset - 50) }, { ...place, offset: place.offset + 50 });
      // The audiobook is lined up with the text by chapters only, so its words may really be up to a
      // minute of listening either side of that place: for these few-second tracks, anywhere in
      // chapter X. Reading the chapter opens it.
      expect((await viewOf(c, heard.id)).hidden).toBe(true);
      await read(c, epub, epubAt(11, 0), epubAt(12, 0));
      expect(await viewOf(c, heard.id)).toMatchObject({ hidden: false, text: 'Lobster quadrille!' });
    });

    it('a note on a passage stays a marker until the whole passage is read, then arrives with the progress', async () => {
      // Ana quotes from the end of one page onto the next; Ben has read only the first page.
      const passage = await created(ana, { locator: epubAt(9, 300), endLocator: epubAt(9, 700), quote: 'off with her head', text: 'The Queen at last' });
      const c = await reader();
      await read(c, epub, epubAt(9, 0), epubAt(9, 500));
      const res = await c.get(`/api/books/${book.id}/comments`);
      expect(res.body).not.toContain('The Queen at last');
      expect(res.body).not.toContain('off with her head');
      expect((await viewOf(c, passage.id)).hidden).toBe(true);
      // Turning the page reads the rest of the passage: the note is released with that report.
      const from = epubAt(9, 500);
      const to = epubAt(9, 900);
      const outcome = await c.json<{ revealed: { id: string; text: string | null }[] }>(
        c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }),
        200,
      );
      expect(outcome.revealed.find((v) => v.id === passage.id)).toMatchObject({ text: 'The Queen at last' });
      expect(await viewOf(c, passage.id)).toMatchObject({ hidden: false, quote: 'off with her head' });
    });

    it('a reaction without text is a marker that says there is nothing more to read', async () => {
      const shriek = await created(ana, { locator: epubAt(13, 5), reaction: '😢' });
      const c = await reader();
      expect(await viewOf(c, shriek.id)).toMatchObject({ hidden: true, hasText: false, reaction: '😢' });
    });

    describe('where its writer had read to (D69)', () => {
      it('a note written while paging back, behind where its writer has read, waits for friends to read as far', async () => {
        // Through CHAPTER X (sections 2 to 11), then back to CHAPTER II to write.
        const ahead = await reader();
        await read(ahead, epub, epubAt(2, 0), epubAt(12, 0));
        const lookBack = await created(ahead, { locator: epubAt(3, 100), text: 'Wait until the lobster quadrille!' });
        expect(lookBack).toMatchObject({ hidden: false, text: 'Wait until the lobster quadrille!' });
        const c = await reader();
        await read(c, epub, epubAt(3, 0), epubAt(3, 500));
        const res = await c.get(`/api/books/${book.id}/comments`);
        expect(res.body).not.toContain('quadrille');
        expect(HiddenCommentSchema.parse(res.json<Record<string, unknown>[]>().find((v) => v.id === lookBack.id))).toMatchObject({ hasText: true, horizon: 'Chapter 10' });
        // A page short of where its writer had read is not there yet; reading there opens it, with the progress.
        const length = epub.geometry?.kind === 'epub' ? epub.geometry.sectionLengths[11]! : 0;
        const upTo = async (from: Locator, to: Locator) =>
          c.json<{ revealed: CommentView[] }>(c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);
        expect((await upTo(epubAt(3, 500), epubAt(11, length - 2100))).revealed.some((v) => v.id === lookBack.id)).toBe(false);
        const outcome = await upTo(epubAt(11, length - 2100), epubAt(11, length - 1900));
        expect(outcome.revealed.find((v) => v.id === lookBack.id)).toMatchObject({ hidden: false, text: 'Wait until the lobster quadrille!' });
      });

      it('a note written where its writer is reading opens as before, for a friend whose pages hold fewer words too', async () => {
        // A laptop page (about 2,100 characters) read; notes on it.
        const writer = await reader();
        await read(writer, epub, epubAt(4, 1000), epubAt(4, 3100));
        const onPage = await created(writer, { locator: epubAt(4, 1300), text: 'On my page' });
        const atTop = await created(writer, { locator: epubAt(4, 1020), text: 'At the top of my page' });
        // A phone page (about 860) from the same place reads both.
        const phone = await reader();
        await read(phone, epub, epubAt(4, 1000), epubAt(4, 1860));
        expect(await viewOf(phone, onPage.id)).toMatchObject({ hidden: false, text: 'On my page' });
        expect(await viewOf(phone, atTop.id)).toMatchObject({ hidden: false, text: 'At the top of my page' });
        // The worst case: a note on the first characters of a page longer than a printed one waits
        // for the rest of what it may be about, at most a phone page later.
        const unlucky = await reader();
        await read(unlucky, epub, epubAt(4, 220), epubAt(4, 1080));
        expect(await viewOf(unlucky, atTop.id)).toMatchObject({ hidden: true, horizon: 'Chapter 3' });
        await read(unlucky, epub, epubAt(4, 1080), epubAt(4, 1940));
        expect(await viewOf(unlucky, atTop.id)).toMatchObject({ hidden: false, text: 'At the top of my page' });
      });

      it('a reaction alone, from far ahead, is the spoiler-free marker it always was', async () => {
        const ahead = await reader();
        await read(ahead, epub, epubAt(2, 0), epubAt(12, 0));
        const gasp = await created(ahead, { locator: epubAt(3, 150), reaction: '😱' });
        const c = await reader();
        await read(c, epub, epubAt(3, 0), epubAt(3, 500));
        expect(await viewOf(c, gasp.id)).toMatchObject({ hidden: false, reaction: '😱', text: null });
      });

      describe('only about this passage (fidelity review round 13)', () => {
        // A member who has read through CHAPTER X (sections 2 to 11), and a friend just starting.
        let ahead: Client;
        let friend: Client;
        const progress = (c: Client, from: Locator, to: Locator) =>
          c.json<{ revealed: CommentView[] }>(c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);

        beforeAll(async () => {
          ahead = await reader();
          await read(ahead, epub, epubAt(2, 0), epubAt(12, 0));
          friend = await reader();
        });

        it('a note its writer, far ahead, says is only about this passage opens for a friend who has read its place; one not said so waits', async () => {
          // Back in CHAPTER II, the one far ahead welcomes the friend, and says something else.
          const welcome = await created(ahead, { locator: epubAt(3, 200), text: 'Welcome to the club!', aboutHere: true });
          const plain = await created(ahead, { locator: epubAt(3, 240), text: 'Wait until the trial!' });
          // Its writer is told of no wait for the one about the passage: there is none.
          expect(welcome).toMatchObject({ hidden: false, text: 'Welcome to the club!' });
          expect(welcome).not.toHaveProperty('horizon');
          expect(await viewOf(ahead, welcome.id)).not.toHaveProperty('horizon');
          expect(plain).toMatchObject({ hidden: false, horizon: 'Chapter 10' });
          // Before the friend has read the place, a marker, as for any note.
          const before = await friend.get(`/api/books/${book.id}/comments`);
          expect(before.body).not.toContain('Welcome to the club!');
          expect(HiddenCommentSchema.parse(before.json<Record<string, unknown>[]>().find((v) => v.id === welcome.id))).not.toHaveProperty('horizon');
          // Reading the passage brings it, with the progress; the other waits for CHAPTER X.
          const outcome = await progress(friend, epubAt(3, 0), epubAt(3, 500));
          expect(outcome.revealed.find((v) => v.id === welcome.id)).toMatchObject({ hidden: false, text: 'Welcome to the club!' });
          expect(outcome.revealed.some((v) => v.id === plain.id)).toBe(false);
          expect(await viewOf(friend, welcome.id)).toMatchObject({ hidden: false, text: 'Welcome to the club!' });
          const res = await friend.get(`/api/books/${book.id}/comments`);
          expect(res.body).not.toContain('Wait until the trial!');
          expect(HiddenCommentSchema.parse(res.json<Record<string, unknown>[]>().find((v) => v.id === plain.id))).toMatchObject({ hasText: true, horizon: 'Chapter 10' });
        });

        it('said from where its writer is reading, or of a reaction alone, it changes nothing; said no, a note waits as ever', async () => {
          // The friend, reading CHAPTER II, writes on the page in front of her: no wait either way.
          await read(friend, epub, epubAt(3, 0), epubAt(3, 500));
          const here = await created(friend, { locator: epubAt(3, 450), text: 'Right here', aboutHere: true });
          expect(here).not.toHaveProperty('horizon');
          expect(await viewOf(ahead, here.id)).toMatchObject({ hidden: false, text: 'Right here' });
          // Reactions alone from far ahead open at their place, said to be about it or not.
          const gasp = await created(ahead, { locator: epubAt(3, 300), reaction: '😱', aboutHere: true });
          const sigh = await created(ahead, { locator: epubAt(3, 320), reaction: '😢', aboutHere: false });
          for (const r of [gasp, sigh]) expect(await viewOf(friend, r.id)).toMatchObject({ hidden: false, text: null, reaction: r.reaction });
          const held = await created(ahead, { locator: epubAt(3, 340), text: 'Off with their heads, later', aboutHere: false });
          expect(held).toMatchObject({ horizon: 'Chapter 10' });
          expect(await viewOf(friend, held.id)).toMatchObject({ hidden: true, horizon: 'Chapter 10' });
        });

        it('is a yes or a no', async () => {
          for (const aboutHere of ['yes', 1, null]) {
            const res = await post(ana, { text: 'Only about here', aboutHere });
            expect(res.statusCode, JSON.stringify(aboutHere)).toBe(400);
            expect(errorOf(res).fields).toHaveProperty('aboutHere');
          }
        });
      });
    });
  });

  describe('listing and deleting', () => {
    it('lists comments in timeline order, and the book counts them', async () => {
      const views = await list(owner);
      for (let i = 1; i < views.length; i++) expect(views[i]!.t).toBeGreaterThanOrEqual(views[i - 1]!.t);
      const summary = BookSummarySchema.parse((await owner.json<unknown[]>(owner.get(`/api/clubs/${club.id}/books`), 200)).find((b) => (b as { id: string }).id === book.id));
      expect(summary.commentCount).toBe(views.length);
    });

    it('authors delete their own comments', async () => {
      const mine = await created(ana, { text: 'Never mind' });
      expect((await ana.delete(`/api/comments/${mine.id}`)).statusCode).toBe(204);
      expect((await list(ana)).some((v) => v.id === mine.id)).toBe(false);
      expect((await ana.delete(`/api/comments/${mine.id}`)).statusCode).toBe(404);
      const summary = BookSummarySchema.parse((await owner.json<unknown[]>(owner.get(`/api/clubs/${club.id}/books`), 200)).find((b) => (b as { id: string }).id === book.id));
      expect(summary.commentCount).toBe((await list(owner)).length);
    });

    it('members cannot delete someone else’s comment (403)', async () => {
      const owners = await created(owner, { text: 'Owner speaks' });
      const res = await ben.delete(`/api/comments/${owners.id}`);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).message).toBe('You can only delete your own comments.');
      expect((await list(owner)).some((v) => v.id === owners.id)).toBe(true);
    });

    it('the owner can delete anyone’s comment', async () => {
      const bens = await created(ben, { text: 'Rude remark' });
      expect((await owner.delete(`/api/comments/${bens.id}`)).statusCode).toBe(204);
      expect((await list(ben)).some((v) => v.id === bens.id)).toBe(false);
    });

    it('a late retry of a deleted comment does not bring it back (409, not a server error)', async () => {
      const first = await created(ben, { text: 'Second thoughts', clientId: 'reuse-me-0001' });
      expect((await ben.delete(`/api/comments/${first.id}`)).statusCode).toBe(204);
      const retry = await post(ben, { text: 'Second thoughts', clientId: 'reuse-me-0001' });
      expect(retry.statusCode).toBe(409);
      expect(errorOf(retry)).toEqual({ code: 'conflict', message: 'That comment was deleted.' });
      expect((await list(ben)).some((v) => !v.hidden && v.text === 'Second thoughts')).toBe(false);
    });

    it('a client id names one comment: reusing it on another book is a conflict (409), not a server error', async () => {
      const here = await created(ben, { text: 'On Alice', clientId: 'one-id-per-comment' });
      const pdf = pdfBook.editions[0]!;
      const elsewhere = await post(ben, { editionId: pdf.id, locator: { kind: 'pdf', page: 2, y: 0 }, text: 'On the PDF', clientId: 'one-id-per-comment' }, pdfBook.id);
      expect(elsewhere.statusCode).toBe(409);
      expect(errorOf(elsewhere).message).toBe('That client id belongs to a comment on another book.');
      expect((await list(ben, pdfBook.id)).some((v) => !v.hidden && v.text === 'On the PDF')).toBe(false);
      expect(await viewOf(ben, here.id)).toMatchObject({ hidden: false, text: 'On Alice' });
    });

    it('malformed comment ids are 400, unknown ones 404', async () => {
      expect((await owner.delete('/api/comments/!')).statusCode).toBe(400);
      expect((await owner.delete('/api/comments/doesNotExist1')).statusCode).toBe(404);
    });
  });

  it('notes at one place come in the order they were written', async () => {
    const texts = ['First at the pool', 'Second at the pool', 'Third at the pool', 'Fourth at the pool'];
    for (const text of texts) {
      await owner.json(owner.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: { kind: 'epub', section: 4, offset: 77 }, text }), 201);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    const textOf = (c: CommentView) => ('text' in c ? c.text : null);
    const listed = (await owner.json<CommentView[]>(owner.get(`/api/books/${book.id}/comments`), 200)).filter((c) => texts.includes(textOf(c) ?? ''));
    expect(listed.map(textOf)).toEqual(texts);
  });
});
