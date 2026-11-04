import { type Page, expect, test } from '@playwright/test';
import { browserAs, chooseSpeed, clubWithAlice, serverPlace } from '../helpers/api';

/**
 * Record the Media Session handlers the app registers, so tests can press "lock screen" buttons,
 * and every scrubber state it tells the system (`__positions`).
 */
const SPY = () => {
  const w = window as unknown as { __media: Record<string, ((d: Record<string, unknown>) => void) | null>; __positions: (MediaPositionState | null)[] };
  w.__media = {};
  w.__positions = [];
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
    const set = navigator.mediaSession.setPositionState.bind(navigator.mediaSession);
    navigator.mediaSession.setPositionState = (state?: MediaPositionState) => {
      w.__positions.push(state ?? null);
      set(state);
    };
  }
  if ('mediaSession' in navigator) {
    const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      w.__media[action] = handler as never;
      try {
        original(action, handler);
      } catch {
        // unsupported action in this engine
      }
    };
  }
};

async function listen(page: Page, bookId: string) {
  await page.goto(`/books/${bookId}/listen`);
  await expect(page.getByTestId('play-pause')).toBeVisible();
}

const audioTime = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime);

test.describe('the audiobook player', () => {
  // @chromium-only: Playwright's Linux WebKit plays media through GStreamer, which downloads the
  // whole track and seeks in its buffer without Range requests (iOS Safari's AVFoundation does
  // send them). The next test checks the 206 contract itself in both engines.
  test('seeking uses HTTP range requests answered with 206', { tag: '@chromium-only' }, async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const ranges: { status: number; range: string | null; contentRange: string | null }[] = [];
    page.on('response', (res) => {
      if (/\/media\/editions\/.+\/tracks\//.test(res.url())) {
        ranges.push({ status: res.status(), range: res.request().headers()['range'] ?? null, contentRange: res.headers()['content-range'] ?? null });
      }
    });
    await listen(page, book.id);
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await page.getByTestId('scrubber').fill('400');
    await expect.poll(() => audioTime(page)).toBeGreaterThan(399);
    await expect.poll(() => ranges.some((r) => r.status === 206 && r.contentRange?.startsWith('bytes ') && r.range !== null)).toBe(true);
    await ctx.close();
  });

  test('tracks answer byte-range requests with 206, as iOS Safari asks for them', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listen(page, book.id);
    const url = book.editions.find((e) => e.kind === 'audio')!.tracks[0]!.url;
    const result = await page.evaluate(async (u) => {
      const head = await fetch(u, { headers: { Range: 'bytes=0-1' } });
      const tail = await fetch(u, { headers: { Range: 'bytes=4000000-' } });
      const beyond = await fetch(u, { headers: { Range: 'bytes=999999999-' } });
      return {
        head: [head.status, head.headers.get('content-range'), (await head.arrayBuffer()).byteLength],
        tail: [tail.status, tail.headers.get('content-range'), tail.headers.get('accept-ranges')],
        beyond: [beyond.status, beyond.headers.get('content-range')],
      };
    }, url);
    expect(result.head).toEqual([206, 'bytes 0-1/5124992', 2]);
    expect(result.tail).toEqual([206, 'bytes 4000000-5124991/5124992', 'bytes']);
    expect(result.beyond).toEqual([416, 'bytes */5124992']);
    // And the player seeks deep into the track.
    await page.getByTestId('play-pause').click();
    await page.getByTestId('scrubber').fill('500');
    await expect.poll(() => audioTime(page)).toBeGreaterThan(499);
    await ctx.close();
  });

  test('speed changes the playback rate, holds across tracks and is remembered', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listen(page, book.id);
    await chooseSpeed(page, 1.5);
    const rate = () => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.playbackRate);
    await expect.poll(rate).toBe(1.5);
    // A new track keeps the speed (a fresh source resets the element's rate).
    await page.getByTestId('next-track').click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await expect.poll(rate).toBe(1.5);
    await page.reload();
    await expect(page.getByTestId('speed')).toHaveText('1.5×');
    await expect.poll(rate).toBe(1.5);
    await ctx.close();
  });

  test('listening resumes at the same place after a reload', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listen(page, book.id);
    await page.getByTestId('next-track').click();
    await page.getByTestId('next-track').click();
    await page.getByTestId('play-pause').click();
    await page.getByTestId('scrubber').fill('125');
    await expect.poll(() => audioTime(page)).toBeGreaterThan(124);
    await page.waitForTimeout(800);
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false');
    const at = await audioTime(page);
    await expect.poll(async () => {
      const l = await serverPlace(page, book.id);
      return l?.kind === 'audio' && l.track === 2 && l.ms > 120_000;
    }, { timeout: 20_000 }).toBe(true);
    await page.reload();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '2', { timeout: 15_000 });
    await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(at - 2);
    expect(await audioTime(page)).toBeLessThan(at + 2);
    await ctx.close();
  });

  test('lock-screen controls (Media Session) play, pause, skip and seek', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    await ctx.addInitScript(SPY);
    const page = await ctx.newPage();
    await listen(page, book.id);
    const handlers = await page.evaluate(() => Object.keys((window as unknown as { __media: object }).__media).sort());
    for (const action of ['pause', 'play', 'seekbackward', 'seekforward', 'seekto']) expect(handlers).toContain(action);
    // Chapters as tracks too, except on an iPhone, where track buttons would take the place of the
    // skips on the lock screen (D64): there chapters change in the app.
    const iphone = /iPhone/.test(await page.evaluate(() => navigator.userAgent));
    for (const action of ['nexttrack', 'previoustrack']) expect(handlers.includes(action), action).toBe(!iphone);
    const press = (action: string, details: Record<string, unknown> = {}) =>
      page.evaluate(([a, d]) => (window as unknown as { __media: Record<string, (x: object) => void> }).__media[a]!({ action: a, ...d }), [action, details] as const);
    await press('play');
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await press('seekto', { seekTime: 200 });
    await expect.poll(() => audioTime(page)).toBeGreaterThan(199);
    await press('seekforward');
    await expect.poll(() => audioTime(page)).toBeGreaterThan(229);
    await press('seekbackward');
    await expect.poll(() => audioTime(page)).toBeLessThan(220);
    if (iphone) await page.getByTestId('next-track').click();
    else await press('nexttrack');
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    await press('pause');
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false');
    const meta = await page.evaluate(() => ({ title: navigator.mediaSession.metadata?.title, album: navigator.mediaSession.metadata?.album, art: navigator.mediaSession.metadata?.artwork.length }));
    expect(meta.album).toBe("Alice's Adventures in Wonderland");
    expect(meta.title).toMatch(/^CHAPTER II\. The Pool of Tears/);
    // Square artwork in five sizes (D190): a lock screen's tile is square.
    expect(meta.art).toBe(5);
    await ctx.close();
  });

  test('the lock screen keeps one player through a chapter change: its scrubber exact after seeks and speed changes, its artwork square', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    await ctx.addInitScript(SPY);
    const page = await ctx.newPage();
    await listen(page, book.id);
    const press = (action: string, details: Record<string, unknown> = {}) =>
      page.evaluate(([a, d]) => (window as unknown as { __media: Record<string, (x: object) => void> }).__media[a]!({ action: a, ...d }), [action, details] as const);
    const lastPosition = () => page.evaluate(() => (window as unknown as { __positions: (MediaPositionState | null)[] }).__positions.at(-1) ?? null);
    // The handlers are the app's once it has registered them (as the lock screen sees them).
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __media: Record<string, unknown> }).__media.play)).toBe('function');
    // One element for the app's life (iOS keeps the lock screen's session with it): mark it.
    await page.getByTestId('audio-element').evaluate((a) => { (a as unknown as { __mark: number }).__mark = 7; });
    await press('play');
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await press('seekto', { seekTime: 123.5 });
    await expect.poll(async () => (await lastPosition())?.position ?? 0).toBeGreaterThan(123.4);
    expect((await lastPosition())!.position).toBeLessThan(125);
    expect((await lastPosition())!.duration).toBeGreaterThan(600); // Chapter 1 is about 11 minutes.
    // The speed control is a sheet of presets and steps since D195 (no longer a select).
    await chooseSpeed(page, 1.5);
    await expect.poll(async () => (await lastPosition())?.playbackRate).toBe(1.5);
    // Paused, the scrubber stays where the element is.
    await press('pause');
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false');
    const paused = await audioTime(page);
    await expect.poll(async () => Math.abs(((await lastPosition())?.position ?? 0) - paused)).toBeLessThan(0.5);
    // The next chapter: the same element, the handlers still there, the scrubber its length.
    await page.getByTestId('next-track').click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    expect(await page.getByTestId('audio-element').evaluate((a) => (a as unknown as { __mark?: number }).__mark)).toBe(7);
    expect(await page.locator('audio').count()).toBe(1);
    await press('play');
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await expect.poll(async () => (await lastPosition())?.position ?? 99).toBeLessThan(10);
    expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing');
    const meta = await page.evaluate(() => ({ title: navigator.mediaSession.metadata?.title, artist: navigator.mediaSession.metadata?.artist, art: navigator.mediaSession.metadata?.artwork.map((a) => a.sizes) }));
    expect(meta.title).toMatch(/^CHAPTER II\. The Pool of Tears/);
    expect(meta.artist).toBe('Lewis Carroll');
    expect(meta.art).toEqual(['96x96', '192x192', '256x256', '384x384', '512x512']);
    // The artwork answers, square, for this member.
    const square = await page.request.get(await page.evaluate(() => navigator.mediaSession.metadata!.artwork.at(-1)!.src));
    expect(square.status()).toBe(200);
    expect(square.headers()['content-type']).toBe('image/webp');
    // A reload resumes where the lock screen left it, and tells the scrubber so.
    await press('seekto', { seekTime: 61 });
    await press('pause');
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false');
    await expect.poll(async () => ((await serverPlace(page, book.id)) as { track?: number; ms?: number } | null)?.ms ?? 0, { timeout: 15_000 }).toBeGreaterThan(60_000);
    await page.reload();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1', { timeout: 15_000 });
    await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(60);
    await expect.poll(async () => (await lastPosition())?.position ?? 0).toBeGreaterThan(60);
    await ctx.close();
  });

  test('the previous and next chapter buttons go by chapter: previous restarts the chapter a few seconds in', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    await ctx.addInitScript(SPY);
    const page = await ctx.newPage();
    await listen(page, book.id);
    const press = (action: string, details: Record<string, unknown> = {}) =>
      page.evaluate(([a, d]) => (window as unknown as { __media: Record<string, (x: object) => void> }).__media[a]!({ action: a, ...d }), [action, details] as const);
    // The lock screen's track buttons everywhere but an iPhone, where the skips take their place
    // (D64) and the same rule is the player's own buttons.
    const iphone = /iPhone/.test(await page.evaluate(() => navigator.userAgent));
    const step = (direction: 'previoustrack' | 'nexttrack') => (iphone ? page.getByTestId(direction === 'nexttrack' ? 'next-track' : 'prev-track').click() : press(direction));
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __media: Record<string, unknown> }).__media.play)).toBe('function');
    await expect(page.getByTestId('prev-track')).toBeDisabled(); // The book's very start.
    await step('nexttrack');
    await step('nexttrack');
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '2');
    await press('play');
    await press('seekto', { seekTime: 40 });
    await expect.poll(() => audioTime(page)).toBeGreaterThan(39);
    await step('previoustrack');
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '2');
    await expect.poll(() => audioTime(page)).toBeLessThan(3);
    await step('previoustrack');
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    await ctx.close();
  });

  test('the track list names chapters, a chapter from it is a look until Play, and a finished track moves on to the next', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listen(page, book.id);
    await page.getByTestId('toggle-tracks').click();
    const items = page.locator('.track-item');
    await expect(items).toHaveCount(12);
    await expect(items.first()).toContainText('CHAPTER I. Down the Rabbit-Hole');
    // A chapter from the list is a look, as from the reader's contents (D72): it waits there, with
    // a way back, and the place saved for everyone stays where it was.
    await items.nth(3).click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '3');
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false');
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 1');
    await page.waitForTimeout(1500);
    expect(((await serverPlace(page, book.id)) as { track?: number } | null)?.track ?? 0).toBe(0);
    // Play there is listening there: it is the place now.
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await expect(page.getByTestId('back-to-reading')).toHaveCount(0);
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '4', { timeout: 20_000 });
    await expect.poll(async () => ((await serverPlace(page, book.id)) as { track?: number } | null)?.track, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    await ctx.close();
  });

  test('playback keeps going while browsing the club (mini player)', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listen(page, book.id);
    await page.getByTestId('play-pause').click();
    await page.getByRole('link', { name: /Back to/ }).click();
    await expect(page.getByTestId('mini-player')).toBeVisible();
    const t1 = await audioTime(page);
    await page.waitForTimeout(1200);
    expect(await audioTime(page)).toBeGreaterThan(t1);
    await ctx.close();
  });

  test('skip back and forward buttons move by 15 and 30 seconds', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listen(page, book.id);
    await page.getByTestId('play-pause').click();
    await page.getByTestId('scrubber').fill('100');
    await expect.poll(() => audioTime(page)).toBeGreaterThan(99);
    await page.getByTestId('skip-forward').click();
    await expect.poll(() => audioTime(page)).toBeGreaterThan(129);
    await page.getByTestId('skip-back').click();
    await expect.poll(() => audioTime(page)).toBeLessThan(125);
    expect(await audioTime(page)).toBeGreaterThan(114);
    await ctx.close();
  });

  test('the scrubber waits for the audiobook to be in the player, and the first scrub after that holds', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    // No service worker: a request it makes for the page never reaches page.route, and once it
    // controls the page (it may, within the first load) the progress held below was not held at
    // all, and the scrubber came alive early (3 runs in 12 on master).
    const ctx = await browserAs(browser, club.owner, { serviceWorkers: 'block' });
    const page = await ctx.newPage();
    // A slow network: the player opens the book only once it knows your place in it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/books/${book.id}/progress`, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto(`/books/${book.id}/listen`);
    const scrubber = page.getByTestId('scrubber');
    // Until then a scrub would be undone by the place it opens at, so there is none to make.
    await expect(scrubber).toBeVisible();
    await expect(scrubber).toBeDisabled();
    release();
    await expect(scrubber).toBeEnabled({ timeout: 15_000 });
    await scrubber.fill('60');
    await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(59);
    await ctx.close();
  });

  test('the sleep timer can stop at the end of the track', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listen(page, book.id);
    await page.getByTestId('sleep').selectOption('track');
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false', { timeout: 20_000 });
    // Stopped at the end of chapter 1, with chapter 2 ready: Play goes on, it does not replay.
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    expect(await audioTime(page)).toBeLessThan(1);
    expect(await page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    await ctx.close();
  });
});
