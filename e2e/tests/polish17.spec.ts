import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { BookDetail, ClubSummary } from '@bookclub/shared';
import { ADMIN_EMAIL, ADMIN_PASSWORD, FIXTURES, SYNTHETIC_DIR, apiAs, browserAs, clubWithAlice, makeClub, putProgress } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';
import { listenFromThisPage, openBookSettings } from '../helpers/open';

/*
 * Fidelity review round 17: a scanned PDF drawn blank with a white cover (FR149), the demo's owner
 * in the PDF (FR153), the PDF's footer wrapping on a phone with the audiobook in it (FR155), and
 * long uploads from an iPhone with the screen let lock (FR156).
 */

/** Seven pages of archive.org's scan of the 1886 Jekyll and Hyde: JPEG 2000 and JBIG2 pictures under the OCR's text. */
const SCAN = path.join(FIXTURES, 'books/jekyll-1886-scan-sample.pdf');
const PHONE = { viewport: { width: 393, height: 659 }, isMobile: true, hasTouch: true };

/**
 * How a drawing looks: the share of its pixels far from its commonest shade (its ink: 0 for a
 * blank page) and the share of them blue (the scan's cover). Of the PDF reader's page as it is
 * drawn now, of the upload dialog's preview, or of the picture at an address (a cover).
 */
const drawn = (page: Page, from: { canvas: string } | { img: string } | { url: string }) =>
  page.evaluate(async (from) => {
    let data: Uint8ClampedArray;
    if ('canvas' in from) {
      const canvas = document.querySelector<HTMLCanvasElement>(from.canvas);
      if (!canvas || canvas.width === 0) return { ink: 0, blue: 0 };
      data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    } else {
      const img = 'img' in from ? document.querySelector<HTMLImageElement>(from.img)! : null;
      await img?.decode();
      const bitmap = await createImageBitmap(img ?? (await (await fetch((from as { url: string }).url)).blob()));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    }
    const shades = new Uint32Array(256);
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      shades[Math.round(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!)]!++;
      if (data[i + 2]! > data[i]! + 60) blue++;
    }
    let common = 0;
    for (let s = 1; s < 256; s++) if (shades[s]! > shades[common]!) common = s;
    let ink = 0;
    for (let s = 0; s < 256; s++) if (Math.abs(s - common) > 48) ink += shades[s]!;
    const pixels = data.length / 4;
    return { ink: ink / pixels, blue: blue / pixels };
  }, from);
const pageDrawn = (page: Page) => drawn(page, { canvas: '.pdf-page canvas' });

/** pdf.js's own complaints when it lacks what a scan's pages need (its wasm decoders, fonts, maps). */
const MISSING = /wasmUrl|JpxError|OpenJPEG failed|JBIG2|standardFontDataUrl|cMapUrl|iccUrl/;

async function bookReady(page: Page, bookId: string): Promise<BookDetail> {
  let detail: BookDetail | null = null;
  await expect
    .poll(
      async () => {
        detail = (await (await page.request.get(`/api/books/${bookId}`)).json()) as BookDetail;
        return detail.editions.every((e) => e.status === 'ready');
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return detail!;
}

test.describe('a scanned PDF (fidelity review round 17, FR149)', () => {
  test('is drawn, page by page, gets its own first page for a cover, fills in its title and author, and reads offline once kept', async ({ browser }, info) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner, info.project.name === 'webkit-iphone' ? {} : PHONE);
    const page = await ctx.newPage();
    const said: string[] = [];
    page.on('console', (m) => said.push(m.text()));
    await page.goto(`/clubs/${club.id}`);
    await expect.poll(async () => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20_000 }).toBe(true);
    await page.getByRole('button', { name: 'Add a book' }).click();
    await page.getByTestId('file-input').setInputFiles(SCAN);
    // As archive.org writes them: "Strange case of Dr. Jekyll and Mr. Hyde", "Stevenson, Robert Louis, 1850-1894".
    await expect(page.getByTestId('upload-title')).toHaveValue('Strange Case of Dr. Jekyll and Mr. Hyde');
    await expect(page.getByTestId('upload-author')).toHaveValue('Robert Louis Stevenson');
    // The preview is the scan's blue cover, as drawn here: not a white page.
    const preview = await drawn(page, { img: '[data-testid=upload-cover]' });
    expect(preview.ink).toBeGreaterThan(0.01);
    expect(preview.blue).toBeGreaterThan(0.5);
    await page.getByTestId('upload-start').click();
    await expect(page).toHaveURL(/\/books\/[^/]+$/, { timeout: 60_000 });
    const bookId = page.url().split('/books/')[1]!;
    const book = await bookReady(page, bookId);
    expect(book).toMatchObject({ title: 'Strange Case of Dr. Jekyll and Mr. Hyde', author: 'Robert Louis Stevenson', hasCover: true });
    const cover = await drawn(page, { url: `${book.coverUrl}&w=320` });
    expect(cover.ink).toBeGreaterThan(0.01);
    expect(cover.blue).toBeGreaterThan(0.5);

    const pdf = book.editions[0]!;
    await page.goto(`/books/${bookId}/read?edition=${pdf.id}`);
    // Page one, the cover; page two, the contents in black on the scan's paper.
    await expect.poll(async () => (await pageDrawn(page)).blue, { timeout: 30_000 }).toBeGreaterThan(0.5);
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', '2');
    await expect.poll(async () => (await pageDrawn(page)).ink, { timeout: 30_000 }).toBeGreaterThan(0.005);
    // Kept on the device as it is read, with what pdf.js draws its pages with.
    await expect(page.getByTestId('reader')).toHaveAttribute('data-offline', 'kept', { timeout: 60_000 });

    await ctx.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', '2', { timeout: 30_000 });
    await expect.poll(async () => (await pageDrawn(page)).ink, { timeout: 30_000 }).toBeGreaterThan(0.005);
    // A page not drawn on this device before: its pictures decoded with no network.
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', '3');
    await expect.poll(async () => (await pageDrawn(page)).ink, { timeout: 30_000 }).toBeGreaterThan(0.01);
    await ctx.setOffline(false);
    expect(said.filter((s) => MISSING.test(s))).toEqual([]);
    await page.request.delete(`/api/books/${bookId}`);
    await ctx.close();
  });

  test('whose first page this browser cannot draw sends no blank cover: the server draws the page itself', async ({ browser }) => {
    const club = await makeClub([]);
    // No service worker: the page's pdf.js asks the network for its decoders, and is refused them.
    const ctx: BrowserContext = await browserAs(browser, club.owner, { serviceWorkers: 'block' });
    await ctx.route('**/assets/pdfjs-*/**', (route) => route.abort());
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    await page.getByRole('button', { name: 'Add a book' }).click();
    await page.getByTestId('file-input').setInputFiles(SCAN);
    await expect(page.getByTestId('upload-title')).toHaveValue('Strange Case of Dr. Jekyll and Mr. Hyde');
    await expect(page.getByTestId('upload-cover')).toHaveCount(0);
    await expect(page.getByTestId('upload-no-cover')).toHaveText('The cover is made from the PDF once it is uploaded.');
    await page.getByTestId('upload-start').click();
    await expect(page).toHaveURL(/\/books\/[^/]+$/, { timeout: 60_000 });
    const bookId = page.url().split('/books/')[1]!;
    const book = await bookReady(page, bookId);
    expect(book.hasCover).toBe(true);
    const cover = await drawn(page, { url: `${book.coverUrl}&w=320` });
    expect(cover.ink).toBeGreaterThan(0.01);
    expect(cover.blue).toBeGreaterThan(0.5);
    await page.request.delete(`/api/books/${bookId}`);
    await ctx.close();
  });
});

test.describe('the demo’s first evening (fidelity review round 17, FR153)', () => {
  test('its owner, on a phone, reads on in the EPUB, not in the PDF’s small print', async ({ browser }, info) => {
    const cole = await apiAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const clubs = (await (await cole.get('/api/clubs')).json()) as ClubSummary[];
    const demo = clubs.find((c) => c.name === 'The Rabbit Hole Society')!;
    expect(demo).toBeDefined();
    const ctx = await browser.newContext({ ...(info.project.name === 'webkit-iphone' ? {} : PHONE), storageState: await cole.storageState() });
    const page = await ctx.newPage();
    await page.goto(`/clubs/${demo.id}`);
    await page.getByTestId('card-continue').first().click();
    await expect(page.getByTestId('reader')).toHaveClass(/reader-epub/);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    // The PDF and the audiobook are on the bar all the same, a friend in each.
    const [alice] = (await (await cole.get(`/api/clubs/${demo.id}/books`)).json()) as { id: string }[];
    const progress = (await (await cole.get(`/api/books/${alice!.id}/progress`)).json()) as { members: { displayName: string; kind: string }[] };
    expect(Object.fromEntries(progress.members.map((m) => [m.displayName, m.kind]))).toEqual({ Cole: 'epub', Ana: 'epub', Ben: 'audio', Cleo: 'pdf' });
    await ctx.close();
    await cole.dispose();
  });
});

test.describe('the PDF reader’s footer with the audiobook in it (fidelity review round 17, FR155)', () => {
  test('on a phone it keeps to one line while the audiobook plays: the page within the chapter makes way, its dot with it, as in the EPUB', async ({ browser }, info) => {
    const { club, book } = await clubWithAlice([], { pdf: true, audio: 'librivox' });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    // Where the reviewer was: page 18 of 91, the fifth of CHAPTER III's six.
    await putProgress(club.owner, book.id, pdf.id, { kind: 'pdf', page: 17, y: 0 }, [{ from: { kind: 'pdf', page: 0, y: 0 }, to: { kind: 'pdf', page: 17, y: 0 } }]);
    const ctx = await browserAs(browser, club.owner, info.project.name === 'webkit-iphone' ? {} : PHONE);
    const page = await ctx.newPage();
    const footer = page.locator('.reader-footer .page-info');
    const lines = () =>
      footer.evaluate((info) => {
        const tops = new Set([...info.children].filter((c) => (c as HTMLElement).offsetParent !== null).map((c) => Math.round(c.getBoundingClientRect().top)));
        return { lines: tops.size, text: (info as HTMLElement).innerText.replace(/\s+/g, ' ').trim() };
      });
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', '18', { timeout: 30_000 });
    // Without the audiobook in the footer, the page within the chapter is there.
    await expect(page.getByTestId('chapter-page')).toBeVisible();
    expect((await lines()).text).toMatch(/^Page 18 of 91 · \d of \d in chapter · \d+%$/);

    // The audiobook played over the PDF from its footer (D197, D198), playing there.
    await listenFromThisPage(page);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
    await expect(page.locator('.reader-footer').getByTestId('footer-play')).toHaveAccessibleName('Pause the audiobook');
    // Still inside CHAPTER III (the place a second or two of listening on): its page within the
    // chapter is there to show, and is left out.
    await expect(page.getByTestId('chapter-page')).toHaveCount(1);
    await expect(page.getByTestId('chapter-page')).toBeHidden();
    const shown = await lines();
    expect(shown.lines).toBe(1);
    // No dot left hanging: page, dot, percentage.
    expect(shown.text).toMatch(/^Page 1[789] of 91 · \d+%$/);
    await page.locator('.reader-footer').getByTestId('footer-play').click();
    await ctx.close();
  });
});

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.tmp');

/** An MP3 of about `megabytes` MB: a real one's frames over and over (valid audio for the server). Deleted afterwards. */
function longTrack(name: string, megabytes: number): string {
  mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name);
  const unit = readFileSync(path.join(SYNTHETIC_DIR, '02 - The Middle.mp3'));
  const fd = openSync(file, 'w');
  for (let written = 0; written < megabytes * 1024 * 1024; written += unit.byteLength) writeSync(fd, unit);
  closeSync(fd);
  return file;
}

test.describe('a long upload from a phone (fidelity review round 17, FR156)', () => {
  let track: string;
  test.beforeAll(() => {
    track = longTrack(`wake-${test.info().project.name}-${process.pid}.mp3`, 24);
  });
  test.afterAll(() => {
    rmSync(track, { force: true });
  });

  /** A phone, with no service worker: WebKit's routes would not hold back the uploads it lets through. */
  const phoneWithoutWorker = (project: string) => ({ ...(project === 'webkit-iphone' ? {} : PHONE), serviceWorkers: 'block' as const });

  test('keeps the screen on while files go up, says so, and lets it go when done or stopped', async ({ browser, browserName }, info) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner, phoneWithoutWorker(info.project.name));
    // Each lock the page asks for: whether it was given, and whether it was let go. (On WakeLock's
    // prototype: WebKit may hand out a new navigator.wakeLock, without what was set on the old one.)
    await ctx.addInitScript(() => {
      const locks: { granted: boolean; released: boolean }[] = [];
      (window as unknown as { wakeLocks: typeof locks }).wakeLocks = locks;
      if (typeof WakeLock === 'undefined') return;
      const request = Object.getOwnPropertyDescriptor(WakeLock.prototype, 'request')!.value as (this: WakeLock, type?: WakeLockType) => Promise<WakeLockSentinel>;
      WakeLock.prototype.request = async function (this: WakeLock, type) {
        const lock = { granted: false, released: false };
        locks.push(lock);
        const sentinel = await request.call(this, type);
        lock.granted = true;
        sentinel.addEventListener('release', () => {
          lock.released = true;
        });
        return sentinel;
      };
    });
    const page = await ctx.newPage();
    if (browserName === 'chromium') {
      // Headless Chromium refuses screen wake locks unless the page may have them, as a browser on screen does.
      const { targetInfo } = (await (await ctx.newCDPSession(page)).send('Target.getTargetInfo')) as { targetInfo: { browserContextId: string } };
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.setPermission', { permission: { name: 'screen-wake-lock' }, setting: 'granted', browserContextId: targetInfo.browserContextId });
    }
    const locks = () => page.evaluate(() => (window as unknown as { wakeLocks: { granted: boolean; released: boolean }[] }).wakeLocks);
    // The files go up only when the test lets them.
    let open: () => void = () => undefined;
    let gate = new Promise<void>((resolve) => (open = resolve));
    await page.route('**/api/uploads/**', async (route) => {
      if (route.request().method() === 'PATCH') await gate;
      // A request the page gave up meanwhile (the upload stopped) is no longer the route's.
      await route.continue().catch(() => undefined);
    });

    await page.goto(`/clubs/${club.id}`);
    expect(await page.evaluate(() => 'wakeLock' in navigator)).toBe(true);
    await page.getByRole('button', { name: 'Add a book' }).click();
    await page.getByTestId('file-input').setInputFiles(track);
    await page.getByTestId('upload-title').fill('A Long Tale');
    expect(await locks()).toEqual([]);
    await page.getByTestId('upload-start').click();
    await expect(page.getByTestId('upload-progress')).toBeVisible();
    await expect(page.getByTestId('keep-screen-on')).toHaveText('Keep this screen on until it finishes. If your phone locks, the upload pauses and goes on when you come back.');
    await expect.poll(locks).toEqual([{ granted: true, released: false }]);
    open();
    await expect(page).toHaveURL(/\/books\/[^/]+$/, { timeout: 120_000 });
    // In: let go.
    await expect.poll(locks).toEqual([{ granted: true, released: true }]);

    // Stopped: let go too.
    gate = new Promise<void>((resolve) => (open = resolve));
    const bookId = page.url().split('/books/')[1]!;
    // Add a format is in Book settings (D198).
    await (await openBookSettings(page)).getByRole('button', { name: 'Add a format' }).click();
    await page.getByTestId('file-input').setInputFiles(track);
    await page.getByTestId('upload-start').click();
    await expect(page.getByTestId('keep-screen-on')).toBeVisible();
    await expect.poll(async () => (await locks()).filter((l) => !l.released)).toEqual([{ granted: true, released: false }]);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await answerQuestion(page, 'Stop this upload?', 'Stop');
    await expect.poll(async () => (await locks()).filter((l) => !l.released)).toEqual([]);
    open();
    await page.request.delete(`/api/books/${bookId}`);
    await ctx.close();
  });

  test('a small upload, done before a phone would lock, does not ask for the screen to be kept on', async ({ browser }, info) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner, phoneWithoutWorker(info.project.name));
    const page = await ctx.newPage();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    await page.route('**/api/uploads/**', async (route) => {
      if (route.request().method() === 'PATCH') await gate;
      await route.continue().catch(() => undefined);
    });
    await page.goto(`/clubs/${club.id}`);
    await page.getByRole('button', { name: 'Add a book' }).click();
    await page.getByTestId('file-input').setInputFiles(SCAN);
    await page.getByTestId('upload-start').click();
    await expect(page.getByTestId('upload-progress')).toBeVisible();
    await expect(page.getByText(/^\d+% · .* of \d+ KB$/)).toBeVisible();
    await expect(page.getByTestId('keep-screen-on')).toHaveCount(0);
    open();
    await expect(page).toHaveURL(/\/books\/[^/]+$/, { timeout: 60_000 });
    await page.request.delete(`/api/books/${page.url().split('/books/')[1]!}`);
    await ctx.close();
  });
});
