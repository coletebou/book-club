import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  type BookDetail,
  type ClientMessage,
  type Edition,
  type Locator,
  type ProgressUpdateBody,
  type ProgressUpdateResult,
  type SessionInfo,
  linearSyncMap,
} from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPageUser } from '../lib/api';
import { clearLocalData } from '../lib/db';
import { bindOutbox, flushOutbox, pendingCount, saveProgress } from '../lib/outbox';
import { keys } from '../lib/queries';
import { initRealtime } from '../lib/realtime';
import { useReadingReport } from './useReadingReport';

const epub = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });

const edition: Edition = {
  id: 'ed_epub_1',
  kind: 'epub',
  status: 'ready',
  error: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  addedBy: 'user_ana',
  sizeBytes: 1000,
  geometry: { kind: 'epub', sectionLengths: [100, 1000, 2000, 3000, 400] },
  sync: linearSyncMap(100, 6100),
  alignment: { method: 'reference', unitToChapter: [] },
  units: [],
  publicationUrl: '/api/editions/ed_epub_1/publication',
  fileUrl: null,
  tracks: [],
  durationMs: null,
  pageCount: null,
  readAlong: null,
};

const book: BookDetail = {
  id: 'book_alice',
  clubId: 'club_123',
  title: "Alice's Adventures in Wonderland",
  author: 'Lewis Carroll',
  coverUrl: '/api/books/book_alice/cover?v=1',
  hasCover: true,
  kinds: ['epub'],
  createdAt: '2026-10-20T10:00:00.000Z',
  addedBy: 'user_ana',
  commentCount: 0, meeting: null,
  progress: [],
  chapters: [
    { index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0 },
    { index: 1, title: 'CHAPTER II. The Pool of Tears', t: 0.3 },
  ],
  editions: [edition],
  referenceEditionId: edition.id,
};

const accepted: ProgressUpdateResult = {
  mine: { editionId: edition.id, locator: epub(2, 0), t: 0.2, label: '', readRanges: [], furthest: 0.2, finished: false, at: 1 },
  revealed: [],
};

let sent: ProgressUpdateBody[];
let online = true;

beforeEach(async () => {
  await clearLocalData();
  const qc = new QueryClient();
  qc.setQueryData<SessionInfo>(keys.session, { user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null });
  bindOutbox(qc);
  sent = [];
  online = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!online) throw new TypeError('Failed to fetch');
      sent.push(JSON.parse(init!.body as string) as ProgressUpdateBody);
      return new Response(JSON.stringify(accepted), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await flushOutbox();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = (b: BookDetail | undefined = book, e: Edition | undefined = edition) =>
  renderHook(({ b, e }: { b: BookDetail | undefined; e: Edition | undefined }) => useReadingReport(b, e), { initialProps: { b, e } });

describe('useReadingReport', () => {
  it('saves my place 600 ms after the page settles, with every page shown meanwhile', async () => {
    const { result } = mount();
    result.current.report(epub(2, 0), epub(2, 100));
    await vi.advanceTimersByTimeAsync(300);
    result.current.report(epub(2, 100), epub(2, 200));
    await vi.advanceTimersByTimeAsync(599);
    expect(await pendingCount()).toBe(0);
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      editionId: edition.id,
      locator: epub(2, 100),
      readSpans: [
        { from: epub(2, 0), to: epub(2, 100) },
        { from: epub(2, 100), to: epub(2, 200) },
      ],
    });
  });

  it('saves and sends at once when it is urgent (the end of a chapter)', async () => {
    const { result } = mount();
    result.current.report(epub(3, 0), epub(3, 120), { urgent: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.locator).toEqual(epub(3, 0));
  });

  it('keeps the place it is told to keep (a page laid out again), while counting the page as read', async () => {
    const { result } = mount();
    result.current.report(epub(2, 900), epub(2, 1500), { place: epub(2, 1284), urgent: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ locator: epub(2, 1284), readSpans: [{ from: epub(2, 900), to: epub(2, 1500) }] });
  });

  it('saves a place it keeps with the time you came to it, not the moment the save goes out (D196)', async () => {
    const { result } = mount();
    // Opened at the narrator's place, saved at 1 000: the page reports that place, as of then.
    result.current.report(epub(2, 900), epub(2, 1500), { place: epub(2, 1284), placeAt: 1_000, urgent: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ locator: epub(2, 1284), at: 1_000 });
  });

  it('saves a page turned to with the time it was turned to, though the save waits for the page to settle', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const { result } = mount();
    result.current.report(epub(3, 0), epub(3, 120));
    clock.mockReturnValue(9_000);
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ locator: epub(3, 0), at: 5_000 });
  });

  it('does not count a look (a link followed, a note visited) as reading', async () => {
    const { result } = mount();
    result.current.report(epub(4, 0), epub(4, 100), { look: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pendingCount()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('keeps reading made offline queued on the device', async () => {
    online = false;
    const { result } = mount();
    result.current.report(epub(2, 0), epub(2, 100));
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(async () => expect(await pendingCount()).toBe(1));
    online = true;
    await flushOutbox();
    expect(sent).toHaveLength(1);
  });

  it('flush(true) settles once what was pending has been saved and sent', async () => {
    const { result } = mount();
    result.current.report(epub(2, 0), epub(2, 100));
    await act(() => result.current.flush(true));
    expect(sent).toHaveLength(1);
    expect(await pendingCount()).toBe(0);
  });

  it('flush(true) with nothing pending still sends what is queued', async () => {
    online = false;
    await saveProgress({ bookId: book.id, editionId: edition.id, locator: epub(1, 5), at: 1_000, spans: [] });
    await flushOutbox();
    online = true;
    const { result } = mount();
    await act(() => result.current.flush(true));
    expect(sent.map((b) => b.locator)).toEqual([epub(1, 5)]);
  });

  it('saves and sends what is pending when the reader closes', async () => {
    const { result, unmount } = mount();
    result.current.report(epub(5, 0), epub(5, 50));
    unmount();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.locator).toEqual(epub(5, 0));
  });

  it('sends what is pending as a beacon when the page is hidden, keeping a local copy too', async () => {
    const sendBeacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
    setPageUser('user_ana');
    try {
      const { result } = mount();
      result.current.report(epub(2, 0), epub(2, 100));
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      const [url, data] = sendBeacon.mock.calls[0]!;
      expect(url).toBe('/api/books/book_alice/progress/beacon?as=user_ana');
      expect(JSON.parse(await (data as Blob).text())).toMatchObject({ editionId: edition.id, locator: epub(2, 0), readSpans: [{ from: epub(2, 0), to: epub(2, 100) }] });
      await vi.waitFor(() => expect(sent).toHaveLength(1)); // the local copy, sent through the outbox
      // Nothing is left pending to send twice.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(navigator, 'sendBeacon');
      setPageUser(undefined);
    }
  });

  it('does not treat a refetched book (a new object) as leaving it', async () => {
    const { result, rerender } = mount();
    result.current.report(epub(2, 0), epub(2, 100));
    rerender({ b: structuredClone(book), e: structuredClone(edition) });
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('reports nothing before the book and edition are known', async () => {
    const { result } = mount(undefined, undefined);
    result.current.report(epub(2, 0), epub(2, 100), { urgent: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pendingCount()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('shows the club where I am at once, with the chapter, and that I left when the reader closes', async () => {
    const frames: ClientMessage[] = [];
    class Socket {
      static readonly OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send(data: string) {
        frames.push(JSON.parse(data) as ClientMessage);
      }
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal('WebSocket', Socket);
    const qc = new QueryClient();
    const rt = initRealtime(qc);
    rt.start();
    try {
      const { result, unmount } = mount();
      // Section 2 starts at character 1100; offset 800 is character 1900, 30 % into the story
      // (which runs from 100 to 6100): the first page of chapter II.
      result.current.report(epub(2, 800), epub(2, 1000), { look: true });
      expect(frames).toEqual([{ type: 'reading', bookId: book.id, editionId: edition.id, locator: epub(2, 800), label: 'Chapter 2 · 30%' }]);
      unmount();
      expect(frames.at(-1)).toEqual({ type: 'idle' });
    } finally {
      rt.stop();
    }
  });
});
