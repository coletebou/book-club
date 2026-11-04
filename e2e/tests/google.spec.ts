import { type Page, expect, test } from '@playwright/test';
import type { ClubDetail, SessionInfo } from '@bookclub/shared';
import { BASE, browserAs, makeClub, unique } from '../helpers/api';

/**
 * "Continue with Google" (D178), in a browser: the server-side redirect (`/api/auth/google/start`
 * → Google's own pages → `/api/auth/google/callback`), against the demo stack's stand-in
 * (tools/fake-google), the way a friend's browser would go through it, page by page. The native
 * in-app flow (Apple fully native, Google through a browser session the app itself opens and
 * closes) has no browser of its own to drive here; it is covered on the server
 * (apps/server/test/auth-apple.test.ts, apps/server/test/auth-google.test.ts) and the web bridge
 * (apps/web/src/auth/native-auth-bridge.test.ts, apps/web/src/pages/SignInPage.providers.test.tsx).
 */
const GOOGLE = process.env.GOOGLE_URL ?? 'http://127.0.0.1:47102';
const GOOGLE_PASSWORD = 'google-demo';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** On Google's own page the app sent the browser to: sign in there. */
async function signInAtGoogle(page: Page, email: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${escapeRe(GOOGLE)}/login`));
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(GOOGLE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in to Google' }).click();
}

const session = async (page: Page) => (await (await page.request.get('/api/session')).json()) as SessionInfo;

test.describe('"Continue with Google" (D178)', () => {
  test('a new friend joins by invite through Google, with no local password account made', async ({ browser }) => {
    const club = await makeClub([], 'Olive');
    const email = `${unique('iris')}@google.test`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/join/${club.invite}`);
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await signInAtGoogle(page, email);

    // Back on the invite, signed in as Google knows her: one tap to join.
    await expect(page).toHaveURL(`${BASE}/join/${club.invite}`);
    await page.getByRole('button', { name: 'Join as Iris' }).click();
    await expect(page).toHaveURL(`${BASE}/clubs/${club.id}`);
    expect((await session(page)).user).toMatchObject({ displayName: 'Iris', email, source: 'google' });
    const detail = (await (await club.owner.api.get(`/api/clubs/${club.id}`)).json()) as ClubDetail;
    expect(detail.members.map((m) => m.displayName)).toContain('Iris');

    // Unlike an upstream account's (D116), nothing here keeps her name in sync from elsewhere: it
    // was handed over once, on this very first sign-in, and stays hers to change.
    await page.goto('/settings');
    await expect(page.getByLabel('Name friends see')).toBeEditable();
    await expect(page.getByText(/Your name comes from/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Password' })).toHaveCount(0);
    await ctx.close();

    // For the owner too: no password here to reset, so no reset link is offered — "Signs in with
    // Google" instead, the same shape as an upstream account's "Signs in with Upstream ID".
    const ownerCtx = await browserAs(browser, club.owner);
    const ownerPage = await ownerCtx.newPage();
    await ownerPage.goto(`/clubs/${club.id}/settings`);
    const iris = ownerPage.getByRole('listitem').filter({ hasText: 'Iris' });
    await expect(iris).toContainText('Signs in with Google');
    await expect(iris.getByRole('button', { name: 'Reset link' })).toHaveCount(0);
    await expect(iris.getByRole('button', { name: 'Remove' })).toBeVisible();
    await ownerCtx.close();
  });

  test('a second sign-in with the same Google account, from a separate browser, is the same account as the first', async ({ browser }) => {
    const email = `${unique('jonas')}@google.test`;
    const signIn = async (): Promise<{ id: string; close: () => Promise<void> }> => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto('/signin');
      await page.getByTestId('google-signin').click();
      await signInAtGoogle(page, email);
      await expect(page).toHaveURL(`${BASE}/`);
      return { id: (await session(page)).user!.id, close: () => ctx.close() };
    };
    const first = await signIn();
    const second = await signIn();
    expect(second.id).toBe(first.id);
    await Promise.all([first.close(), second.close()]);
  });

  test('a wrong Google password is refused at Google, with no change here', async ({ page }) => {
    const email = `${unique('kit')}@google.test`;
    await page.goto('/signin');
    await page.getByTestId('google-signin').click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRe(GOOGLE)}/login`));
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in to Google' }).click();
    await expect(page.getByText('Wrong email or password.')).toBeVisible();
    expect((await session(page)).user).toBeNull();
  });
});
