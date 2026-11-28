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

test('a failed Cal download leaves the library usable and can recover after reopening', async ({ browser }) => {
  const { club } = await clubWithAlice([]);
  const ctx = await browserAs(browser, club.owner, { serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    const dialogs = '**/assets/CalDialogs-*.js';
    let requests = 0;
    await page.route(dialogs, async (route) => {
      requests += 1;
      await route.fulfill({ status: 503 });
    });
    await page.goto(`/clubs/${club.id}`);
    const book = page.getByTestId('book-card').first();
    await expect(book).toBeVisible();
    expect(requests).toBe(0);

    const launcher = page.getByTestId('cal-launcher');
    await launcher.click();
    const error = page.getByRole('dialog', { name: 'Ask Cal' });
    await expect(error.getByRole('alert')).toHaveText('Cal failed to load. Close and reopen Book Club to try again.');
    expect(requests).toBeGreaterThan(0);
    await expect(page.getByTestId('cal-input')).toHaveCount(0);
    await error.getByRole('button', { name: 'Close' }).click();
    await book.getByRole('link').first().click();
    await expect(page.locator('#book-title')).toBeVisible();

    const bookUrl = page.url();
    await page.close();
    const reopened = await ctx.newPage();
    await reopened.goto(bookUrl);
    await reopened.getByTestId('cal-launcher').click();
    await expect(reopened.getByRole('dialog', { name: 'Allow Cal to use AI?' })).toBeVisible();
    await expect(reopened.getByTestId('cal-input')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
