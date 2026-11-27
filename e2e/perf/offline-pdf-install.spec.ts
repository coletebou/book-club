import { type Page, expect, test } from '@playwright/test';
import { apiAs, browserAs, clubWithAlice } from '../helpers/api';
import { openBookSettings } from '../helpers/open';

const workerPath = /^\/assets\/pdfjs-[^/]+\/build\/pdf\.worker\.min\.mjs$/;

const cachedWorkers = (page: Page) => page.evaluate(async () => {
  const names = await caches.keys();
  const requests = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
  return requests.flat().map((request) => new URL(request.url).pathname).filter((url) => /\/pdf\.worker[^/]*\.mjs$/.test(url));
});

test('a clean install gets the PDF worker when the member saves a PDF', async ({ browser }) => {
  const { club, book } = await clubWithAlice([], { pdf: true });
  const pdf = book.editions.find((edition) => edition.kind === 'pdf')!;
  const context = await browserAs(browser, club.owner);
  try {
    const page = await context.newPage();
    await page.goto(`/books/${book.id}`);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
    expect(await cachedWorkers(page)).toEqual([]);

    const settings = await openBookSettings(page);
    const save = settings.getByTestId('edition').filter({ hasText: 'PDF' }).getByTestId('offline-toggle');
    await save.click();
    await expect(save).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    expect(await cachedWorkers(page)).toEqual([expect.stringMatching(workerPath)]);

    // The PDF was saved from Settings without opening it. The first draw happens offline.
    await page.close();
    await context.setOffline(true);
    const offline = await context.newPage();
    await offline.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(offline.locator('.pdf-text span').first()).toBeAttached({ timeout: 30_000 });
  } finally {
    await context.close();
  }
});

test('install keeps the new worker when the device already has a PDF resource cache', async ({ browser, baseURL }) => {
  const api = await apiAs('ana@demo.bookclub', 'wonderland-demo');
  const context = await browser.newContext({ baseURL, storageState: await api.storageState() });
  try {
    const page = await context.newPage();
    await page.goto('/healthz');
    // Earlier releases put the decoders and fonts in this cache, and the worker in precache.
    await page.evaluate(() => caches.open('bc-pdfjs'));
    expect(await cachedWorkers(page)).toEqual([]);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
    expect(await cachedWorkers(page)).toEqual([expect.stringMatching(workerPath)]);
  } finally {
    await context.close();
    await api.dispose();
  }
});

test('install keeps the worker when the previous reader cached just the PDF file', async ({ browser }) => {
  const { club, book } = await clubWithAlice([], { pdf: true });
  const pdf = book.editions.find((edition) => edition.kind === 'pdf')!;
  const context = await browserAs(browser, club.owner);
  try {
    const page = await context.newPage();
    await page.goto('/healthz');
    // The previous reader saved the file as it downloaded, before the shared resource save.
    await page.evaluate(async ({ editionId, fileUrl }) => {
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error('Could not fetch the fixture PDF');
      const cache = await caches.open(`bc-ed-${editionId}`);
      await cache.put(fileUrl, response);
    }, { editionId: pdf.id, fileUrl: pdf.fileUrl! });
    expect(await page.evaluate(() => caches.has('bc-pdfjs'))).toBe(false);
    expect(await cachedWorkers(page)).toEqual([]);

    // An existing reader updates its worker in place. Keep the fixture document open until
    // installation finishes, so the newly written cache entry remains visible in WebKit.
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js', { scope: '/' }));
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
    expect(await cachedWorkers(page)).toEqual([expect.stringMatching(workerPath)]);
  } finally {
    await context.close();
  }
});
