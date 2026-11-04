import { devices, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, makeClub, putProgress, serverPlace } from '../helpers/api';

test.describe('the PDF reader', () => {
  test('pages, chapters from the outline, percentage and resume', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER IV\./ }).click();
    const n = page.getByTestId('page-number');
    const pageNo = Number(await n.getAttribute('data-page'));
    expect(pageNo).toBeGreaterThan(10);
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '1');
    // A chapter from the contents is a look, with a way back, until you read on there: past where
    // you have read, three pages on (D72).
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to page 1');
    for (const turned of [1, 2, 3]) {
      if (turned > 1) await expect(page.getByTestId('back-to-reading')).toContainText('Back to page 1');
      await page.getByTestId('next-page').click();
      await expect(n).toHaveAttribute('data-page', String(pageNo + turned));
    }
    await expect(page.getByTestId('back-to-reading')).toHaveCount(0);
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '4');
    expect(Number(await page.getByTestId('percent').getAttribute('data-value'))).toBeGreaterThan(0.2);
    await expect.poll(async () => {
      const l = await serverPlace(page, book.id);
      return l?.kind === 'pdf' && l.page === pageNo + 2;
    }, { timeout: 20_000 }).toBe(true);
    await page.reload();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(pageNo + 3), { timeout: 30_000 });
    await ctx.close();
  });
});

test.describe('the PDF keeps your place', () => {
  test('opened at a place inside a page, without turning one, it saves nothing earlier', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const place = { kind: 'pdf' as const, page: 20, y: 0.5 };
    await putProgress(club.owner, book.id, pdf.id, place, [{ from: { kind: 'pdf', page: 0, y: 0 }, to: place }]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/books/${book.id}/progress`) && r.request().method() === 'PUT', { timeout: 30_000 });
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', '21', { timeout: 30_000 });
    // Its first report (the page counted as read) keeps the place, to the line.
    expect((await saved).ok()).toBe(true);
    expect(await serverPlace(page, book.id)).toEqual(place);
    await ctx.close();
  });
});

test.describe('the PDF up close', () => {
  test('zooms in and out, and pages turn at the page size', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    const canvas = page.locator('.pdf-page canvas');
    await expect(page.locator('.pdf-text span').first()).toBeAttached({ timeout: 30_000 });
    const width = () => canvas.evaluate((c: HTMLCanvasElement) => c.getBoundingClientRect().width);
    const fitted = await width();
    await page.getByTestId('pdf-view').click();
    await expect(page.getByTestId('zoom-out')).toBeDisabled();
    await page.getByTestId('zoom-in').click();
    await expect.poll(width).toBeGreaterThan(fitted * 1.4);
    await page.getByTestId('zoom-in').click();
    await expect.poll(width).toBeGreaterThan(fitted * 2.1);
    await page.getByTestId('zoom-out').click();
    await page.getByTestId('zoom-out').click();
    await expect.poll(width).toBeLessThan(fitted * 1.05);
    await ctx.close();
  });
});

test.describe('the PDF in the reading themes', () => {
  test('a theme chosen in the PDF reader tints its pages and stays after a reload', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.locator('.pdf-text span').first()).toBeAttached({ timeout: 30_000 });
    await page.getByTestId('pdf-view').click();
    await page.getByTestId('pdf-theme-sepia').click();
    await expect(page.getByTestId('pdf-theme-sepia')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.pdf-page')).toHaveClass(/theme-sepia/);
    await page.reload();
    await expect(page.locator('.pdf-page')).toHaveClass(/theme-sepia/, { timeout: 30_000 });
    await ctx.close();
  });
});

test.describe('installable on the home screen', () => {
  test('manifest, icons, theme colour and a service worker are in place', async ({ page }) => {
    // D117 restyle: the manuscript look replaced the old dark-only palette with two themes
    // (vellum/lucerna) that follow the system; pinned here to light so the assertions below are
    // deterministic.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/signin');
    const manifestHref = await page.locator('link[rel=manifest]').getAttribute('href');
    const manifest = (await (await page.request.get(manifestHref!)).json()) as { display: string; start_url: string; icons: { sizes: string; purpose?: string }[] };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    await expect(page.locator('meta[name=theme-color][media*=light]')).toHaveAttribute('content', '#f4ead2');
    await expect(page.locator('meta[name=theme-color][media*=dark]')).toHaveAttribute('content', '#1f160e');
    // The current meta, not the deprecated Apple one v1 replaced.
    await expect(page.locator('meta[name=mobile-web-app-capable]')).toHaveAttribute('content', 'yes');
    await expect(page.locator('meta[name=apple-mobile-web-app-capable]')).toHaveCount(0);
    // Parchment and ink, a sanguine accent (the illuminated-manuscript look, D117).
    const tokens = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return { theme: document.documentElement.dataset.theme, bg: css.getPropertyValue('--bg').trim(), gold: css.getPropertyValue('--gold').trim(), body: getComputedStyle(document.body).backgroundColor };
    });
    expect(tokens).toMatchObject({ theme: 'vellum', bg: '#e2cfa4', gold: '#93361c', body: 'rgb(226, 207, 164)' });
    await expect(page.locator('link[rel=apple-touch-icon]')).toHaveAttribute('href', '/apple-touch-icon.png');
    expect((await page.request.get('/apple-touch-icon.png')).status()).toBe(200);
    await expect.poll(async () => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), { timeout: 20_000 }).toBe(true);
  });

  test('on an iPhone the library says how to put the club on the Home Screen, until told “Got it”', async ({ browser }) => {
    const { club } = await clubWithAlice([]);
    const { userAgent, viewport } = devices['iPhone 15'];
    const iphone = { userAgent, viewport, isMobile: true, hasTouch: true };
    const ctx = await browserAs(browser, club.owner, iphone);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    const hint = page.getByTestId('install-hint');
    await expect(hint).toContainText('Tap Share, then “Add to Home Screen”');
    await expect(page.getByRole('complementary', { name: 'Keep the club on your Home Screen.' })).toBeVisible();
    await hint.getByRole('button', { name: 'Got it' }).click();
    await expect(hint).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await expect(hint).toHaveCount(0);
    await ctx.close();

    // Opened from the Home Screen already, or on a computer: nothing to suggest.
    const installed = await browserAs(browser, club.owner, iphone);
    await installed.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }));
    const desktop = await browserAs(browser, club.owner, { viewport: { width: 1280, height: 800 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
    for (const other of [installed, desktop]) {
      const p = await other.newPage();
      await p.goto(`/clubs/${club.id}`);
      await expect(p.getByTestId('book-card')).toHaveCount(1);
      await expect(p.getByTestId('install-hint')).toHaveCount(0);
      await other.close();
    }
  });
});

test.describe('settings', () => {
  test('a new display name shows to the club', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto('/settings');
    await page.getByLabel('Name friends see').fill('Anastasia');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByText('Name saved.')).toBeVisible();
    const owner = await browserAs(browser, club.owner);
    const o = await owner.newPage();
    await o.goto(`/clubs/${club.id}`);
    await expect(o.getByTestId('presence-member').filter({ hasText: 'Anastasia' })).toBeVisible();
    await ctx.close();
    await owner.close();
  });

  test('the owner issues a reset link and the member sets a new password with it', async ({ browser }) => {
    const club = await makeClub(['Ben']);
    const ownerCtx = await browserAs(browser, club.owner);
    const o = await ownerCtx.newPage();
    await o.goto(`/clubs/${club.id}/settings`);
    await o.getByRole('listitem').filter({ hasText: 'Ben' }).getByRole('button', { name: 'Reset link' }).click();
    const link = (await o.getByRole('status').filter({ hasText: 'one-time link' }).locator('code').innerText()).trim();
    const anon = await browser.newContext();
    const p = await anon.newPage();
    await p.goto(link.replace(/^https?:\/\/[^/]+/, ''));
    await p.getByLabel('New password').fill('a brand new secret');
    await p.getByRole('button', { name: 'Save password' }).click();
    await expect(p.getByRole('heading', { name: 'Password changed' })).toBeVisible();
    await p.getByRole('link', { name: 'Sign in' }).click();
    await p.getByLabel('Email').fill(club.members.Ben!.email);
    await p.getByLabel('Password').fill('a brand new secret');
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(p).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    await anon.close();
    await ownerCtx.close();
  });

  test('the owner renames the club', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}/settings`);
    await page.getByLabel('Club name').fill('Saturday Readers');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Saturday Readers' })).toBeVisible();
    await ctx.close();
  });
});
