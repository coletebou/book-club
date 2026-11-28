import { devices, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';
import { useWebKitMicrophoneStandIn } from '../helpers/microphone';

test('club search opens results with the keyboard and omits fenced chat hits', async ({ browser, browserName }, testInfo) => {
  const { club, book } = await clubWithAlice(['Ben']);
  const visible = await club.owner.api.post(`/api/clubs/${club.id}/chat`, { data: { text: 'Alice was our pick yesterday' } });
  expect(visible.status()).toBe(201);
  const { id } = await visible.json() as { id: string };
  const hidden = await club.owner.api.post(`/api/clubs/${club.id}/chat`, { data: { bookId: book.id, text: 'Alice reveals the final twist', spoilerUpToT: 0.8 } });
  expect(hidden.status()).toBe(201);

  const context = await browserAs(browser, club.members.Ben!, browserName === 'webkit' ? devices['iPhone 15'] : {});
  try {
    const page = await context.newPage();
    if (browserName === 'webkit') await useWebKitMicrophoneStandIn(page);
    await page.goto(`/clubs/${club.id}`);
    const launcher = page.getByRole('button', { name: 'Search', exact: true });
    await expect(launcher).toBeVisible();
    await testInfo.attach('club library before opening search', { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('/');
    const input = page.getByRole('combobox', { name: 'Search this club' });
    await expect(input).toBeFocused();
    await input.fill('Alice');
    const options = page.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText('Book');
    await expect(options.nth(1)).toHaveText(/Alice was our pick yesterday/);
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog.getByRole('status').filter({ hasText: '2 results shown.' })).toHaveCount(1);
    const close = dialog.getByRole('button', { name: 'Close' });
    const dictate = dialog.getByRole('button', { name: 'Dictate' });
    await dictate.focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dictate).toBeFocused();
    await input.focus();
    await input.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowUp');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowDown');
    await testInfo.attach('club search with safe results', { body: await dialog.screenshot(), contentType: 'image/png' });
    await input.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/clubs/${club.id}/chat\\?message=${id}`));
    await expect(page.getByTestId('chat-message').filter({ hasText: 'Alice was our pick yesterday' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('club search transcribes a query and pauses the playing audiobook during microphone capture', async ({ browser, browserName }) => {
  const { club, book } = await clubWithAlice([], { audio: 'tiny' });
  const text = 'Tell me about chapter one.';
  const message = await club.owner.api.post(`/api/clubs/${club.id}/chat`, { data: { text } });
  expect(message.status()).toBe(201);
  const context = await browserAs(browser, club.owner, {
    ...(browserName === 'webkit' ? devices['iPhone 15'] : { permissions: ['microphone'] }),
    audioOnlyView: true,
  });
  try {
    const page = await context.newPage();
    if (browserName === 'webkit') await useWebKitMicrophoneStandIn(page);
    await page.goto(`/books/${book.id}/listen`);
    await page.getByTestId('play-pause').click();
    const paused = () => page.getByTestId('audio-element').evaluate((audio: HTMLAudioElement) => audio.paused);
    await expect.poll(paused).toBe(false);
    await page.getByRole('link', { name: `Back to ${book.title}` }).click();
    await expect.poll(paused).toBe(false);

    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const input = page.getByRole('combobox', { name: 'Search this club' });
    await input.fill('Tell me about chapter');
    const option = page.getByRole('option');
    await expect(option).toBeEnabled();
    const dictate = page.getByRole('button', { name: 'Dictate', exact: true });
    await dictate.click();
    const disclosure = page.getByRole('dialog', { name: 'Allow AI access for dictation?' });
    await expect(disclosure).toBeVisible();
    await expect.poll(paused).toBe(false);
    const enabled = page.waitForResponse(async (r) => r.url().endsWith('/cal/status') && r.ok() && (await r.json()).dictation === true);
    await disclosure.getByRole('button', { name: 'Allow', exact: true }).click();
    await enabled;
    await expect(disclosure).toHaveCount(0);
    await expect(input).toHaveValue('Tell me about chapter');
    await expect.poll(paused).toBe(false);
    await dictate.click();
    const finish = page.getByRole('button', { name: 'Finish dictation' });
    await expect(finish).toBeVisible();
    await expect(option).toBeDisabled();
    await expect.poll(paused).toBe(true);
    if (browserName === 'chromium') await page.waitForTimeout(600);
    await finish.click();

    await expect(input).toHaveValue(text);
    await expect(page.getByRole('option')).toHaveText(new RegExp(text));
    await expect.poll(paused).toBe(false);
  } finally {
    await context.close();
  }
});
