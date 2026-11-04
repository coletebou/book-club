import { expect, test } from '@playwright/test';
import { PASSWORD, browserAs, clubWithAlice, makeClub } from '../helpers/api';

test.describe('signing in and out', () => {
  test('a signed-out visitor is sent to sign in and comes back to the page they wanted', async ({ page }) => {
    const club = await makeClub([]);
    await page.goto(`/clubs/${club.id}`);
    await expect(page).toHaveURL(/\/signin\?next=/);
    await page.getByLabel('Email').fill(club.owner.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: club.name })).toBeVisible();
  });

  test('a wrong password is refused with a clear message', async ({ page }) => {
    const club = await makeClub([]);
    await page.goto('/signin');
    await page.getByLabel('Email').fill(club.owner.email);
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('That email and password do not match.');
    await expect(page).toHaveURL(/\/signin/);
  });

  test('the setup screen is closed once the instance has an owner', async ({ page }) => {
    await page.goto('/setup');
    await expect(page).not.toHaveURL(/\/setup$/);
  });

  test('signing out clears the session and the device', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByRole('heading', { level: 1, name: club.name })).toBeVisible();
    await page.goto('/settings');
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/signin/);
    const res = await page.request.get('/api/me');
    expect(res.status()).toBe(401);
    // Nothing of the club is left in this browser's caches.
    await expect
      .poll(async () => page.evaluate(async () => ('caches' in window ? (await caches.keys()).filter((n) => n.startsWith('bc-')) : [])), { timeout: 10_000 })
      .toEqual([]);
    await ctx.close();
  });

  test('the session survives a reload and a new tab (long-lived sign-in)', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: club.name })).toBeVisible();
    const tab = await ctx.newPage();
    await tab.goto('/');
    await expect(tab).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    const cookies = await ctx.cookies();
    const session = cookies.find((c) => c.name === 'bc_session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    expect(session!.expires * 1000 - Date.now()).toBeGreaterThan(150 * 24 * 3600_000);
    await ctx.close();
  });

  test('on a shared phone the next person gets nothing of the last one: no player, no reading, no place', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { audio: 'tiny' });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    // Ana listens to chapter 3 on the shared phone, then signs out.
    await page.goto(`/books/${book.id}/listen`);
    await page.getByTestId('toggle-tracks').click();
    await page.locator('.track-item').nth(2).click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '2');
    // A chapter from the list is a look until Play (D72).
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await page.waitForTimeout(1500);
    // Within the app (no reload), the player keeps going while Ana moves on to her settings.
    await page.getByRole('link', { name: /^Back to / }).click();
    await page.getByRole('link', { name: /^Settings for / }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByTestId('mini-player')).toHaveCount(0);
    // Ben signs in on the same phone: no player of Ana's, and his reading is his own.
    await page.getByLabel('Email').fill(club.members.Ben!.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/signin/);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '0');
    await page.waitForTimeout(1000);
    const ben = (await (await page.request.get(`/api/books/${book.id}/progress`)).json()) as { mine: { readRanges: unknown[] } | null };
    expect(ben.mine?.readRanges ?? []).toEqual([]);
    await ctx.close();
  });
});
