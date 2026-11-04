import { QueryClient } from '@tanstack/react-query';
import {
  type BookProgress,
  type CommentView,
  LIMITS,
  type Locator,
  type MyProgress,
  type ProgressUpdateBody,
  type ProgressUpdateResult,
  type ReadSpanInput,
  type RevealedComment,
  type SessionInfo,
} from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OutboxEntry, clearLocalData } from './db';
import { adoptUnsavedProgress, bindOutbox, coalesceSpans, flushOutbox, localPosition, mergeEntry, pendingCount, rememberPosition, saveProgress, saveProgressNow, startOutbox } from './outbox';
import { keys } from './queries';

/* Positions and spans ------------------------------------------------------------------------ */

const epub = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });
const pdf = (page: number, y: number): Locator => ({ kind: 'pdf', page, y });
const audio = (track: number, ms: number): Locator => ({ kind: 'audio', track, ms });
const span = (from: Locator, to: Locator): ReadSpanInput => ({ from, to });

/** (unit, offset) of a locator, compared lexicographically: the order inside one edition. */
function key(l: Locator): [number, number] {
  return l.kind === 'epub' ? [l.section, l.offset] : l.kind === 'pdf' ? [l.page, l.y] : [l.track, l.ms];
}
const le = (a: Locator, b: Locator) => {
  const [x0, x1] = key(a);
  const [y0, y1] = key(b);
  return x0 < y0 || (x0 === y0 && x1 <= y1);
};
/** Is `s` entirely inside one of `have`? */
const covered = (have: readonly ReadSpanInput[], s: ReadSpanInput) => have.some((h) => le(h.from, s.from) && le(s.to, h.to));

/** n spans with gaps between them, one per section: nothing can be coalesced. */
const disjointSpans = (n: number) => Array.from({ length: n }, (_, i) => span(epub(i, 10), epub(i, 20)));

const BOOK = 'book_alice';
const EPUB_EDITION = 'ed_epub_1';

const report = (over: Partial<Parameters<typeof saveProgress>[0]> = {}): Parameters<typeof saveProgress>[0] => ({
  bookId: BOOK,
  editionId: EPUB_EDITION,
  locator: epub(2, 100),
  at: 1_000,
  spans: [],
  ...over,
});

/* A stand-in for the progress endpoint --------------------------------------------------------- */

const mine = (over: Partial<MyProgress> = {}): MyProgress => ({
  editionId: EPUB_EDITION,
  locator: epub(2, 100),
  t: 0.2,
  label: 'Chapter 1 · 20%',
  readRanges: [[0, 0.2]],
  furthest: 0.2,
  finished: false,
  at: 1_000,
  ...over,
});

const result = (over: Partial<ProgressUpdateResult> = {}): ProgressUpdateResult => ({ mine: mine(), revealed: [], ...over });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number) => json({ error: { code: 'refused', message: `refused with ${status}` } }, status);

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: ProgressUpdateBody;
}

/**
 * Replace `fetch` with a progress endpoint that records every request and answers with `answer`
 * (by default: accepted). Requests the outbox makes are always JSON PUTs.
 */
function progressEndpoint(answer: (body: ProgressUpdateBody, n: number) => Response | Promise<Response> = () => json(result())) {
  const sent: Sent[] = [];
  const headers: Headers[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(init!.body as string) as ProgressUpdateBody;
    sent.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, method: init?.method ?? 'GET', body });
    headers.push(new Headers(init?.headers));
    return answer(body, sent.length);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { sent, headers, fetchMock };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const offline = () => Promise.reject(new TypeError('Failed to fetch'));

const revealed = (id: string, t: number): RevealedComment => ({
  id,
  bookId: BOOK,
  userId: 'user_ana',
  authorName: 'Ana',
  color: '#FF6B6B',
  t,
  editionId: EPUB_EDITION,
  kind: 'epub',
  locator: epub(2, 50),
  reaction: null,
  createdAt: '2026-10-23T12:00:00.000Z',
  hidden: false,
  endLocator: null,
  endT: null,
  quote: null,
  text: `note ${id}`,
});

/* Environment --------------------------------------------------------------------------------- */

const ANA = 'user_ana';
const BEN = 'user_ben';

/** A query cache holding the session of `userId` (or of nobody), as the app's shell has it. */
function sessionOf(userId: string | null): QueryClient {
  const qc = new QueryClient();
  signIn(qc, userId);
  return qc;
}

function signIn(qc: QueryClient, userId: string | null): void {
  qc.setQueryData<SessionInfo>(keys.session, {
    user: userId ? { id: userId, displayName: userId.replace('user_', ''), email: `${userId}@example.com`, color: '#FF6B6B', source: 'local' } : null,
    setupRequired: false,
    upstream: null,
  });
}

let clock = 1_700_000_000_000;
/** The session the outbox sees: Ana is signed in unless a test says otherwise. */
let qc: QueryClient;

beforeEach(async () => {
  await clearLocalData();
  // Every merge gets its own millisecond (see the same-millisecond test for what happens otherwise).
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
  qc = sessionOf(ANA);
  bindOutbox(qc);
});

afterEach(async () => {
  // Never leave a flush running into the next test.
  await flushOutbox();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* mergeEntry ----------------------------------------------------------------------------------- */

describe('mergeEntry', () => {
  const next = (over: Partial<Omit<OutboxEntry, 'key' | 'updatedAt'>> = {}) => ({ bookId: BOOK, editionId: EPUB_EDITION, locator: epub(2, 100), at: 1_000, spans: [], ...over });

  it('turns a first report into an entry keyed by person, book and edition', () => {
    const entry = mergeEntry(undefined, next({ spans: [span(epub(2, 0), epub(2, 100))] }));
    expect(entry).toEqual({
      key: `|${BOOK}|${EPUB_EDITION}`,
      bookId: BOOK,
      editionId: EPUB_EDITION,
      locator: epub(2, 100),
      at: 1_000,
      spans: [span(epub(2, 0), epub(2, 100))],
      updatedAt: clock,
      rev: 1,
    });
    // Keyed by whose it is too: two people's reports for one edition are two entries.
    expect(mergeEntry(undefined, next({ userId: ANA })).key).toBe(`${ANA}|${BOOK}|${EPUB_EDITION}`);
  });

  it('keeps whose reading the entry is', () => {
    expect(mergeEntry(undefined, next({ userId: ANA })).userId).toBe(ANA);
    expect(mergeEntry(undefined, next())).not.toHaveProperty('userId');
  });

  it('keeps the newest position whichever order the reports arrive in', () => {
    const newer = mergeEntry(undefined, next({ locator: epub(5, 0), at: 2_000 }));
    const olderArrivesLate = mergeEntry(newer, next({ locator: epub(1, 0), at: 1_000 }));
    expect(olderArrivesLate.locator).toEqual(epub(5, 0));
    expect(olderArrivesLate.at).toBe(2_000);

    const newerArrivesLate = mergeEntry(mergeEntry(undefined, next({ locator: epub(1, 0), at: 1_000 })), next({ locator: epub(5, 0), at: 2_000 }));
    expect(newerArrivesLate.locator).toEqual(epub(5, 0));
    expect(newerArrivesLate.at).toBe(2_000);
  });

  it('lets a report with the same time replace the position (the later report wins a tie)', () => {
    const entry = mergeEntry(mergeEntry(undefined, next({ locator: epub(1, 0), at: 1_000 })), next({ locator: epub(1, 40), at: 1_000 }));
    expect(entry.locator).toEqual(epub(1, 40));
  });

  it('accumulates the spans of every report, including the older ones', () => {
    const a = span(epub(1, 0), epub(1, 100));
    const b = span(epub(3, 0), epub(3, 100));
    const entry = mergeEntry(mergeEntry(undefined, next({ spans: [a], at: 2_000 })), next({ spans: [b], at: 1_000 }));
    expect(entry.spans).toHaveLength(2);
    expect(entry.spans).toEqual(expect.arrayContaining([a, b]));
  });

  it('marks every merge as a new version of the entry', () => {
    const first = mergeEntry(undefined, next());
    const second = mergeEntry(first, next({ at: 2_000 }));
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('coalesces touching page spans once there are more than one request can carry', () => {
    const pages = Array.from({ length: 100 }, (_, i) => span(epub(4, i * 100), epub(4, (i + 1) * 100)));
    const entry = mergeEntry(undefined, next({ spans: pages }));
    expect(entry.spans).toEqual([span(epub(4, 0), epub(4, 10_000))]);
  });

  it('never drops a span: 200 separate spans in, all 200 still covered', () => {
    let entry: OutboxEntry | undefined;
    const spans = disjointSpans(200);
    for (const s of spans) entry = mergeEntry(entry, next({ spans: [s] }));
    expect(entry!.spans.length).toBeGreaterThan(LIMITS.readSpansPerUpdate);
    for (const s of spans) expect(covered(entry!.spans, s), JSON.stringify(s)).toBe(true);
  });

  it('never drops a span when long offline reading mixes overlapping and separate spans', () => {
    // 200 page turns: overlapping pairs (re-reading) in some sections, gaps elsewhere.
    const spans = Array.from({ length: 200 }, (_, i) => {
      const section = Math.floor(i / 4);
      const start = (i % 4) * 90 + (section % 2 === 0 ? 0 : (i % 4) * 50);
      return span(epub(section, start), epub(section, start + 100));
    });
    let entry: OutboxEntry | undefined;
    for (const s of spans) entry = mergeEntry(entry, next({ spans: [s] }));
    for (const s of spans) expect(covered(entry!.spans, s), JSON.stringify(s)).toBe(true);
  });
});

/* coalesceSpans -------------------------------------------------------------------------------- */

describe('coalesceSpans', () => {
  it('keeps when spans run together were read, and their pages, for your history (D191)', () => {
    // One edition's spans at a time, as an outbox entry holds them.
    expect(coalesceSpans([
      { ...span(epub(1, 0), epub(1, 100)), at: 1_000, pages: [10, 10] },
      { ...span(epub(1, 100), epub(1, 200)), at: 61_000, pages: [11, 11] },
    ])).toEqual([{ ...span(epub(1, 0), epub(1, 200)), since: 1_000, at: 61_000, pages: [10, 11] }]);
    expect(coalesceSpans([
      { ...span(audio(0, 5_000), audio(0, 10_000)), since: 105_000, at: 110_000 },
      { ...span(audio(0, 0), audio(0, 5_000)), since: 100_000, at: 105_000 },
    ])).toEqual([{ ...span(audio(0, 0), audio(0, 10_000)), since: 100_000, at: 110_000 }]);
  });

  it('merges overlapping spans in a section', () => {
    expect(coalesceSpans([span(epub(1, 0), epub(1, 100)), span(epub(1, 50), epub(1, 150))])).toEqual([span(epub(1, 0), epub(1, 150))]);
  });

  it('merges spans that touch (one page ends where the next begins)', () => {
    expect(coalesceSpans([span(epub(1, 0), epub(1, 100)), span(epub(1, 100), epub(1, 200))])).toEqual([span(epub(1, 0), epub(1, 200))]);
  });

  it('absorbs a span that lies inside another', () => {
    expect(coalesceSpans([span(epub(1, 0), epub(1, 300)), span(epub(1, 100), epub(1, 200))])).toEqual([span(epub(1, 0), epub(1, 300))]);
  });

  it('keeps spans with a gap between them apart', () => {
    const spans = [span(epub(1, 0), epub(1, 100)), span(epub(1, 101), epub(1, 200))];
    expect(coalesceSpans(spans)).toEqual(spans);
  });

  it('keeps spans in different sections, pages or tracks apart', () => {
    const sections = [span(epub(0, 0), epub(0, 500)), span(epub(1, 0), epub(1, 100))];
    expect(coalesceSpans(sections)).toEqual(sections);
    const pages = [span(pdf(3, 0), pdf(3, 1)), span(pdf(4, 0), pdf(4, 0.5))];
    expect(coalesceSpans(pages)).toEqual(pages);
    const tracks = [span(audio(0, 0), audio(0, 5_000)), span(audio(1, 0), audio(1, 1_000))];
    expect(coalesceSpans(tracks)).toEqual(tracks);
  });

  it('joins a span that runs on into the next section with what it overlaps there', () => {
    expect(coalesceSpans([span(epub(0, 900), epub(1, 50)), span(epub(1, 20), epub(1, 80))])).toEqual([span(epub(0, 900), epub(1, 80))]);
  });

  it('coalesces PDF and audio positions within a page or a track', () => {
    expect(coalesceSpans([span(pdf(2, 0.5), pdf(2, 0.9)), span(pdf(2, 0.2), pdf(2, 0.6))])).toEqual([span(pdf(2, 0.2), pdf(2, 0.9))]);
    expect(coalesceSpans([span(audio(3, 1_000), audio(3, 4_000)), span(audio(3, 4_000), audio(3, 9_000))])).toEqual([span(audio(3, 1_000), audio(3, 9_000))]);
  });

  it('gives the same, ordered result whatever the input order', () => {
    const spans = [span(epub(2, 300), epub(2, 400)), span(epub(0, 0), epub(0, 10)), span(epub(2, 0), epub(2, 310)), span(epub(1, 5), epub(1, 6))];
    const expected = [span(epub(0, 0), epub(0, 10)), span(epub(1, 5), epub(1, 6)), span(epub(2, 0), epub(2, 400))];
    expect(coalesceSpans(spans)).toEqual(expected);
    expect(coalesceSpans([...spans].reverse())).toEqual(expected);
  });

  it('does not change its input', () => {
    const spans = [span(epub(1, 50), epub(1, 150)), span(epub(1, 0), epub(1, 100))];
    const copy = structuredClone(spans);
    coalesceSpans(spans);
    expect(spans).toEqual(copy);
  });
});

/* Saving and sending --------------------------------------------------------------------------- */

describe('saveProgress and flushOutbox', () => {
  it('sends a report to the server and removes it once the server has it', async () => {
    const { sent } = progressEndpoint();
    const spans = [span(epub(2, 0), epub(2, 100))];
    await saveProgress(report({ spans }));
    await flushOutbox();
    expect(sent).toEqual([
      { url: `/api/books/${BOOK}/progress`, method: 'PUT', body: { editionId: EPUB_EDITION, locator: epub(2, 100), readSpans: spans, at: 1_000 } },
    ]);
    expect(await pendingCount()).toBe(0);
  });

  it('remembers the position on this device as well', async () => {
    progressEndpoint();
    await saveProgress(report({ locator: epub(7, 12), at: 5_000 }));
    expect(await localPosition(BOOK)).toEqual({ bookId: BOOK, editionId: EPUB_EDITION, locator: epub(7, 12), at: 5_000, userId: ANA });
    expect(await localPosition('another_book')).toBeUndefined();
  });

  it('keeps the report queued until the server has confirmed it', async () => {
    const answer = deferred<Response>();
    const { fetchMock } = progressEndpoint(() => answer.promise);
    await saveProgress(report());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await pendingCount()).toBe(1);
    answer.resolve(json(result()));
    await flushOutbox();
    expect(await pendingCount()).toBe(0);
  });

  it('keeps the report when the network is gone, and sends it on the next flush', async () => {
    const { sent } = progressEndpoint(offline);
    await saveProgress(report({ spans: [span(epub(2, 0), epub(2, 100))] }));
    await flushOutbox();
    expect(sent).toHaveLength(1);
    expect(await pendingCount()).toBe(1);

    const { sent: resent } = progressEndpoint();
    await flushOutbox();
    expect(resent).toHaveLength(1);
    expect(resent[0]!.body).toEqual(sent[0]!.body);
    expect(await pendingCount()).toBe(0);
  });

  it.each([500, 502, 503, 401, 429])('keeps the report when the server answers %i (try again later)', async (status) => {
    const { sent } = progressEndpoint(() => refusal(status));
    await saveProgress(report());
    await flushOutbox();
    expect(sent).toHaveLength(1);
    expect(await pendingCount()).toBe(1);
  });

  it('keeps the report, and stops, when the device’s session has become someone else’s', async () => {
    const { sent, headers } = progressEndpoint(() => json({ error: { code: 'session_changed', message: 'Someone else is signed in on this device now.' } }, 409));
    await saveProgress(report());
    await flushOutbox();
    expect(sent).toHaveLength(1);
    // Sent as the person whose reading it is, so the server could refuse it.
    expect(headers[0]!.get('X-Bookclub-User')).toBe('user_ana');
    expect(await pendingCount()).toBe(1);
  });

  it.each([400, 403, 404, 422])('drops the report when the server refuses it with %i', async (status) => {
    const { sent } = progressEndpoint(() => refusal(status));
    await saveProgress(report());
    await flushOutbox();
    expect(sent).toHaveLength(1);
    expect(await pendingCount()).toBe(0);
    // And it is never sent again.
    await flushOutbox();
    expect(sent).toHaveLength(1);
  });

  it('a refused report does not hold back the others', async () => {
    progressEndpoint(offline);
    await saveProgress(report({ editionId: 'ed_gone' }));
    await saveProgress(report({ bookId: 'book_two' }));
    await flushOutbox();
    expect(await pendingCount()).toBe(2);

    // One pass over the queue: the refused report comes first (keys sort by book id).
    const { sent } = progressEndpoint((body) => (body.editionId === 'ed_gone' ? refusal(404) : json(result())));
    await flushOutbox();
    expect(sent.map((s) => s.url)).toEqual([`/api/books/${BOOK}/progress`, '/api/books/book_two/progress']);
    expect(await pendingCount()).toBe(0);
  });

  it('merges reports made offline for one edition into one request with the newest position', async () => {
    progressEndpoint(offline);
    const a = span(epub(2, 0), epub(2, 100));
    const b = span(epub(2, 100), epub(2, 200));
    await saveProgress(report({ locator: epub(2, 100), at: 1_000, spans: [a] }));
    await saveProgress(report({ locator: epub(2, 200), at: 2_000, spans: [b] }));
    await flushOutbox();
    expect(await pendingCount()).toBe(1);

    const { sent } = progressEndpoint();
    await flushOutbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.locator).toEqual(epub(2, 200));
    expect(sent[0]!.body.at).toBe(2_000);
    expect(sent[0]!.body.readSpans).toEqual(expect.arrayContaining([a, b]));
  });

  it(`sends a long offline stretch in several requests of at most ${LIMITS.readSpansPerUpdate} spans, losing none`, async () => {
    const { sent } = progressEndpoint();
    const spans = disjointSpans(200);
    await saveProgress(report({ spans }));
    await flushOutbox();
    expect(sent.length).toBe(Math.ceil(200 / LIMITS.readSpansPerUpdate));
    for (const s of sent) {
      expect(s.body.readSpans.length).toBeLessThanOrEqual(LIMITS.readSpansPerUpdate);
      expect(s.body.locator).toEqual(epub(2, 100));
      expect(s.body.at).toBe(1_000);
    }
    const all = sent.flatMap((s) => s.body.readSpans);
    for (const s of spans) expect(covered(all, s), JSON.stringify(s)).toBe(true);
    expect(await pendingCount()).toBe(0);
  });

  it('keeps the whole long report when one of its requests fails, and sends it all again later', async () => {
    const { sent } = progressEndpoint((_body, n) => (n === 2 ? offline() : json(result())));
    const spans = disjointSpans(150);
    await saveProgress(report({ spans }));
    await flushOutbox();
    expect(sent).toHaveLength(2);
    expect(await pendingCount()).toBe(1);

    const { sent: retry } = progressEndpoint();
    await flushOutbox();
    const all = retry.flatMap((s) => s.body.readSpans);
    for (const s of spans) expect(covered(all, s)).toBe(true);
    expect(await pendingCount()).toBe(0);
  });

  it('sends a report for another book queued while a flush is running in that same flush', async () => {
    const first = deferred<Response>();
    const { sent, fetchMock } = progressEndpoint((_body, n) => (n === 1 ? first.promise : json(result())));
    await saveProgress(report());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const flush = flushOutbox(); // the flush under way

    await saveProgress(report({ bookId: 'book_two', locator: epub(9, 9) }));
    first.resolve(json(result()));
    await flush;

    expect(sent.map((s) => s.url)).toEqual([`/api/books/${BOOK}/progress`, '/api/books/book_two/progress']);
    expect(await pendingCount()).toBe(0);
  });

  it('sends a newer report for the same edition, merged while the older one was on its way, in that same flush', async () => {
    const first = deferred<Response>();
    const { sent, fetchMock } = progressEndpoint((_body, n) => (n === 1 ? first.promise : json(result())));
    const a = span(epub(2, 0), epub(2, 100));
    const b = span(epub(2, 100), epub(2, 200));
    await saveProgress(report({ locator: epub(2, 100), at: 1_000, spans: [a] }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const flush = flushOutbox();

    await saveProgress(report({ locator: epub(2, 200), at: 2_000, spans: [b] }));
    first.resolve(json(result()));
    await flush;

    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.locator).toEqual(epub(2, 200));
    expect(sent[1]!.body.readSpans).toEqual(expect.arrayContaining([b]));
    expect(await pendingCount()).toBe(0);
  });

  // BUG (lib/outbox.ts, sendQueued): after a send, the entry is deleted when its `updatedAt` still
  // equals the one that was sent. `updatedAt` is `Date.now()` (lib/outbox.ts mergeEntry), which is
  // not unique: a newer report merged in the same millisecond as the one being sent (likelier on a
  // browser that coarsens its clock for privacy, such as Firefox with resistFingerprinting or Tor
  // Browser) carries the same value, so it is deleted unsent and its position and spans are lost.
  // A per-entry revision counter (or comparing the entry's content) would not collide.
  it('does not lose a report merged in the same millisecond as the one being sent', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(clock);
    const first = deferred<Response>();
    const { sent, fetchMock } = progressEndpoint((_body, n) => (n === 1 ? first.promise : json(result())));
    await saveProgress(report({ locator: epub(2, 100), at: 1_000, spans: [span(epub(2, 0), epub(2, 100))] }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const flush = flushOutbox();

    await saveProgress(report({ locator: epub(3, 0), at: 2_000, spans: [span(epub(2, 100), epub(3, 0))] }));
    first.resolve(json(result()));
    await flush;

    expect(sent.at(-1)!.body.locator).toEqual(epub(3, 0));
  });

  it('settles quietly, and sends directly, when IndexedDB is unavailable (private mode)', async () => {
    await clearLocalData();
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('IndexedDB is disabled', 'InvalidStateError');
      },
    });
    const { sent } = progressEndpoint();
    const spans = [span(epub(1, 0), epub(1, 10))];
    await saveProgress(report({ spans }));
    expect(sent).toEqual([{ url: `/api/books/${BOOK}/progress`, method: 'PUT', body: { editionId: EPUB_EDITION, locator: epub(2, 100), readSpans: spans, at: 1_000 } }]);
    await expect(flushOutbox()).resolves.toBeUndefined();
    expect(await pendingCount()).toBe(0);
    expect(await localPosition(BOOK)).toBeUndefined();
  });
});

describe('rememberPosition and localPosition', () => {
  it('keep the latest position of each book on this device', async () => {
    await rememberPosition({ bookId: 'b1', editionId: 'e1', locator: epub(1, 1), at: 10, userId: ANA });
    await rememberPosition({ bookId: 'b2', editionId: 'e2', locator: pdf(4, 0.5), at: 20, userId: ANA });
    await rememberPosition({ bookId: 'b1', editionId: 'e3', locator: audio(2, 3_000), at: 30, userId: ANA });
    expect(await localPosition('b1')).toEqual({ bookId: 'b1', editionId: 'e3', locator: audio(2, 3_000), at: 30, userId: ANA });
    expect(await localPosition('b2')).toEqual({ bookId: 'b2', editionId: 'e2', locator: pdf(4, 0.5), at: 20, userId: ANA });
  });

  it('only give the signed-in person their own place (a shared device)', async () => {
    await rememberPosition({ bookId: 'b1', editionId: 'e1', locator: epub(1, 1), at: 10, userId: ANA });
    await rememberPosition({ bookId: 'b2', editionId: 'e2', locator: epub(2, 2), at: 10 }); // saved before positions had an owner
    signIn(qc, BEN);
    expect(await localPosition('b1')).toBeUndefined();
    signIn(qc, null);
    expect(await localPosition('b1')).toBeUndefined();
    signIn(qc, ANA);
    expect(await localPosition('b1')).toMatchObject({ locator: epub(1, 1) });
    expect(await localPosition('b2')).toBeUndefined();
  });
});

/* Whose reading -------------------------------------------------------------------------------- */

describe('reading on a shared device', () => {
  it('keeps and sends nothing while nobody is signed in (a player still reporting after sign-out)', async () => {
    signIn(qc, null);
    const { sent } = progressEndpoint();
    await saveProgress(report());
    await flushOutbox();
    expect(sent).toHaveLength(0);
    expect(await pendingCount()).toBe(0);
    signIn(qc, ANA);
    expect(await localPosition(BOOK)).toBeUndefined();
  });

  it('keeps nothing before the app knows whose session it is', async () => {
    bindOutbox(new QueryClient());
    const { sent } = progressEndpoint();
    await saveProgress(report());
    expect(sent).toHaveLength(0);
    expect(await pendingCount()).toBe(0);
  });

  it("never sends one person's queued reading under another's session: it is deleted", async () => {
    progressEndpoint(offline);
    await saveProgress(report());
    await flushOutbox();
    expect(await pendingCount()).toBe(1);

    signIn(qc, BEN);
    const { sent } = progressEndpoint();
    await flushOutbox();
    expect(sent).toHaveLength(0);
    expect(await pendingCount()).toBe(0);
  });

  it("drops another person's entries at the next flush, even offline, and sends only the signed-in person's", async () => {
    progressEndpoint(offline);
    await saveProgress(report({ bookId: 'book_1' }));
    await flushOutbox();
    signIn(qc, BEN);
    await saveProgress(report({ bookId: 'book_2', locator: epub(8, 8) }));
    await flushOutbox();
    expect(await pendingCount()).toBe(1); // Ana's is gone; Ben's waits for the network

    const { sent } = progressEndpoint();
    await flushOutbox();
    expect(sent.map((x) => x.url)).toEqual(['/api/books/book_2/progress']);
    expect(await pendingCount()).toBe(0);
  });

  it('holds queued reading, without deleting it, while signed out, and sends it when its owner is back', async () => {
    progressEndpoint(offline);
    await saveProgress(report());
    await flushOutbox();

    signIn(qc, null);
    const { sent } = progressEndpoint();
    await flushOutbox();
    expect(sent).toHaveLength(0);
    expect(await pendingCount()).toBe(1);

    signIn(qc, ANA);
    await flushOutbox();
    expect(sent).toHaveLength(1);
    expect(await pendingCount()).toBe(0);
  });

  // BUG (lib/outbox.ts, saveProgress + mergeEntry): entries are keyed by book|edition only, and
  // saveProgress merges a new report into whatever entry has that key, then stamps the result with
  // the new reader's userId. So when one person's unsent entry is still on the device and someone
  // else reads the same edition, the first person's spans (and, if their report is newer, their
  // position) are merged into the second person's entry and sent under the second person's
  // session: exactly what the per-entry userId check in sendQueued exists to prevent. In the app
  // RequireAuth (App.tsx) wipes the device when the person changes, so this needs an entry that
  // wipe missed; the outbox's own rule does not hold by itself. A report from another person
  // should replace the entry (or the key should include the user), never merge into it.
  it("never merges one person's unsent reading into another person's report for the same edition", async () => {
    progressEndpoint(offline);
    await saveProgress(report({ at: 1_000, spans: [span(epub(2, 0), epub(2, 100))] }));
    await flushOutbox(); // settled under Ana's session: her entry waits for the network
    signIn(qc, BEN);
    await saveProgress(report({ at: 2_000, locator: epub(5, 5), spans: [span(epub(5, 0), epub(5, 5))] }));
    await flushOutbox();

    const { sent } = progressEndpoint();
    await flushOutbox();
    // Ben's report goes out under Ben's session, and never carries Ana's reading.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.readSpans).toEqual([span(epub(5, 0), epub(5, 5))]);
  });
});

/* startOutbox ---------------------------------------------------------------------------------- */

describe('progress kept as a page closes', () => {
  it('is kept at once on the device, and the next start sends it (offline, the beacon would not)', async () => {
    progressEndpoint(offline);
    saveProgressNow(report({ at: 5 }));
    // Kept synchronously, before anything asynchronous could finish.
    expect(JSON.parse(localStorage.getItem('bookclub:unsaved-progress')!)).toHaveLength(1);
    // The page closes: its database write never finished. The next start adopts what was kept.
    await clearLocalData();
    localStorage.setItem('bookclub:unsaved-progress', JSON.stringify([{ ...report({ at: 5 }), userId: 'user_ana' }]));
    await adoptUnsavedProgress();
    expect(localStorage.getItem('bookclub:unsaved-progress')).toBeNull();
    expect(await pendingCount()).toBe(1);
    const { sent } = progressEndpoint();
    await flushOutbox();
    expect(sent).toHaveLength(1);
  });

  it('reopens the book where the closing page was, even before its progress is adopted', async () => {
    await rememberPosition({ ...report({ at: 10 }), userId: ANA });
    localStorage.setItem('bookclub:unsaved-progress', JSON.stringify([{ ...report({ at: 20, locator: { kind: 'epub', section: 4, offset: 900 } }), userId: ANA }]));
    expect((await localPosition(report().bookId))?.locator).toEqual({ kind: 'epub', section: 4, offset: 900 });
    // Someone else's kept place is never theirs.
    qc = sessionOf(BEN);
    bindOutbox(qc);
    expect(await localPosition(report().bookId)).toBeUndefined();
  });

  it('never puts an older place over a newer one when what a closing page kept is adopted', async () => {
    progressEndpoint(offline);
    // Kept at section 5 as the page closed; then read on, in the same tab, to section 9.
    localStorage.setItem('bookclub:unsaved-progress', JSON.stringify([{ ...report({ at: 10, locator: { kind: 'epub', section: 5, offset: 0 } }), userId: ANA }]));
    await rememberPosition({ ...report({ at: 20, locator: { kind: 'epub', section: 9, offset: 0 } }), userId: ANA });
    await adoptUnsavedProgress();
    expect((await localPosition(report().bookId))?.locator).toEqual({ kind: 'epub', section: 9, offset: 0 });
  });

  it('adopts only the signed-in person’s, keeping someone else’s for their own start, and ignores junk', async () => {
    progressEndpoint(offline);
    localStorage.setItem('bookclub:unsaved-progress', JSON.stringify([{ ...report(), userId: 'user_ben' }, 'junk', { bookId: 3 }]));
    await adoptUnsavedProgress();
    expect(await pendingCount()).toBe(0);
    expect(JSON.parse(localStorage.getItem('bookclub:unsaved-progress')!)).toEqual([{ ...report(), userId: 'user_ben' }]);
    localStorage.setItem('bookclub:unsaved-progress', '{not json');
    await adoptUnsavedProgress();
    expect(localStorage.getItem('bookclub:unsaved-progress')).toBeNull();
  });
});

describe('startOutbox', () => {
  /** Long enough for a flush that was started to have reached `fetch`. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  /** One report queued while offline, with the outbox running (its first flush failed too). */
  async function queuedOffline() {
    progressEndpoint(offline);
    await saveProgress(report());
    await flushOutbox();
    const stop = startOutbox(qc);
    await flushOutbox();
    expect(await pendingCount()).toBe(1);
    return stop;
  }

  it('sends what was queued offline as soon as the connection is back', async () => {
    const stop = await queuedOffline();
    const { sent } = progressEndpoint();
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await flushOutbox();
    expect(await pendingCount()).toBe(0);
    stop();
  });

  it('sends when the app comes back to the foreground, not when it goes to the background', async () => {
    const stop = await queuedOffline();
    const { sent } = progressEndpoint();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(sent).toHaveLength(0);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    stop();
  });

  it('flushes every 15 seconds while running', async () => {
    progressEndpoint(offline);
    await saveProgress(report());
    await flushOutbox();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const stop = startOutbox(qc);
      await flushOutbox(); // its first flush, still offline
      const { sent } = progressEndpoint();
      vi.advanceTimersByTime(14_999);
      await settle();
      expect(sent).toHaveLength(0);
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops listening once stopped', async () => {
    const stop = await queuedOffline();
    stop();
    const { sent } = progressEndpoint();
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(sent).toHaveLength(0);
    expect(await pendingCount()).toBe(1);
  });

  it('puts the comments a report unlocked, from every request of a long report, and my progress into the cache', async () => {
    const older: CommentView = { ...revealed('c_old', 0.1), text: 'already here' };
    qc.setQueryData<CommentView[]>(keys.comments(BOOK), [older]);
    qc.setQueryData<BookProgress>(keys.progress(BOOK), { mine: mine({ t: 0.1 }), members: [] });
    progressEndpoint(offline);
    const stop = startOutbox(qc);
    await flushOutbox();

    const latest = mine({ t: 0.6, label: 'Chapter 3 · 60%' });
    progressEndpoint((_body, n) => json(result({ mine: latest, revealed: n === 1 ? [revealed('c_1', 0.3)] : n === 3 ? [revealed('c_3', 0.5)] : [] })));
    await saveProgress(report({ spans: disjointSpans(150) }));
    await flushOutbox();

    expect(qc.getQueryData<CommentView[]>(keys.comments(BOOK))!.map((c) => c.id)).toEqual(['c_old', 'c_1', 'c_3']);
    expect(qc.getQueryData<BookProgress>(keys.progress(BOOK))!.mine).toEqual(latest);
    stop();
  });
});
