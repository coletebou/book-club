import { HistoryListSchema, type BookDetail, type ClubDetail, type Edition, type HistoryList, type Locator } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIN_SITTING_MS,
  PAGE_DWELL_CAP_MS,
  type Piece,
  SITTING_GAP_MS,
  continues,
  deviceOf,
  fold,
  merge,
  mergeable,
  worthShowing,
} from '../src/services/history';
import { ALICE_EPUB, ALICE_TINY_AUDIO, type Client, type TestApp, audioTracks, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const audioPiece = (fromMs: number, toMs: number, since: number, at = since + (toMs - fromMs)): Piece => ({
  fromM: fromMs, toM: toMs, from: { kind: 'audio', track: 0, ms: fromMs }, to: { kind: 'audio', track: 0, ms: toMs }, fromT: fromMs / 1e6, toT: toMs / 1e6, since, at, pages: null,
});
const page = (offset: number, at: number, pages: [number, number] | null = null): Piece => ({
  fromM: offset, toM: offset + 1500, from: { kind: 'epub', section: 3, offset }, to: { kind: 'epub', section: 3, offset: offset + 1500 }, fromT: offset / 1e6, toT: (offset + 1500) / 1e6, since: at, at, pages,
});

describe('a sitting, by the rules (D191)', () => {
  it('listening: the time heard, pauses not counted; a skip back continues it, a jump to another chapter does not', () => {
    let s = fold(null, audioPiece(0, 5_000, 1_000_000), 'audio');
    s = fold(s, audioPiece(5_000, 10_000, 1_005_000), 'audio');
    // Paused three minutes, then on again from where it stopped.
    const later = audioPiece(10_000, 15_000, 1_190_000);
    expect(continues(s, later, 'audio')).toBe(true);
    s = fold(s, later, 'audio');
    expect(s.activeMs).toBe(15_000);
    expect([s.startedAt, s.endedAt, s.fromM, s.toM]).toEqual([1_000_000, 1_195_000, 0, 15_000]);
    expect(continues(s, audioPiece(0, 5_000, 1_200_000), 'audio')).toBe(true); // 15 s back, and back
    expect(continues(s, audioPiece(900_000, 905_000, 1_200_000), 'audio')).toBe(false); // another chapter
  });

  it('reading: the time between pages, a phone put down open counted only up to a cap', () => {
    let s = fold(null, page(0, 0, [100, 100]), 'epub');
    s = fold(s, page(1500, 60_000, [101, 101]), 'epub');
    s = fold(s, page(3000, 120_000, [102, 102]), 'epub');
    expect(s.activeMs).toBe(120_000);
    s = fold(s, page(4500, 120_000 + 9 * 60_000, [103, 103]), 'epub'); // nine minutes on page 102
    expect(s.activeMs).toBe(120_000 + PAGE_DWELL_CAP_MS);
    expect([s.fromPage, s.toPage]).toEqual([100, 103]);
  });

  it('says no pages where the first was not counted yet, rather than a later page in its place', () => {
    let s = fold(null, page(0, 0, null), 'epub'); // the pages still being counted
    s = fold(s, page(9000, 60_000, [101, 101]), 'epub'); // a page further on, not the next
    expect([s.fromPage, s.toPage]).toEqual([null, 101]);
  });

  it('works out the first page from the next one when it reads straight on from it', () => {
    let s = fold(null, page(0, 0, null), 'epub'); // opened before the pages were counted
    s = fold(s, page(1500, 60_000, [101, 101]), 'epub');
    s = fold(s, page(3000, 120_000, [102, 102]), 'epub');
    expect([s.fromPage, s.toPage]).toEqual([100, 102]);
  });

  it('a gap longer than ten minutes starts another sitting', () => {
    const s = fold(null, audioPiece(0, 5_000, 0), 'audio');
    expect(continues(s, audioPiece(5_000, 10_000, 5_000 + SITTING_GAP_MS + 1), 'audio')).toBe(false);
    expect(continues(s, audioPiece(5_000, 10_000, 5_000 + SITTING_GAP_MS - 1), 'audio')).toBe(true);
  });

  it('two sittings that turn out to be one (reports kept offline, sent late) are joined, whichever came first', () => {
    const a = fold(null, audioPiece(0, 60_000, 0), 'audio');
    const b = fold(null, audioPiece(60_000, 120_000, 61_000), 'audio');
    expect(mergeable(b, a, 'audio')).toBe(true);
    expect(merge(b, a, 'audio')).toEqual(merge(a, b, 'audio'));
    // The second began a second after the first ended: a pause that short is listening on (as D65).
    expect(merge(a, b, 'audio')).toEqual(expect.objectContaining({ startedAt: 0, endedAt: 121_000, activeMs: 121_000, fromM: 0, toM: 120_000 }));
  });

  it('adds up the same whatever order its stretches arrive in', () => {
    const pieces = [0, 1, 2, 3, 4].map((i) => audioPiece(i * 5_000, (i + 1) * 5_000, i * 10_000));
    const forward = pieces.reduce<ReturnType<typeof fold> | null>((s, p) => fold(s, p, 'audio'), null)!;
    const backward = [...pieces].reverse().reduce<ReturnType<typeof fold> | null>((s, p) => fold(s, p, 'audio'), null)!;
    expect(backward.activeMs).toBe(forward.activeMs);
    expect(forward.activeMs).toBe(25_000); // five seconds heard, five paused, five times
    expect([backward.startedAt, backward.endedAt, backward.fromM, backward.toM]).toEqual([forward.startedAt, forward.endedAt, forward.fromM, forward.toM]);
  });

  it('a book opened and closed again is not worth a line; a few pages turned through quickly is', () => {
    expect(worthShowing(fold(null, audioPiece(0, 5_000, 0), 'audio'), 'audio')).toBe(false);
    expect(worthShowing(fold(null, audioPiece(0, MIN_SITTING_MS, 0), 'audio'), 'audio')).toBe(true);
    expect(worthShowing(fold(null, page(0, 0, [10, 10]), 'epub'), 'epub')).toBe(false);
    let skim = fold(null, page(0, 0, [10, 10]), 'epub');
    skim = fold(skim, page(1500, 3_000, [11, 11]), 'epub');
    skim = fold(skim, page(3000, 6_000, [12, 12]), 'epub');
    expect(worthShowing(skim, 'epub')).toBe(true);
  });

  it('names the device coarsely, from what the browser says it is', () => {
    expect(deviceOf(IPHONE)).toBe('iPhone');
    expect(deviceOf(`${IPHONE} BookClubApp/1.0`)).toBe('iPhone app');
    expect(deviceOf(MAC)).toBe('Mac');
    expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPad');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36')).toBe('Android');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131')).toBe('Windows');
    expect(deviceOf(undefined)).toBe('Browser');
  });
});

describe('your history, kept by the server (D191)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let book: BookDetail;
  let epub: Edition;
  let audio: Edition;
  let readers = 0;
  const reader = async () => joinClub(t, club, `Historian ${++readers}`);
  const epubAt = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });
  const audioAt = (track: number, ms: number): Locator => ({ kind: 'audio', track, ms });
  const put = (c: Client, edition: Edition, locator: Locator, readSpans: unknown[], at: number, ua = IPHONE) =>
    c.request({ method: 'PUT', url: `/api/books/${book.id}/progress`, payload: { editionId: edition.id, locator, readSpans, at }, headers: { 'user-agent': ua } });
  const history = async (c: Client, url = `/api/books/${book.id}/history`): Promise<HistoryList> => HistoryListSchema.parse(await c.json(c.get(url), 200));
  /** Each whole track heard in turn from `start` (the fixture's tracks are a few seconds each), one report per track, as the player sends them. */
  const heard = (tracks: readonly number[], start: number) => {
    let since = start;
    return tracks.map((i) => {
      const ms = audio.tracks[i]!.durationMs;
      const span = { from: audioAt(i, 0), to: audioAt(i, ms), since, at: since + ms };
      since += ms;
      return span;
    });
  };
  const listen = async (c: Client, spans: ReturnType<typeof heard>, ua = IPHONE) => {
    for (const span of spans) expect((await put(c, audio, span.to, [span], span.at, ua)).statusCode).toBe(200);
  };
  const SIX = [0, 1, 2, 3, 4, 5];
  const msOf = (tracks: readonly number[]) => tracks.reduce((n, i) => n + audio.tracks[i]!.durationMs, 0);

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', audioTracks(ALICE_TINY_AUDIO), { title: 'Alice', author: 'Lewis Carroll', bookId });
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions.find((e) => e.kind === 'epub')!;
    audio = book.editions.find((e) => e.kind === 'audio')!;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('a sitting of pages turned on the phone is one line: where it began and ended, the pages the phone showed, how long, on what', async () => {
    const c = await reader();
    const start = Date.now() - 30 * 60_000;
    for (let i = 0; i < 20; i++) {
      const at = start + i * 90_000;
      expect((await put(c, epub, epubAt(5, i * 500), [{ from: epubAt(5, i * 500), to: epubAt(5, i * 500 + 500), at, pages: [100 + i, 100 + i] }], at)).statusCode).toBe(200);
    }
    const { entries, books, next } = await history(c);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toEqual(expect.objectContaining({ bookId: book.id, editionId: epub.id, kind: 'epub', device: 'iPhone', startedAt: start, endedAt: start + 19 * 90_000, activeMs: 19 * 90_000, from: epubAt(5, 0), to: epubAt(5, 10_000), pages: { from: 100, to: 119 } }));
    expect(entry!.toT).toBeGreaterThan(entry!.fromT);
    expect(books).toEqual([expect.objectContaining({ id: book.id, title: 'Alice', author: 'Lewis Carroll', clubId: club.id })]);
    expect(next).toBeNull();
  });

  it('listening is its own line, timed by what was heard; another device is another line', async () => {
    const c = await reader();
    const start = Date.now() - 20 * 60_000;
    await listen(c, heard(SIX, start), `${IPHONE} BookClubApp/1.0`);
    await put(c, epub, epubAt(4, 0), [{ from: epubAt(4, 0), to: epubAt(4, 1500), at: start + 60_000 }, { from: epubAt(4, 1500), to: epubAt(4, 3000), at: start + 120_000 }], start + 120_000, MAC);
    const { entries } = await history(c);
    expect(entries.map((e) => [e.kind, e.device, e.activeMs])).toEqual([['epub', 'Mac', 60_000], ['audio', 'iPhone app', msOf(SIX)]]);
    expect(entries[1]).toEqual(expect.objectContaining({ from: audioAt(0, 0), to: audioAt(5, audio.tracks[5]!.durationMs), startedAt: start, endedAt: start + msOf(SIX), pages: null }));
  });

  it('reports kept offline and sent late, out of order, still make one sitting, at the times they were read', async () => {
    const c = await reader();
    const start = Date.now() - 3 * 3600_000;
    const spans = heard(SIX, start);
    // The second half arrives first (one device flushed), then the first half, each in one report.
    await put(c, audio, audioAt(5, 0), spans.slice(3), Date.now());
    await put(c, audio, audioAt(2, 0), spans.slice(0, 3), Date.now());
    const { entries } = await history(c);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({ startedAt: start, endedAt: start + msOf(SIX), activeMs: msOf(SIX), from: audioAt(0, 0), to: spans[5]!.to }));
  });

  it('a book opened and closed is not a line; a look is never history (it reports nothing read)', async () => {
    const c = await reader();
    const at = Date.now() - 60_000;
    await put(c, epub, epubAt(2, 0), [{ from: epubAt(2, 0), to: epubAt(2, 1500), at, pages: [12, 12] }], at);
    await put(c, epub, epubAt(9, 0), [], at + 1000); // a look: a place, nothing read
    expect((await history(c)).entries).toEqual([]);
  });

  it('a reader without span times (an older client) is timed by its reports', async () => {
    const c = await reader();
    const start = Date.now() - 10 * 60_000;
    await put(c, epub, epubAt(6, 0), [{ from: epubAt(6, 0), to: epubAt(6, 1500) }], start);
    await put(c, epub, epubAt(6, 1500), [{ from: epubAt(6, 1500), to: epubAt(6, 3000) }], start + 45_000);
    expect((await history(c)).entries).toEqual([expect.objectContaining({ startedAt: start, endedAt: start + 45_000, activeMs: 45_000, pages: null })]);
  });

  it('is yours only: nobody else in the club sees it, an outsider is refused, and you can forget a line or a book', async () => {
    const c = await reader();
    const at = Date.now() - 5 * 60_000;
    await listen(c, heard(SIX, at));
    const mine = await history(c);
    expect(mine.entries).toHaveLength(1);
    // The owner's history has none of it, in the book or across books.
    const theirs = await history(owner);
    expect(theirs.entries.some((e) => e.id === mine.entries[0]!.id)).toBe(false);
    expect((await history(owner, '/api/history')).entries.some((e) => e.id === mine.entries[0]!.id)).toBe(false);
    // Nobody else can forget it either: as if it were not there.
    expect((await owner.delete(`/api/history/${mine.entries[0]!.id}`)).statusCode).toBe(404);
    const stranger = await outsider(t, owner);
    expect((await stranger.get(`/api/books/${book.id}/history`)).statusCode).toBe(404);
    expect((await stranger.delete(`/api/books/${book.id}/history`)).statusCode).toBe(404);
    expect((await history(stranger, '/api/history')).entries).toEqual([]);
    // Forgetting one line.
    expect((await c.delete(`/api/history/${mine.entries[0]!.id}`)).statusCode).toBe(204);
    expect((await history(c)).entries).toEqual([]);
    // Forgetting a whole book's.
    await listen(c, heard(SIX, at + 60_000));
    expect((await history(c)).entries).toHaveLength(1);
    expect((await c.delete(`/api/books/${book.id}/history`)).statusCode).toBe(204);
    expect((await history(c)).entries).toEqual([]);
  });

  it('across books, newest first, a page at a time; a club you left takes its history out of sight', async () => {
    const c = await reader();
    const base = Date.now() - 24 * 3600_000;
    // Five sittings an hour apart.
    for (let i = 0; i < 5; i++) await listen(c, heard(SIX, base + i * 3600_000));
    const first = await history(c, '/api/history?limit=2');
    expect(first.entries.map((e) => e.startedAt)).toEqual([base + 4 * 3600_000, base + 3 * 3600_000]);
    expect(first.next).toBe(first.entries[1]!.endedAt);
    const second = await history(c, `/api/history?limit=2&before=${first.next}`);
    expect(second.entries.map((e) => e.startedAt)).toEqual([base + 2 * 3600_000, base + 3600_000]);
    const all = await history(c, '/api/history');
    expect(all.entries).toHaveLength(5);
    expect(all.next).toBeNull();
    // Leaving the club: the book is no longer one you can open, so neither is its history.
    const me = (await c.json<{ user: { id: string } }>(c.get('/api/me'), 200)).user;
    expect((await owner.delete(`/api/clubs/${club.id}/members/${me.id}`)).statusCode).toBeLessThan(300);
    expect((await history(c, '/api/history')).entries).toEqual([]);
  });

  it('refuses a malformed query', async () => {
    expect((await owner.get('/api/history?limit=0')).statusCode).toBe(400);
    expect((await owner.get('/api/history?before=soon')).statusCode).toBe(400);
  });
});
