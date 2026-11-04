import { type Locator, expect, test } from '@playwright/test';
import type { BookProgress } from '@bookclub/shared';
import { browserAs, clubWithAlice, serverPlace } from '../helpers/api';

test.describe('reading offline', () => {
  test('a note written with no network is kept on the device and pinned once the network is back', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    const notes = async () => ((await (await club.owner.api.get(`/api/books/${book.id}/comments`)).json()) as { text?: string | null }[]).filter((c) => c.text === 'Written on the plane');

    await ctx.setOffline(true);
    await page.getByTestId('add-note').click();
    await page.getByTestId('note-text').fill('Written on the plane');
    await page.getByTestId('note-submit').click();
    // Told it is kept, and the composer is done with.
    await expect(page.getByText('No network: this is kept on this device and will be pinned when you are back online.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('note-text')).toHaveCount(0);
    expect(await notes()).toHaveLength(0);

    await ctx.setOffline(false);
    // Pinned once, however often the device tried meanwhile.
    await expect.poll(async () => (await notes()).length, { timeout: 30_000 }).toBe(1);
    await page.waitForTimeout(1000);
    expect(await notes()).toHaveLength(1);
    await ctx.close();
  });

  test('a note saved with no network is kept at once, without "Posting…" first; a request that fails gives up quickly; a slow network still posts (fidelity review round 16)', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const notes = async (text: string) => ((await (await club.owner.api.get(`/api/books/${book.id}/comments`)).json()) as { text?: string | null }[]).filter((c) => c.text === text);
    const open = async (options: Parameters<typeof browserAs>[2] = {}) => {
      const ctx = await browserAs(browser, club.owner, options);
      const page = await ctx.newPage();
      await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
      await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
      const kept = page.getByText('No network: this is kept on this device and will be pinned when you are back online.');
      /** Write a note and press Post: how long until it is done with. */
      const post = async (text: string, done: Locator) => {
        await page.getByTestId('add-note').click();
        await page.getByTestId('note-text').fill(text);
        const pressed = Date.now();
        await page.getByTestId('note-submit').click();
        await expect(done).toBeVisible({ timeout: 15_000 });
        const took = Date.now() - pressed;
        await expect(page.getByTestId('note-text')).toHaveCount(0);
        return took;
      };
      return { ctx, page, kept, post };
    };

    // The browser knows it has no network: kept at once (it said "Posting…" for 3 s in WebKit).
    const offline = await open();
    await offline.ctx.setOffline(true);
    expect(await offline.post('Kept at once', offline.kept)).toBeLessThan(1500);
    await offline.ctx.setOffline(false);
    await expect.poll(async () => (await notes('Kept at once')).length, { timeout: 30_000 }).toBe(1);
    await offline.ctx.close();

    // Online as far as the browser knows, but the request never gets through: one quick try more,
    // then kept. (No service worker here: WebKit's routes do not see what a page it controls sends.)
    const { ctx, page, kept, post } = await open({ serviceWorkers: 'block' });
    await page.route('**/api/books/*/comments', (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.fallback()));
    expect(await post('Kept after a failed try', kept)).toBeLessThan(2000);
    await page.unroute('**/api/books/*/comments');
    // Pinned by itself once requests get through again, once.
    await expect.poll(async () => (await notes('Kept after a failed try')).length, { timeout: 30_000 }).toBe(1);
    await expect(kept).toHaveCount(0, { timeout: 10_000 });

    // A slow network that works: it waits, and posts.
    await page.route('**/api/books/*/comments', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return route.continue();
    });
    expect(await post('Posted slowly', page.locator('.toast-text').getByText('Note pinned here.'))).toBeGreaterThanOrEqual(3000);
    await expect(kept).toHaveCount(0);
    expect(await notes('Posted slowly')).toHaveLength(1);
    await page.unroute('**/api/books/*/comments');
    await ctx.close();
  });

  test('a cached book opens and pages turn with no network; progress syncs after reconnecting', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    // The book is kept on the device after opening; wait until the service worker controls the
    // page and the reader has finished keeping every file (leaving earlier is covered below).
    await expect.poll(async () => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20_000 }).toBe(true);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-offline', 'kept', { timeout: 30_000 });
    expect(await page.evaluate(async (id) => (await caches.keys()).includes(`bc-ed-${id}`), epub.id)).toBe(true);
    await page.goto(`/books/${book.id}`);
    await expect(page.getByTestId('offline-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });

    await ctx.setOffline(true);
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER VIII\./ }).click();
    await expect(page.locator('.reader-chapter')).toContainText('Croquet');
    for (let i = 0; i < 3; i++) await page.getByTestId('next-page').click();
    const offlinePage = await page.getByTestId('page-number').getAttribute('data-page');
    await page.waitForTimeout(1500);
    const serverBefore = (await (await club.owner.api.get(`/api/books/${book.id}/progress`)).json()) as BookProgress;
    expect(serverBefore.mine?.label ?? '').not.toContain('Chapter 8');

    await ctx.setOffline(false);
    await expect
      .poll(async () => ((await (await club.owner.api.get(`/api/books/${book.id}/progress`)).json()) as BookProgress).mine?.label ?? '', { timeout: 20_000 })
      .toContain('Chapter 8');
    expect(offlinePage).not.toBeNull();
    await ctx.close();
  });

  test('a book read on the very first visit opens with no network, without a second visit online', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    // The first visit on this device: everything it fetches comes before the service worker.
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-offline', 'kept', { timeout: 30_000 });
    await expect.poll(async () => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20_000 }).toBe(true);
    await ctx.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(page.getByText('Book Club could not be reached.')).toHaveCount(0);
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('reader')).toHaveAttribute('data-offline', 'kept');
    await ctx.setOffline(false);
    await ctx.close();
  });

  test('pages turned quickly offline, then the app closed at once: it reopens there, and the server hears of it', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    const reader = page.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-offline', 'kept', { timeout: 30_000 });
    await expect.poll(async () => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20_000 }).toBe(true);
    await ctx.setOffline(true);
    for (let i = 0; i < 5; i++) {
      const before = await reader.getAttribute('data-start');
      await page.getByTestId('next-page').click();
      await expect(reader).not.toHaveAttribute('data-start', before!);
    }
    const last = { section: Number(await reader.getAttribute('data-section')), offset: Number(await reader.getAttribute('data-start')) };
    // Closed at once, before the reader's usual save.
    await page.reload();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(reader).toHaveAttribute('data-section', String(last.section));
    await expect(reader).toHaveAttribute('data-start', String(last.offset));
    await ctx.setOffline(false);
    await expect.poll(async () => serverPlace(page, book.id), { timeout: 20_000 }).toMatchObject({ kind: 'epub', section: last.section, offset: last.offset });
    await ctx.close();
  });

  test('a book left at once after opening is still kept on the device', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    // The first page is up: straight back to the book, in the app, as a reader who only looked.
    await expect(page.getByTestId('reader')).not.toHaveAttribute('data-section', '', { timeout: 30_000 });
    await page.getByRole('link', { name: `Back to ${book.title}` }).click();
    await expect(page.getByTestId('offline-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    expect(await page.evaluate(async (id) => (await caches.keys()).includes(`bc-ed-${id}`), epub.id)).toBe(true);
    await ctx.close();
  });

  test('a PDF read once is kept on the device and opens with no network', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await expect.poll(async () => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20_000 }).toBe(true);
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.locator('.pdf-text span').first()).toBeAttached({ timeout: 30_000 });
    // Kept without asking, as an EPUB is. As in the EPUB test above, the reader finishes keeping
    // before the page is reloaded (a reload stops the page's work; leaving in the app does not).
    await expect(page.getByTestId('reader')).toHaveAttribute('data-offline', 'kept', { timeout: 30_000 });
    await page.goto(`/books/${book.id}`);
    const row = page.getByTestId('edition').filter({ hasText: 'PDF' });
    await expect(row.getByTestId('offline-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await ctx.setOffline(true);
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.locator('.pdf-text span').first()).toBeAttached({ timeout: 30_000 });
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('reader')).toHaveAttribute('data-page-index', /\d+/);
    await ctx.setOffline(false);
    await ctx.close();
  });

  test('opened offline before the club list was ever kept, the home page says so at once and offers the kept book', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    // Straight to the reader, as from an invite: the club list is never needed.
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-offline', 'kept', { timeout: 30_000 });
    await expect.poll(async () => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20_000 }).toBe(true);
    // Whatever was fetched in the background, this device keeps no club list.
    await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const r of await cache.keys()) if (new URL(r.url).pathname === '/api/clubs') await cache.delete(r);
      }
    });
    await ctx.setOffline(true);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('link', { name: book.title }).click();
    await expect(page.getByRole('heading', { level: 1, name: book.title })).toBeVisible();
    await ctx.setOffline(false);
    await ctx.close();
  });

  test('the library and the book page still open offline', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await expect.poll(async () => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20_000 }).toBe(true);
    // A second visit, now through the service worker (as any returning reader's would be).
    await page.reload();
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await page.goto(`/books/${book.id}`);
    await expect(page.getByRole('heading', { level: 1, name: book.title })).toBeVisible();
    await ctx.setOffline(true);
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await expect(page.getByTestId('offline-chip')).toBeVisible();
    await page.goto(`/books/${book.id}`);
    await expect(page.getByRole('heading', { level: 1, name: book.title })).toBeVisible();
    await ctx.setOffline(false);
    await ctx.close();
  });
});
