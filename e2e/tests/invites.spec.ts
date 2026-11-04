import { expect, test } from '@playwright/test';
import { BASE, browserAs, makeClub, makeOutsider, unique } from '../helpers/api';

test.describe('joining a club by invite link', () => {
  test('a new friend opens the invite link, creates an account and lands in the club', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(club.inviteUrl.replace(/^https?:\/\/[^/]+/, BASE));
    await expect(page.getByRole('heading', { name: `Join ${club.name}` })).toBeVisible();
    await expect(page.getByText(/invited you to read with/)).toBeVisible();
    await page.getByLabel('Your name').fill('Dev');
    await page.getByLabel('Email').fill(`${unique('dev')}@e2e.test`);
    await page.getByLabel('Password').fill('dev-reads-books-1');
    await page.getByRole('button', { name: 'Join the club' }).click();
    await expect(page).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    await expect(page.getByTestId('presence-member').filter({ hasText: 'Dev' })).toBeVisible();
    await expect(page.getByTestId('presence-member').filter({ hasText: 'Ana' })).toBeVisible();
    await ctx.close();
  });

  test('someone already signed in joins with one tap', async ({ browser }) => {
    const club = await makeClub([]);
    const someone = await makeOutsider('Sam');
    const ctx = await browserAs(browser, someone);
    const page = await ctx.newPage();
    await page.goto(`/join/${club.invite}`);
    await page.getByRole('button', { name: 'Join as Sam' }).click();
    await expect(page).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    await ctx.close();
  });

  test('a replaced invite link stops working and the new one works', async ({ browser }) => {
    const club = await makeClub([]);
    const ownerCtx = await browserAs(browser, club.owner);
    const owner = await ownerCtx.newPage();
    await owner.goto(`/clubs/${club.id}/settings`);
    await owner.getByRole('button', { name: 'Replace invite link' }).click();
    await expect(owner.locator('code.invite-code').first()).not.toContainText(club.invite);
    const fresh = (await owner.locator('code.invite-code').first().innerText()).split('/join/')[1]!.trim();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/join/${club.invite}`);
    await expect(page.getByRole('heading', { name: 'This invite has expired' })).toBeVisible();
    await page.goto(`/join/${fresh}`);
    await expect(page.getByRole('heading', { name: `Join ${club.name}` })).toBeVisible();
    await ctx.close();
    await ownerCtx.close();
  });

  test('the owner shares the invite link from the library', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    await page.getByRole('button', { name: 'Invite' }).click();
    await expect(page.getByTestId('invite-url')).toHaveValue(new RegExp(`/join/${club.invite}$`));
    await ctx.close();
  });

  test('a member who is removed loses the club at once', async ({ browser }) => {
    const club = await makeClub(['Ben']);
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}`);
    await expect(ben.getByRole('heading', { level: 1, name: club.name })).toBeVisible();
    const res = await club.owner.api.delete(`/api/clubs/${club.id}/members/${club.members.Ben!.id}`);
    expect(res.status()).toBe(204);
    await ben.reload();
    await expect(ben.getByRole('heading', { name: 'Club not found' })).toBeVisible();
    await benCtx.close();
  });
});
