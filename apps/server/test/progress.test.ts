import {
  ApiErrorSchema,
  BookProgressSchema,
  BookSummarySchema,
  ProgressUpdateResultSchema,
  locatorToT,
  rangesCoverage,
  type BookDetail,
  type BookProgress,
  type ClubDetail,
  type CommentView,
  type Edition,
  type Locator,
  type ProgressUpdateResult,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  setupOwner,
  uploadBook,
} from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;
const epubAt = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });
const audioAt = (track: number, ms: number): Locator => ({ kind: 'audio', track, ms });
const span = (from: Locator, to: Locator) => ({ from, to });

describe('reading progress', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let book: BookDetail;
  let epub: Edition;
  let audio: Edition;
  let pdfEditionId: string;
  let readers = 0;

  /** A new member with no progress yet. */
  const reader = async () => joinClub(t, club, `Reader ${++readers}`);
  const tOf = (edition: Edition, locator: Locator) => locatorToT({ geometry: edition.geometry!, sync: edition.sync! }, locator);
  const report = async (c: Client, edition: Edition, locator: Locator, spans: { from: Locator; to: Locator }[] = [], at = Date.now()) =>
    ProgressUpdateResultSchema.parse(await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: edition.id, locator, readSpans: spans, at }), 200));
  const progressOf = async (c: Client): Promise<BookProgress> => BookProgressSchema.parse(await c.json(c.get(`/api/books/${book.id}/progress`), 200));
  const comment = async (c: Client, edition: Edition, locator: Locator, text: string) =>
    c.json<CommentView>(c.post(`/api/books/${book.id}/comments`, { editionId: edition.id, locator, text, quote: `quote: ${text}` }), 201);
  const chapterT = (title: string) => book.chapters.find((c) => c.title.startsWith(title))!.t;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', audioTracks(ALICE_TINY_AUDIO), { title: 'Alice', author: 'Lewis Carroll', bookId });
    pdfEditionId = (await uploadBook(owner, club.id, 'pdf', [fileFrom(ALICE_PDF, 'main', 'application/pdf')], { title: 'Other', author: '' })).editionId;
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions.find((e) => e.kind === 'epub')!;
    audio = book.editions.find((e) => e.kind === 'audio')!;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('maps an EPUB position onto the shared timeline and labels it with its chapter', async () => {
    const c = await reader();
    const at = Date.now();
    const { mine, revealed } = await report(c, epub, epubAt(5, 100), [], at);
    expect(mine.t).toBeCloseTo(tOf(epub, epubAt(5, 100)), 12);
    expect(mine).toMatchObject({ editionId: epub.id, locator: epubAt(5, 100), label: 'Chapter 4 · 22%', readRanges: [], furthest: 0, finished: false, at });
    expect(revealed).toEqual([]);
    expect(await progressOf(c)).toMatchObject({ mine });
  });

  it('maps an audio position through the audiobook’s chapter alignment', async () => {
    const c = await reader();
    const { mine } = await report(c, audio, audioAt(4, 0));
    // The start of track 5 is the start of CHAPTER V on everyone's bar.
    expect(mine.t).toBeCloseTo(chapterT('CHAPTER V.'), 9);
    expect(mine.label).toMatch(/^Chapter 5 · \d+%$/);
    const entry = (await progressOf(owner)).members.find((m) => m.t === mine.t)!;
    expect(entry.kind).toBe('audio');
  });

  it('clamps positions past the end of the edition', async () => {
    const c = await reader();
    expect((await report(c, epub, epubAt(99, 999_999))).mine.t).toBe(1);
    expect((await report(c, audio, audioAt(0, 99_999_999))).mine.t).toBeCloseTo(chapterT('CHAPTER II.'), 9);
  });

  it('unions read spans, merging touching ones, in any order', async () => {
    const c = await reader();
    const first = await report(c, epub, epubAt(3, 0), [span(epubAt(3, 0), epubAt(3, 1000)), span(epubAt(3, 3000), epubAt(3, 2000))]);
    expect(first.mine.readRanges).toEqual([
      [tOf(epub, epubAt(3, 0)), tOf(epub, epubAt(3, 1000))],
      [tOf(epub, epubAt(3, 2000)), tOf(epub, epubAt(3, 3000))],
    ]);
    const merged = await report(c, epub, epubAt(3, 2000), [span(epubAt(3, 1000), epubAt(3, 2000))]);
    expect(merged.mine.readRanges).toEqual([[tOf(epub, epubAt(3, 0)), tOf(epub, epubAt(3, 3000))]]);
    expect(merged.mine.furthest).toBe(tOf(epub, epubAt(3, 3000)));
    const entry = (await progressOf(owner)).members.find((m) => m.furthest === merged.mine.furthest)!;
    expect(entry.coverage).toBeCloseTo(rangesCoverage(merged.mine.readRanges), 12);
  });

  it('last writer wins by the client’s clock, but read ranges always grow', async () => {
    const c = await reader();
    const now = Date.now();
    await report(c, epub, epubAt(4, 0), [span(epubAt(4, 0), epubAt(4, 500))], now);
    // A report queued offline an hour ago arrives late: it adds what was read, but does not move the position.
    const late = await report(c, epub, epubAt(8, 0), [span(epubAt(8, 0), epubAt(8, 500))], now - 3600_000);
    expect(late.mine).toMatchObject({ locator: epubAt(4, 0), at: now });
    expect(late.mine.t).toBe(tOf(epub, epubAt(4, 0)));
    expect(late.mine.readRanges).toEqual([
      [tOf(epub, epubAt(4, 0)), tOf(epub, epubAt(4, 500))],
      [tOf(epub, epubAt(8, 0)), tOf(epub, epubAt(8, 500))],
    ]);
    // A newer report (from any edition) moves it.
    const newer = await report(c, audio, audioAt(2, 1000), [], now + 1000);
    expect(newer.mine).toMatchObject({ editionId: audio.id, locator: audioAt(2, 1000), at: now + 1000 });
    expect(newer.mine.readRanges).toHaveLength(2);
  });

  it('keeps the place it has against a report of the same moment from another format (D196)', async () => {
    const c = await reader();
    const at = Date.now();
    // Heard to the millisecond; then a reader opened there reports its page, with the time the
    // narrator was there: it reads that page, but the place stays the narrator's.
    await report(c, audio, audioAt(2, 61_234), [], at);
    const page = await report(c, epub, epubAt(4, 0), [span(epubAt(4, 0), epubAt(4, 500))], at);
    expect(page.mine).toMatchObject({ editionId: audio.id, locator: audioAt(2, 61_234), at });
    // The page it showed is read all the same.
    expect(page.mine.readRanges).toEqual([[tOf(epub, epubAt(4, 0)), tOf(epub, epubAt(4, 500))]]);
    // A moment later is newer, from any format.
    const later = await report(c, epub, epubAt(4, 0), [], at + 1);
    expect(later.mine).toMatchObject({ editionId: epub.id, locator: epubAt(4, 0), at: at + 1 });
  });

  it('returns the comments a report newly reveals, and only once', async () => {
    const shown = await comment(owner, epub, epubAt(6, 50), 'Chapter V secret');
    await comment(owner, epub, epubAt(10, 50), 'Much later');
    const c = await reader();
    const first = await report(c, epub, epubAt(6, 0), [span(epubAt(6, 0), epubAt(6, 1000))]);
    expect(first.revealed).toHaveLength(1);
    expect(first.revealed[0]).toMatchObject({ id: shown.id, hidden: false, text: 'Chapter V secret', quote: 'quote: Chapter V secret' });
    const again = await report(c, epub, epubAt(6, 500), [span(epubAt(6, 0), epubAt(6, 1000))]);
    expect(again.revealed).toEqual([]);
  });

  it('never returns your own comments as revealed', async () => {
    const c = await reader();
    await comment(c, epub, epubAt(12, 10), 'My own note');
    const { revealed } = await report(c, epub, epubAt(12, 0), [span(epubAt(12, 0), epubAt(12, 100))]);
    expect(revealed.map((r) => r.text)).not.toContain('My own note');
  });

  it('“I have read up to here” adds [0, here] and reveals everything before it', async () => {
    const early = await comment(owner, epub, epubAt(3, 10), 'Early remark');
    const c = await reader();
    const res = await c.post(`/api/books/${book.id}/progress/read-up-to`, { editionId: epub.id, locator: epubAt(7, 0) });
    expect(res.statusCode).toBe(200);
    const { mine, revealed } = ProgressUpdateResultSchema.parse(res.json());
    expect(mine.readRanges).toEqual([[0, tOf(epub, epubAt(7, 0))]]);
    expect(mine).toMatchObject({ locator: epubAt(7, 0), editionId: epub.id, finished: false });
    expect(mine.label).toMatch(/^Chapter 6 · /);
    expect(revealed.map((r) => r.id)).toContain(early.id);
    expect(revealed.some((r) => r.text === 'Much later')).toBe(false);
    // Validation: the edition has to be this book's and ready.
    expect((await c.post(`/api/books/${book.id}/progress/read-up-to`, { editionId: pdfEditionId, locator: epubAt(7, 0) })).statusCode).toBe(400);
  });

  it('is finished once the story has been read to its end (not by jumping there), and stays finished', async () => {
    const c = await reader();
    // Section 14 is the licence: its first character is the end of the story (t = 1).
    const jumped = await report(c, epub, epubAt(14, 0), [span(epubAt(13, 0), epubAt(14, 0))]);
    expect(jumped.mine.furthest).toBe(1);
    expect(jumped.mine.finished).toBe(false);
    // Reading the rest of the story (sections 2 to 13) finishes it.
    const done: ProgressUpdateResult = await report(c, epub, epubAt(14, 0), [span(epubAt(2, 0), epubAt(13, 0))], Date.now() + 5);
    expect(done.mine.finished).toBe(true);
    const reread = await report(c, epub, epubAt(3, 0), [span(epubAt(3, 0), epubAt(3, 10))], Date.now() + 10);
    expect(reread.mine.finished).toBe(true);
    // Friends see where they are now, and that they finished.
    const entry = (await progressOf(owner)).members.find((m) => m.furthest === 1 && m.finished)!;
    expect(entry).toMatchObject({ finished: true, kind: 'epub' });
    expect(entry.label).toMatch(/^Chapter 2 · \d+%$/);
  });

  it('lists every member’s progress, with “Not started” for those who have not', async () => {
    const fresh = await reader();
    const freshId = (await fresh.json<{ user: { id: string } }>(fresh.get('/api/me'), 200)).user.id;
    const progress = await progressOf(owner);
    expect(progress.mine).toBeNull();
    const members = (await owner.json<ClubDetail>(owner.get(`/api/clubs/${club.id}`), 200)).members;
    expect(progress.members.map((m) => m.userId)).toEqual(members.map((m) => m.userId));
    expect(progress.members.find((m) => m.userId === freshId)).toEqual({
      userId: freshId,
      displayName: `Reader ${readers}`,
      color: expect.stringMatching(/^#[0-9A-F]{6}$/) as string,
      t: 0,
      furthest: 0,
      coverage: 0,
      kind: null,
      label: 'Not started',
      updatedAt: null,
      finished: false,
    });
    for (const m of progress.members.filter((p) => p.kind !== null)) expect(m.updatedAt).not.toBeNull();
    // The library shows the same bar.
    const summary = BookSummarySchema.parse((await owner.json<unknown[]>(owner.get(`/api/clubs/${club.id}/books`), 200)).find((b) => (b as { id: string }).id === book.id));
    expect(summary.progress).toEqual(progress.members);
  });

  it('a cross-format reader meets comments at the matching place: listening reveals what was written in the EPUB', async () => {
    const near = await comment(owner, epub, epubAt(3, 100), 'Pool of tears, early');
    const far = await comment(owner, epub, epubAt(3, 9000), 'Pool of tears, late');
    const next = await comment(owner, epub, epubAt(4, 100), 'Caucus race, early');
    const listener = await reader();
    // Track 2 is CHAPTER II; three of its five seconds cover the first ~60 % of the chapter. But the
    // audiobook is lined up with the text by chapters only, and inside one its words may really be
    // a minute of listening from where its map puts them: all of this five-second chapter.
    const first = await report(listener, audio, audioAt(1, 3000), [span(audioAt(1, 0), audioAt(1, 3000))]);
    expect(first.revealed.filter((r) => r.id === near.id || r.id === far.id)).toEqual([]);
    // The track's end is the chapter's end, which the map places exactly: the chapter opens, nothing after it.
    const end = audio.tracks[1]!.durationMs;
    const { revealed } = await report(listener, audio, audioAt(1, end), [span(audioAt(1, 3000), audioAt(1, end))]);
    expect(revealed.map((r) => r.id)).toEqual(expect.arrayContaining([near.id, far.id]));
    expect(revealed.map((r) => r.id)).not.toContain(next.id);
    const views = await listener.json<CommentView[]>(listener.get(`/api/books/${book.id}/comments`), 200);
    expect(views.find((v) => v.id === next.id)).toMatchObject({ hidden: true });
  });

  describe('validation', () => {
    let c: Client;
    beforeAll(async () => {
      c = await reader();
    });

    it.each([
      ['an edition of another book', (): unknown => ({ editionId: pdfEditionId, locator: epubAt(0, 0), readSpans: [], at: Date.now() }), 'That edition does not belong to this book.'],
      ['an unknown edition', () => ({ editionId: 'unknownEdition', locator: epubAt(0, 0), readSpans: [], at: Date.now() }), 'That edition does not belong to this book.'],
      ['a PDF position in the EPUB', () => ({ editionId: epub.id, locator: { kind: 'pdf', page: 1, y: 0 }, readSpans: [], at: Date.now() }), 'A pdf position does not belong to this epub edition.'],
      [
        'a span in another format',
        () => ({ editionId: epub.id, locator: epubAt(1, 0), readSpans: [span(audioAt(0, 0), audioAt(0, 10))], at: Date.now() }),
        'A audio position does not belong to this epub edition.',
      ],
      ['no client time', () => ({ editionId: epub.id, locator: epubAt(1, 0), readSpans: [] }), undefined],
      ['a client time of zero', () => ({ editionId: epub.id, locator: epubAt(1, 0), readSpans: [], at: 0 }), undefined],
      ['a negative offset', () => ({ editionId: epub.id, locator: epubAt(1, -5), readSpans: [], at: Date.now() }), undefined],
      [
        'too many spans at once',
        () => ({ editionId: epub.id, locator: epubAt(1, 0), readSpans: Array.from({ length: 65 }, () => span(epubAt(1, 0), epubAt(1, 1))), at: Date.now() }),
        undefined,
      ],
    ])('refuses %s (400)', async (_label, body, message) => {
      const res = await c.put(`/api/books/${book.id}/progress`, body());
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('bad_request');
      if (message) expect(errorOf(res).message).toBe(message);
      expect((await progressOf(c)).mine).toBeNull();
    });
  });

  describe('the page-hide beacon', () => {
    it('accepts the text/plain body navigator.sendBeacon sends', async () => {
      const c = await reader();
      const body = JSON.stringify({ editionId: epub.id, locator: epubAt(9, 42), readSpans: [span(epubAt(9, 0), epubAt(9, 42))], at: Date.now() });
      const res = await c.post(`/api/books/${book.id}/progress/beacon`, body, { 'content-type': 'text/plain;charset=UTF-8' });
      expect(res.statusCode).toBe(204);
      const { mine } = await progressOf(c);
      expect(mine).toMatchObject({ locator: epubAt(9, 42), editionId: epub.id });
      expect(mine!.readRanges).toEqual([[tOf(epub, epubAt(9, 0)), tOf(epub, epubAt(9, 42))]]);
      // JSON works too.
      expect((await c.post(`/api/books/${book.id}/progress/beacon`, JSON.parse(body) as unknown)).statusCode).toBe(204);
    });

    it('answers a malformed beacon with 400, not a server error', async () => {
      const c = await reader();
      for (const body of ['not json at all', '{"editionId":', '']) {
        const res = await c.post(`/api/books/${book.id}/progress/beacon`, body, { 'content-type': 'text/plain' });
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(errorOf(res).code).toBe('bad_request');
      }
      const wrongShape = await c.post(`/api/books/${book.id}/progress/beacon`, JSON.stringify({ hello: 'world' }), { 'content-type': 'text/plain' });
      expect(wrongShape.statusCode).toBe(400);
      expect((await progressOf(c)).mine).toBeNull();
    });
  });
});
