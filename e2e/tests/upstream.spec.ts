import { randomBytes } from 'node:crypto';
import { type Browser, type Page, type Request, expect, test } from '@playwright/test';
import type { ClubDetail, SessionInfo } from '@bookclub/shared';
import { BASE, browserAs, makeClub, unique } from '../helpers/api';

/**
 * v1 had no accounts of its own: friends signed in at the upstream. v2 lets them continue with their
 * upstream account through the upstream's sign-in grant (D116). The demo stack runs a stand-in for that
 * grant (tools/fake-upstream); these tests go through it the way a friend's browser would, page by
 * page.
 */
const UPSTREAM = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:47101';
const UPSTREAM_PASSWORD = 'upstream-demo';
/** The stand-in's own session: a cookie of its host's, which Book Club never reads. */
const UPSTREAM_SESSION = 'upstream_demo_session';
const CALLBACK = `${BASE}/api/auth/upstream/callback`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const random = () => randomBytes(32).toString('base64url');

/** On the upstream's page the app sent the browser to: sign in there. */
async function signInAtUpstream(page: Page, email: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${escapeRe(UPSTREAM)}/login\\?returnTo=`));
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(UPSTREAM_PASSWORD);
  await page.getByRole('button', { name: 'Sign in to Upstream ID' }).click();
}

const session = async (page: Page) => (await (await page.request.get('/api/session')).json()) as SessionInfo;

const refused = async (page: Page) => {
  await expect(page).toHaveURL(/\/signin\?upstream=refused/);
  await expect(page.getByRole('alert')).toHaveText('Upstream ID did not sign you in here. Try again, or ask your club owner.');
  expect((await session(page)).user).toBeNull();
};

/** A new browser signed in through the upstream as `email`, and the way back it came by (spent). */
async function signedInThroughUpstream(browser: Browser, email: string): Promise<{ page: Page; callback: string; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let callback = '';
  page.on('request', (r) => {
    if (r.url().startsWith(CALLBACK)) callback = r.url();
  });
  // D173 took the button for this (D116) off the sign-in page itself (it now offers an upstream
  // password straight in its own form instead); the grant is reached directly, as the invite
  // page's own "Continue with Upstream ID" (components/Form.tsx) still reaches it.
  await page.goto('/api/auth/upstream?next=%2F');
  await signInAtUpstream(page, email);
  await expect(page).toHaveURL(`${BASE}/`);
  expect(callback).toMatch(/[?&]code=/);
  return { page, callback, close: () => ctx.close() };
}

test.describe('one identity: friends continue with their upstream account', () => {
  test('an upstream friend signed in in Safari gets a code there, and the app on the Home Screen, with cookies of its own, signs in with it once (D87)', async ({ browser }) => {
    const club = await makeClub([], 'Olive');
    const email = `${unique('gil')}@upstream.test`;
    // Safari: in through the invite, with the upstream.
    const safari = await browser.newContext();
    const page = await safari.newPage();
    await page.goto(`/join/${club.invite}`);
    await page.getByRole('link', { name: 'Continue with Upstream ID' }).click();
    await signInAtUpstream(page, email);
    await page.getByRole('button', { name: /^Join as / }).click();
    await expect(page).toHaveURL(`${BASE}/clubs/${club.id}`);
    await page.goto('/settings');
    await page.getByTestId('get-sign-in-code').click();
    const code = (await page.getByTestId('sign-in-code').textContent())!;
    expect(code).toMatch(/^\d{4} \d{4}$/);
    await expect(page.getByRole('status').filter({ hasText: 'Your code' })).toContainText('Works until');

    // The app on the Home Screen: cookies of its own, signed in nowhere, not even at the upstream.
    const app = await browser.newContext();
    const home = await app.newPage();
    await home.goto(`/signin?next=${encodeURIComponent(`/clubs/${club.id}`)}`);
    await home.getByTestId('use-code').click();
    await home.getByLabel('Sign-in code').fill(code);
    await home.getByRole('button', { name: 'Sign in with the code' }).click();
    await expect(home).toHaveURL(`${BASE}/clubs/${club.id}`);
    expect((await session(home)).user).toMatchObject({ email, source: 'upstream' });
    // It never held the upstream's session (nor went there): the code alone signed it in.
    expect((await app.cookies()).map((c) => c.name)).not.toContain(UPSTREAM_SESSION);

    // A code works once: typed again elsewhere, it is refused, saying why.
    const other = await browser.newContext();
    const again = await other.newPage();
    await again.goto('/signin');
    await again.getByTestId('use-code').click();
    await again.getByLabel('Sign-in code').fill(code);
    await again.getByRole('button', { name: 'Sign in with the code' }).click();
    await expect(again.getByRole('alert')).toHaveText('That code does not work. A code works once, for 10 minutes: get a new one where you are signed in.');
    expect((await session(again)).user).toBeNull();
    await Promise.all([safari.close(), app.close(), other.close()]);
  });

  test('a friend with an upstream account joins by the invite link, without making an account here', async ({ browser }) => {
    const club = await makeClub([], 'Olive');
    const email = `${unique('fern')}@upstream.test`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/join/${club.invite}`);
    await page.getByRole('link', { name: 'Continue with Upstream ID' }).click();
    await signInAtUpstream(page, email);

    // Back on the invite, signed in as the upstream knows her: one tap to join.
    await expect(page).toHaveURL(`${BASE}/join/${club.invite}`);
    await page.getByRole('button', { name: 'Join as Fern' }).click();
    await expect(page).toHaveURL(`${BASE}/clubs/${club.id}`);
    expect((await session(page)).user).toMatchObject({ displayName: 'Fern', email, source: 'upstream' });
    const detail = (await (await club.owner.api.get(`/api/clubs/${club.id}`)).json()) as ClubDetail;
    expect(detail.members.map((m) => m.displayName)).toContain('Fern');

    // Her name and her password belong to the upstream.
    await page.goto('/settings');
    await expect(page.getByLabel('Name friends see')).toBeDisabled();
    await expect(page.getByText('Your name comes from Upstream ID.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Password' })).toHaveCount(0);
    await ctx.close();

    // For the owner too: there is no password here to reset, so no reset link is offered.
    const ownerCtx = await browserAs(browser, club.owner);
    const owner = await ownerCtx.newPage();
    await owner.goto(`/clubs/${club.id}/settings`);
    const fern = owner.getByRole('listitem').filter({ hasText: 'Fern' });
    await expect(fern).toContainText('Signs in with Upstream ID');
    await expect(fern.getByRole('button', { name: 'Reset link' })).toHaveCount(0);
    await expect(fern.getByRole('button', { name: 'Remove' })).toBeVisible();
    await ownerCtx.close();
  });

  test('signing out here keeps you out; the upstream’s grant signs you back in, with no form, once it already knows you', async ({ browser }) => {
    const email = `${unique('hana')}@upstream.test`;
    const { page, close } = await signedInThroughUpstream(browser, email);
    expect((await session(page)).user).toMatchObject({ displayName: 'Hana', source: 'upstream' });

    await page.goto('/settings');
    await expect(page.getByText('You stay signed in to Upstream ID')).toBeVisible();
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/signin$/);
    // Still signed in at the upstream, but signed out here, reload after reload.
    expect((await page.context().cookies(UPSTREAM)).some((c) => c.name === UPSTREAM_SESSION)).toBe(true);
    await page.reload();
    expect((await session(page)).user).toBeNull();

    // The grant itself (D116) still works where it is still reached (the invite page's own
    // "Continue with Upstream ID", components/Form.tsx): a trip through the upstream, which knows her
    // still, and in, with no form.
    const atUpstream: Request[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(UPSTREAM)) atUpstream.push(r);
    });
    await page.goto('/api/auth/upstream?next=%2F');
    await expect(page).toHaveURL(`${BASE}/`);
    expect((await session(page)).user).toMatchObject({ displayName: 'Hana' });
    const paths = atUpstream.map((r) => new URL(r.url()).pathname);
    expect(paths).toEqual(expect.arrayContaining(['/api/auth/book-club/start', '/login', '/api/auth/book-club/complete']));
    // Its sign-in page only sent her on: it never showed the form.
    for (const r of atUpstream.filter((x) => new URL(x.url()).pathname === '/login')) expect((await r.response())?.status()).toBe(303);
    await close();
  });

  test('the upstream’s word is checked: a deactivated account, a forged way back or a replayed one signs nobody in', async ({ browser, request }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/api/auth/upstream?next=%2F');
    await signInAtUpstream(page, 'gus@upstream.test');
    // The upstream signed Gus in, but his account is deactivated there: told so, once, not sent round again.
    await refused(page);

    // A way back this browser never set out on: nobody.
    await page.goto(`/api/auth/upstream/callback?state=${random()}&code=${random()}`);
    await refused(page);
    await ctx.close();

    // Someone else's fresh, unused code, sent to this browser (to sign it in as them): nobody.
    // Mallory keeps her way back for herself: her browser forgets its sign-in under way before she
    // signs in at the upstream, so Book Club redeems nothing there and the code stays good.
    const mallory = await browser.newContext();
    const malloryPage = await mallory.newPage();
    let trap = '';
    malloryPage.on('request', (r) => {
      if (r.url().startsWith(CALLBACK)) trap = r.url();
    });
    await malloryPage.goto('/api/auth/upstream?next=%2F');
    await expect(malloryPage).toHaveURL(new RegExp(`^${escapeRe(UPSTREAM)}/login\\?returnTo=`));
    const flight = (await mallory.cookies(BASE)).find((c) => c.name === 'bc_upstream')!;
    await mallory.clearCookies({ name: 'bc_upstream' });
    await signInAtUpstream(malloryPage, `${unique('mallory')}@upstream.test`);
    await refused(malloryPage);
    expect(trap).toMatch(/[?&]code=/);
    await mallory.close();
    const victim = await browser.newContext();
    const victimPage = await victim.newPage();
    await victimPage.goto(trap);
    await refused(victimPage);
    await victim.close();
    // The code was good all along: with the verifier only Mallory's cookie held, the upstream redeems it.
    const { verifier } = JSON.parse(Buffer.from(decodeURIComponent(flight.value), 'base64url').toString('utf8')) as { verifier: string };
    const redeemed = await request.post(`${UPSTREAM}/api/auth/book-club/exchange`, { data: { code: new URL(trap).searchParams.get('code'), codeVerifier: verifier } });
    expect(redeemed.status()).toBe(200);
    expect(((await redeemed.json()) as { user: { name: string } }).user.name).toBe('Mallory');

    // A way back already used, again in its own browser after signing out, or in another: nobody.
    const jo = await signedInThroughUpstream(browser, `${unique('jo')}@upstream.test`);
    await jo.page.goto('/settings');
    await jo.page.getByTestId('sign-out').click();
    await expect(jo.page).toHaveURL(/\/signin$/);
    await jo.page.goto(jo.callback);
    await refused(jo.page);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(jo.callback);
    await refused(otherPage);
    await other.close();
    await jo.close();
  });
});

test.describe('an upstream password, typed straight into the sign-in form (D173)', () => {
  /**
   * The iOS app's WebView cannot bounce to the upstream's sign-in page and come back ("Continue with
   * Upstream ID" never returns there), so an upstream friend types their email and password into this
   * app's own form instead. No navigation ever leaves this origin: the browser stays at `/signin`
   * throughout, unlike "Continue with Upstream ID" above, which visits the upstream's pages.
   */
  test('signs an upstream friend in with no visit to the upstream at all', async ({ page }) => {
    const email = `${unique('pat')}@upstream.test`;
    const left: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith(BASE)) left.push(r.url());
    });
    await page.goto('/signin');
    await expect(page.getByTestId('upstream-password-hint')).toBeVisible();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(UPSTREAM_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/`);
    expect((await session(page)).user).toMatchObject({ displayName: 'Pat', source: 'upstream' });
    expect(left).toEqual([]);
  });

  test('a wrong upstream password is refused with the same message a wrong local password gets', async ({ page }) => {
    const email = `${unique('robin')}@upstream.test`;
    await page.goto('/signin');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('That email and password do not match.');
    await expect(page).toHaveURL(/\/signin/);
    expect((await session(page)).user).toBeNull();
  });

  test('a deactivated upstream account’s password is refused', async ({ page }) => {
    const email = `${unique('inactive-robin')}@upstream.test`;
    await page.goto('/signin');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(UPSTREAM_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('That email and password do not match.');
    expect((await session(page)).user).toBeNull();
  });

  test('a repeat sign-in with the same password is the same account as the first, not a second one', async ({ page }) => {
    const email = `${unique('sage')}@upstream.test`;
    const signIn = async () => {
      await page.goto('/signin');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(UPSTREAM_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(`${BASE}/`);
      return (await session(page)).user!.id;
    };
    const first = await signIn();
    await page.goto('/settings');
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/signin/);
    const second = await signIn();
    expect(second).toBe(first);
  });
});
