import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_SAVE_MS, BackgroundProgress, type BackgroundProgressDeps, KEEP_MS } from './BackgroundProgress';

/*
 * The place saved while iOS has the page asleep (D182): what native heard, in the page's own shapes,
 * only in the background, and never a skip as heard.
 */

const at = (track: number, ms: number) => ({ kind: 'audio' as const, track, ms });
let now: number;
let background: boolean;
let fetch: ReturnType<typeof vi.fn<BackgroundProgressDeps['fetch']>>;
let keeper: BackgroundProgress;
const bodies = () => fetch.mock.calls.map((c) => JSON.parse(c[1].body) as { editionId: string; locator: unknown; readSpans: unknown[]; at: number });
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  now = 1_000_000;
  background = true;
  fetch = vi.fn<BackgroundProgressDeps['fetch']>().mockResolvedValue({ ok: true, status: 200 });
  keeper = new BackgroundProgress({ serverUrl: 'https://books.example/', fetch, now: () => now, inBackground: () => background });
  keeper.setTarget({ bookId: 'b1', editionId: 'e1' });
});

/** Play `seconds` of audio from `ms` in `track`, seen every half second, as expo-audio reports it. */
function play(track: number, ms: number, seconds: number, rate = 1) {
  for (let s = 0; s <= seconds * 2; s++) {
    keeper.observe(at(track, ms + s * 500 * rate), true, rate);
    now += 500;
  }
  now -= 500;
}

describe('the place saved while the page sleeps (D182)', () => {
  it('saves every thirty seconds of playing in the background, with what was heard, to the page’s own endpoint', async () => {
    keeper.backgrounded();
    play(0, 10_000, 31);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('https://books.example/api/books/b1/progress');
    expect(fetch.mock.calls[0]![1]).toEqual(expect.objectContaining({ method: 'PUT', credentials: 'include' }));
    const [body] = bodies();
    expect(body!.editionId).toBe('e1');
    expect(body!.readSpans).toEqual([{ from: at(0, 10_000), to: body!.locator }]);
    expect((body!.locator as { ms: number }).ms).toBeGreaterThanOrEqual(10_000 + BACKGROUND_SAVE_MS);
  });

  it('saves nothing while the app is open: the page saves then', async () => {
    background = false;
    play(0, 0, 90);
    keeper.observe(at(0, 90_000), false, 1);
    await tick();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('saves at once on a pause, at the paused place', async () => {
    keeper.backgrounded();
    play(0, 0, 5);
    keeper.observe(at(0, 5_000), false, 1);
    await tick();
    expect(bodies()).toEqual([expect.objectContaining({ locator: at(0, 5_000), readSpans: [{ from: at(0, 0), to: at(0, 5_000) }] })]);
  });

  it('never counts a skip as heard: the stretch ends before it and another starts after it', async () => {
    keeper.backgrounded();
    play(0, 0, 4);
    play(0, 34_000, 4); // a 30 s skip ahead from the lock screen
    keeper.observe(at(0, 38_000), false, 1);
    await tick();
    expect(bodies()[0]!.readSpans).toEqual([{ from: at(0, 0), to: at(0, 4_000) }, { from: at(0, 34_000), to: at(0, 38_000) }]);
  });

  it('follows the speed: 1.5× is not a jump', async () => {
    keeper.backgrounded();
    play(0, 0, 10, 1.5);
    keeper.observe(at(0, 15_000), false, 1.5);
    await tick();
    expect(bodies()[0]!.readSpans).toEqual([{ from: at(0, 0), to: at(0, 15_000) }]);
  });

  it('a finished track ends its stretch at its end, and the next track starts its own', async () => {
    keeper.backgrounded();
    play(0, 56_000, 4);
    keeper.finished(at(0, 60_000));
    await tick();
    play(1, 0, 3);
    keeper.observe(at(1, 3_000), false, 1);
    await tick();
    expect(bodies().map((b) => b.readSpans)).toEqual([[{ from: at(0, 56_000), to: at(0, 60_000) }], [{ from: at(1, 0), to: at(1, 3_000) }]]);
  });

  it('keeps what was heard for the next save when offline, and drops nothing on a server error', async () => {
    keeper.backgrounded();
    fetch.mockRejectedValueOnce(new Error('offline'));
    play(0, 0, 3);
    keeper.observe(at(0, 3_000), false, 1);
    await tick();
    play(0, 3_000, 2);
    keeper.observe(at(0, 5_000), false, 1);
    await tick();
    expect(bodies()[1]!.readSpans).toEqual([{ from: at(0, 0), to: at(0, 3_000) }, { from: at(0, 3_000), to: at(0, 5_000) }]);
  });

  it('nothing to save without a book', async () => {
    keeper.setTarget(null);
    keeper.backgrounded();
    play(0, 0, 40);
    await tick();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('a save asked for while one is on its way', () => {
  it('is made once that one is done, never dropped', async () => {
    let release!: () => void;
    fetch.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, status: 200 }); }));
    keeper.backgrounded();
    play(0, 0, 31); // the thirty-second save, still on its way
    keeper.observe(at(0, 31_000), false, 1); // then a pause
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    await tick(); await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodies()[1]!.locator).toEqual(at(0, 31_000));
  });
});

describe('the place kept on the device (D196)', () => {
  let files: string[];
  beforeEach(() => {
    files = [];
    background = false; // kept whether the app is open or not: it is what is left if the app ends
    keeper = new BackgroundProgress({ serverUrl: 'https://books.example/', fetch, now: () => now, inBackground: () => background, keep: (json) => { files.push(json); } });
    keeper.setTarget({ bookId: 'b1', editionId: 'e1', userId: 'u1' });
  });
  const lastKept = () => JSON.parse(files.at(-1)!) as { bookId: string; userId: string; locator: unknown; at: number; spans: unknown[] };

  it('every few seconds while playing, with the stretch heard so far, and whose it is', () => {
    play(2, 30_000, 10);
    expect(files.length).toBeGreaterThanOrEqual(10_000 / KEEP_MS - 1);
    expect(files.length).toBeLessThanOrEqual(10_000 / KEEP_MS + 1);
    expect(lastKept()).toEqual(expect.objectContaining({ bookId: 'b1', userId: 'u1' }));
    expect(lastKept().spans).toEqual([{ from: at(2, 30_000), to: lastKept().locator }]);
  });

  it('at once at a pause, a track’s end and the app going to the background', () => {
    play(0, 0, 1);
    const before = files.length;
    keeper.observe(at(0, 1_250), false, 1);
    expect(files.length).toBe(before + 1);
    expect(lastKept().locator).toEqual(at(0, 1_250));
    keeper.finished(at(0, 60_000));
    expect(lastKept().locator).toEqual(at(0, 60_000));
    keeper.backgrounded();
    expect(files.length).toBe(before + 3);
  });

  it('gives what an earlier run kept until this one hears a place, and nothing it cannot read', () => {
    const fresh = new BackgroundProgress({ serverUrl: 'https://books.example/', fetch, now: () => now, inBackground: () => background });
    expect(fresh.kept()).toBeNull();
    fresh.restore('not json');
    expect(fresh.kept()).toBeNull();
    const earlier = { bookId: 'b1', editionId: 'e1', userId: 'u1', locator: at(4, 1_234), at: 5, spans: [] };
    fresh.restore(JSON.stringify(earlier));
    expect(fresh.kept()).toEqual(earlier);
    fresh.setTarget({ bookId: 'b1', editionId: 'e1', userId: 'u1' });
    // The page opening the book (a track loaded at its place, paused) is the page's own place, not
    // news: what the earlier run heard stays the place kept, its time unchanged.
    fresh.observe(at(4, 0), false, 1);
    fresh.observe(at(4, 600), false, 1);
    expect(fresh.kept()).toEqual(earlier);
    // Heard: that is the place now.
    fresh.observe(at(4, 9_000), true, 1);
    expect(fresh.kept()).toEqual(expect.objectContaining({ locator: at(4, 9_000), at: now }));
  });

  it('keeps nothing heard in one book as another’s', () => {
    play(2, 30_000, 4);
    keeper.setTarget({ bookId: 'b2', editionId: 'e2', userId: 'u1' });
    expect(keeper.kept()).toBeNull();
    play(0, 0, 3);
    expect(keeper.kept()).toEqual(expect.objectContaining({ bookId: 'b2', editionId: 'e2' }));
    expect(keeper.kept()!.spans.every((h) => h.from.track === 0 && h.to.track === 0)).toBe(true);
  });
});
