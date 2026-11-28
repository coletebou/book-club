import { devices, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';
import { useWebKitMicrophoneStandIn } from '../helpers/microphone';

test('Cal dictation drafts a written question without starting a conversation', async ({ browser, browserName }, testInfo) => {
  const { club, book } = await clubWithAlice([], { audio: 'tiny' });
  const context = await browserAs(browser, club.owner, {
    ...(browserName === 'webkit' ? devices['iPhone 15'] : {
      viewport: { width: 390, height: 844 },
      permissions: ['microphone'],
    }),
    audioOnlyView: true,
    // Hold these network requests directly. A service worker can satisfy the list before interception.
    serviceWorkers: 'block',
  });
  let finishSelection!: () => void;
  const selecting = new Promise<void>((resolve) => { finishSelection = resolve; });
  let finishFirstTalk!: () => void;
  const firstTalk = new Promise<void>((resolve) => { finishFirstTalk = resolve; });
  let rejectNextStart = true;
  try {
    const page = await context.newPage();
    await page.route('**/cal/conversations', async (route) => {
      if (route.request().method() === 'GET') await selecting;
      if (route.request().method() === 'POST' && rejectNextStart) {
        rejectNextStart = false;
        await firstTalk;
        await route.abort();
        return;
      }
      await route.continue();
    });
    if (browserName === 'webkit') await useWebKitMicrophoneStandIn(page);
    await page.goto(`/books/${book.id}/listen`);
    await page.getByTestId('play-pause').click();
    const paused = () => page.getByTestId('audio-element').evaluate((audio: HTMLAudioElement) => audio.paused);
    await expect.poll(paused).toBe(false);
    // The full player's Ask Cal now starts hands-free. The book page opens the typed composer
    // while the same audiobook continues in the mini-player.
    await page.getByRole('link', { name: `Back to ${book.title}` }).click();
    await expect.poll(paused).toBe(false);
    await page.getByRole('button', { name: 'Ask Cal' }).click();
    const input = page.getByTestId('cal-input');
    await input.fill('For the club:');
    const dictate = page.getByRole('button', { name: 'Dictate' });
    await expect(dictate).toBeDisabled();
    finishSelection();
    await expect(dictate).toBeEnabled();

    await page.getByRole('button', { name: 'Talk to Cal', exact: true }).click();
    await expect(dictate).toBeDisabled();
    finishFirstTalk();

    await dictate.click();
    const finish = page.getByRole('button', { name: 'Finish dictation' });
    await expect(finish).toBeVisible();
    await expect(page.getByRole('button', { name: 'Your chats with Cal' })).toBeDisabled();
    await expect.poll(paused).toBe(true);
    if (browserName === 'chromium') await page.waitForTimeout(600);
    await finish.click();

    await expect(input).toHaveValue('For the club: Tell me about chapter one.');
    await expect.poll(() => input.evaluate((field: HTMLTextAreaElement) => field.scrollHeight <= field.clientHeight + 1)).toBe(true);
    await expect.poll(paused).toBe(false);
    await expect(page.getByTestId('cal-thread-current')).toHaveText('New chat');
    const conversations = await club.owner.api.get(`/api/clubs/${club.id}/cal/conversations`);
    expect(conversations.ok()).toBe(true);
    expect(await conversations.json()).toEqual([]);
    await testInfo.attach('Cal dictated draft', { body: await page.locator('.cal-input').screenshot(), contentType: 'image/png' });

    const question = 'What books are in our club?';
    await input.fill(question);
    await page.getByTestId('cal-send').click();
    await expect(page.getByTestId('cal-thread-current')).toHaveText(question);
  } finally {
    finishSelection();
    finishFirstTalk();
    await context.close();
  }
});
