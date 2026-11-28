import { expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';

test('Cal needs an explicit choice, and Settings revokes it for the account', async ({ browser }) => {
  const { club } = await clubWithAlice([]);
  const ctx = await browserAs(browser, club.owner);
  try {
    const page = await ctx.newPage();
    let turns = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/cal\/conversations\/[^/]+\/messages$/.test(request.url())) turns++;
    });
    await page.goto(`/clubs/${club.id}`);
    const launcher = page.getByTestId('cal-launcher');
    const sheet = page.getByRole('dialog', { name: 'Allow Cal to use AI?' });
    await launcher.click();
    await expect(sheet).toContainText('your question');
    await expect(sheet).toContainText('passage');
    await expect(sheet).toContainText('club notes you can already see');
    await expect(page.getByTestId('cal-input')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Not now' }).click();
    await expect(sheet).toHaveCount(0);
    expect(turns).toBe(0);

    await launcher.click();
    await sheet.getByRole('button', { name: 'Allow', exact: true }).click();
    await page.getByTestId('cal-input').fill('Tell me about the start of Alice.');
    await page.getByTestId('cal-send').click();
    await expect(page.getByTestId('cal-message-assistant').last()).toBeVisible();
    expect(turns).toBe(1);

    const settings = await ctx.newPage();
    await settings.goto('/settings');
    await settings.getByRole('button', { name: 'Turn off AI access' }).click();
    await expect(settings.getByText('AI access is off.', { exact: true })).toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('cal-input')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Not now' }).click();
    await page.reload();
    await launcher.click();
    await expect(sheet).toBeVisible();
    expect(turns).toBe(1);
  } finally {
    await ctx.close();
  }
});
