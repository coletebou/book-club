import { type Page, expect, test } from '@playwright/test';
import { apiAs, browserAs, clubWithAlice } from '../helpers/api';
import { openBookSettings } from '../helpers/open';

const runtimeFiles = [
  expect.stringMatching(/^\/assets\/pdfjs-[^/]+\/build\/pdf\.min\.mjs$/),
  expect.stringMatching(/^\/assets\/pdfjs-[^/]+\/build\/pdf\.worker\.min\.mjs$/),
];

const cachedPdfRuntime = (page: Page) => page.evaluate(async () => {
  const names = await caches.keys();
  const requests = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
  return requests
    .flat()
    .map((request) => new URL(request.url).pathname)
    .filter((url) => /\/pdf(?:\.min|\.worker[^/]*)\.mjs$/.test(url))
    .sort();
});

test('a clean install gets the PDF runtime when the member saves a PDF', async ({ browser }) => {
  const { club, book } = await clubWithAlice([], { pdf: true });
  const pdf = book.editions.find((edition) => edition.kind === 'pdf')!;
  const context = await browserAs(browser, club.owner);
  try {
    const page = await context.newPage();
    await page.goto(`/books/${book.id}`);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
    expect(await cachedPdfRuntime(page)).toEqual([]);

    const settings = await openBookSettings(page);
    const save = settings.getByTestId('edition').filter({ hasText: 'PDF' }).getByTestId('offline-toggle');
    await save.click();
    await expect(save).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    expect(await cachedPdfRuntime(page)).toEqual(runtimeFiles);

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

test('install keeps the PDF runtime when the device already has a PDF resource cache', async ({ browser, baseURL }) => {
  const api = await apiAs('ana@demo.bookclub', 'wonderland-demo');
  const context = await browser.newContext({ baseURL, storageState: await api.storageState() });
  try {
    const page = await context.newPage();
    await page.goto('/healthz');
    // Earlier releases put the decoders and fonts in this cache, and the worker in precache.
    await page.evaluate(() => caches.open('bc-pdfjs'));
    expect(await cachedPdfRuntime(page)).toEqual([]);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
    expect(await cachedPdfRuntime(page)).toEqual(runtimeFiles);
  } finally {
    await context.close();
    await api.dispose();
  }
});

test('install keeps the PDF runtime when the previous reader cached just the PDF file', async ({ browser }) => {
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
    expect(await cachedPdfRuntime(page)).toEqual([]);

    // An existing reader updates its worker in place. Keep the fixture document open until
    // installation finishes, so the newly written cache entry remains visible in WebKit.
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js', { scope: '/' }));
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
    expect(await cachedPdfRuntime(page)).toEqual(runtimeFiles);
  } finally {
    await context.close();
  }
});

for (const { title, failures, expected } of [
  { title: 'a temporary PDF runtime failure is retried before activation', failures: 1, expected: 'activated' },
  { title: 'a PDF runtime failure stops installation after the retry', failures: 2, expected: 'redundant' },
]) {
  test(title, async ({ browser, browserName, baseURL }) => {
    test.skip(browserName !== 'chromium', 'Fault injection on service worker requests uses Chromium routing.');
    const api = await apiAs('ana@demo.bookclub', 'wonderland-demo');
    const context = await browser.newContext({ baseURL, storageState: await api.storageState() });
    let attempts = 0;
    let warnings = 0;
    context.on('console', (message) => {
      if (message.worker() && message.type() === 'warning' && message.text().startsWith('Book Club could not prepare the offline PDF runtime for this update.')) {
        warnings++;
      }
    });
    try {
      await context.route(/\/assets\/pdfjs-[^/]+\/build\/pdf\.worker\.min\.mjs$/, async (route) => {
        attempts++;
        if (attempts <= failures) await route.fulfill({ status: 503, body: 'Temporary asset failure' });
        else await route.continue();
      });

      const page = await context.newPage();
      await page.goto('/healthz');
      await page.evaluate(() => caches.open('bc-pdfjs'));
      const state = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        const worker = registration.installing ?? registration.waiting ?? registration.active;
        if (!worker) throw new Error('The browser did not start a worker');
        return new Promise<string>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('The worker did not finish installing')), 20_000);
          const onStateChange = () => {
            if (worker.state !== 'activated' && worker.state !== 'redundant') return;
            clearTimeout(deadline);
            worker.removeEventListener('statechange', onStateChange);
            resolve(worker.state);
          };
          worker.addEventListener('statechange', onStateChange);
          onStateChange();
        });
      });

      expect(state).toBe(expected);
      expect(attempts).toBe(2);
      expect(await cachedPdfRuntime(page)).toEqual(expected === 'activated' ? runtimeFiles : []);
      await expect.poll(() => warnings).toBe(expected === 'redundant' ? 1 : 0);
    } finally {
      await context.close();
      await api.dispose();
    }
  });
}
