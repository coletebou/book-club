import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { PASSWORD, browserAs, makeClub, unique } from '../helpers/api';

/** Zero serious or critical WCAG 2.1 A/AA violations, as e2e/tests/a11y.spec.ts checks every other page. */
async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`),
    `${label} has serious or critical accessibility violations`,
  ).toEqual([]);
}

/**
 * A second instance with OPEN_SIGNUP left at its default (off): started by hand next to the main
 * dev stack (`OPEN_SIGNUP=0 scripts/dev-stack.sh <port>`) and pointed at with this address, so the
 * "invite-only" behaviour is seen on a real, unstubbed server rather than guessed at from the one
 * instance this whole suite otherwise shares (which demos OPEN_SIGNUP on, D211). Skipped, not
 * failed, when it is not running — the rest of this file needs only the main stack.
 */
const CLOSED_BASE = process.env.BOOKCLUB_URL_CLOSED;

test.describe('the landing page (D210)', () => {
  test('a signed-out visitor at / sees the landing page, not a sign-in wall', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Read together. Never spoiled.' })).toBeVisible();
    await expect(page.getByText('spoiler-free by construction', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View the source on GitHub' })).toHaveAttribute('href', 'https://github.com/coletebou/book-club');
    // No pricing, now or implied.
    await expect(page.getByText(/pric(e|ing)/i)).toHaveCount(0);
    await expectAccessible(page, 'the landing page, signed out');
  });

  test('a signed-in visitor at / still sees their own home page, unchanged', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: club.name })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Read together. Never spoiled.' })).toHaveCount(0);
    await ctx.close();
  });

  test('"Join with a link" from the landing page opens the same join flow a club invite uses', async ({ page }) => {
    const club = await makeClub([]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Join with a link' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Join with a link or code' })).toBeVisible();
    await page.getByLabel('Invite link or code').fill(club.invite);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(new RegExp(`/join/${club.invite}$`));
    await expect(page.getByRole('heading', { name: `Join ${club.name}` })).toBeVisible();
  });

  test('starting a club end to end: the landing page’s own door creates the account and the club, and lands with the invite link ready to copy', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Start a club' }).first().click();
    await expect(page).toHaveURL(/\/start$/);
    await expect(page.getByRole('heading', { name: 'Start a club' })).toBeVisible();
    const email = `${unique('nora')}@e2e.test`;
    await page.getByLabel('Your name').fill('Nora');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByLabel('Club name').fill('Thursday Readers');
    await page.getByRole('button', { name: 'Create my club' }).click();
    await expect(page).toHaveURL(/\/clubs\/[^/]+\/settings\?welcome=1$/);
    await expect(page.getByTestId('club-welcome')).toBeVisible();
    await expect(page.getByTestId('club-welcome')).toContainText('Thursday Readers');
    await expect(page.locator('code.invite-code')).toBeVisible();
    await expect(page.getByTestId('copy-invite')).toBeVisible();
    // Really signed in, as the owner of really one club.
    const me = await page.request.get('/api/me');
    expect(me.status()).toBe(200);
    const clubs = (await (await page.request.get('/api/clubs')).json()) as { name: string; role: string }[];
    expect(clubs).toEqual([expect.objectContaining({ name: 'Thursday Readers', role: 'owner' })]);
    await expectAccessible(page, 'the new club’s settings page, just after starting it');
  });

  test('flag off: /start and the landing page explain the instance is invite-only, and still offer sign in and a link', async ({ page }) => {
    test.skip(!CLOSED_BASE, 'needs a second instance with OPEN_SIGNUP off: BOOKCLUB_URL_CLOSED=http://127.0.0.1:<port>');
    await page.goto(`${CLOSED_BASE}/`);
    await expect(page.getByText('This instance is invite-only right now', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join with a link' }).first()).toBeVisible();
    await expectAccessible(page, 'the landing page, OPEN_SIGNUP off');
    await page.goto(`${CLOSED_BASE}/start`);
    await expect(page.getByRole('heading', { name: 'This instance is invite-only' })).toBeVisible();
    await expect(page.getByLabel('Club name')).toHaveCount(0);
    await expectAccessible(page, '/start, OPEN_SIGNUP off');
  });
});
