import { expect, test } from '@playwright/test';
import { browserAs, makeClub, unique } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

test.describe('clubs', () => {
  test('an owner says what the club is about, and the library shows it', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}/settings`);
    await page.getByLabel('What you are reading for').fill('One chapter a week, over dinner.');
    await page.getByTestId('save-club').click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.goto(`/clubs/${club.id}`);
    await expect(page.locator('.club-head')).toContainText('One chapter a week, over dinner.');
    await ctx.close();
  });

  test('a member in one club can start another, and can leave a club', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    // With one club, home goes straight to it; starting another is in Settings.
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    await page.getByRole('link', { name: /^Settings for/ }).click();
    await expect(page.getByRole('heading', { name: 'Your clubs' })).toBeVisible();
    await page.getByTestId('new-club').click();
    const name = unique('Ana’s Tuesday club');
    await page.getByLabel('Club name').fill(name);
    await page.getByLabel('What you are reading for (optional)').fill('Poetry, slowly.');
    await page.getByRole('button', { name: 'Create club' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.locator('.club-head')).toContainText('Poetry, slowly.');

    // In the first club she is a member: its page shows who is in it and lets her leave.
    await page.goto(`/clubs/${club.id}`);
    await page.getByRole('link', { name: 'About this club' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Members' })).toBeVisible();
    await expect(page.getByTestId('save-club')).toHaveCount(0);
    await page.getByTestId('leave-club').click();
    await answerQuestion(page, `Leave ${club.name}?`, 'Leave');
    // Home again, now with only her own club.
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    expect((await club.members.Ana!.api.get(`/api/clubs/${club.id}`)).status()).toBe(404);
    await ctx.close();
  });
});
