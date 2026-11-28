import { expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';

test('install skips unused assets and keeps a downloaded book and its queued note', async ({ browser }) => {
  const { club, book } = await clubWithAlice([]);
  const epub = book.editions.find((edition) => edition.kind === 'epub')!;
  const readerUrl = `/books/${book.id}/read?edition=${epub.id}`;
  const context = await browserAs(browser, club.owner);
  const text = 'Written after the book was kept';
  const notes = async () => {
    const response = await club.owner.api.get(`/api/books/${book.id}/comments`);
    expect(response.ok()).toBe(true);
    const comments: { text?: string }[] = await response.json();
    return comments.filter((comment) => comment.text === text);
  };
  try {
    const page = await context.newPage();
    await page.goto(readerUrl);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-offline', 'kept', { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => page.evaluate(async (bookId) => (await caches.match(`/api/books/${bookId}`, { cacheName: 'bc-api' }))?.ok, book.id)).toBe(true);
    const precached = await page.evaluate(async () => {
      const names = (await caches.keys()).filter((name) => name.startsWith('workbox-precache'));
      const requests = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
      return requests.flat().map((req) => new URL(req.url).pathname);
    });
    expect(precached).toContain('/index.html');
    expect(precached.filter((url) => url.startsWith('/landing/'))).toEqual([]);
    expect(precached).toContain('/fonts/eb-garamond-latin-wght-normal.woff2');
    expect(precached.filter((url) => /^\/fonts\/(italianno|jetbrains-mono)-/.test(url))).toEqual([]);

    await page.close();
    await context.setOffline(true);
    const offline = await context.newPage();
    // The reader is the only route visited online. The Book page must be able to load on its first visit.
    await offline.goto(`/books/${book.id}`);
    await expect(offline.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();
    await offline.goto(readerUrl);
    await expect(offline.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    const reader = offline.getByTestId('reader');
    const before = await reader.getAttribute('data-start');
    await offline.getByTestId('next-page').click();
    await expect(reader).not.toHaveAttribute('data-start', before ?? '');
    await offline.getByTestId('add-note').click();
    await offline.getByTestId('note-text').fill(text);
    await offline.getByTestId('note-submit').click();
    await expect(offline.getByText('No network: this is kept on this device and will be pinned when you are back online.')).toBeVisible();
    expect(await notes()).toHaveLength(0);

    await offline.reload();
    await expect(offline.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await context.setOffline(false);
    await expect.poll(async () => (await notes()).length, { timeout: 30_000 }).toBe(1);
  } finally {
    await context.close();
  }
});
