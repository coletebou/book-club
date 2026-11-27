import { expect, test } from '@playwright/test';
import type { ClubSummary } from '@bookclub/shared';
import { apiAs } from '../helpers/api';

test('a one-club member sees their library while the club list is still refreshing', async ({ browser, baseURL }) => {
  const api = await apiAs('ana@demo.bookclub', 'wonderland-demo');
  const context = await browser.newContext({ baseURL, storageState: await api.storageState(), serviceWorkers: 'block' });
  const allowClubList = Promise.withResolvers<void>();
  try {
    const clubs: ClubSummary[] = await (await api.get('/api/clubs')).json();
    expect(clubs).toHaveLength(1);
    const club = clubs[0]!;
    const booksPath = `/api/clubs/${club.id}/books`;
    const page = await context.newPage();
    const cdp = browser.browserType().name() === 'chromium' ? await context.newCDPSession(page) : null;
    await cdp?.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1_125_000, uploadThroughput: 375_000 });
    await page.route((url) => url.pathname === '/api/clubs', async (route) => {
      await allowClubList.promise;
      await route.continue();
    });

    const requests: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === '/api/session' || pathname === booksPath) requests.push(pathname);
    });
    await page.goto('/');
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    expect(requests).toEqual(['/api/session', booksPath]);
  } finally {
    allowClubList.resolve();
    await context.close();
    await api.dispose();
  }
});

test('Home can open offline after the service worker took control during the first session request', async ({ browser, baseURL }) => {
  const api = await apiAs('ana@demo.bookclub', 'wonderland-demo');
  const context = await browser.newContext({ baseURL, storageState: await api.storageState() });
  const allowSession = Promise.withResolvers<void>();
  try {
    const page = await context.newPage();
    const isHomeSession = (url: URL) => url.pathname === '/api/session' && url.searchParams.get('home') === '1';
    await page.route(isHomeSession, async (route) => {
      await allowSession.promise;
      await route.continue();
    });
    const requested = page.waitForRequest((req) => isHomeSession(new URL(req.url())), { timeout: 15_000 });
    await page.goto('/');
    await requested;
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
    allowSession.resolve();

    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(async () => (await caches.match('/api/clubs', { cacheName: 'bc-api' }))?.ok), { timeout: 10_000 })
      .toBe(true);
    await page.close();
    await context.setOffline(true);
    const offline = await context.newPage();
    await offline.goto('/');
    await expect(offline.getByTestId('book-card')).toHaveCount(1);
  } finally {
    allowSession.resolve();
    await context.close();
    await api.dispose();
  }
});
