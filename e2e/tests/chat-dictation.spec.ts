import { devices, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, makeClub } from '../helpers/api';
import { useWebKitMicrophoneStandIn } from '../helpers/microphone';

test('chat dictation adds editable words to the draft and only sends after confirmation', async ({ browser, browserName }, testInfo) => {
  const club = await makeClub(['Ana']);
  const context = await browserAs(browser, club.members.Ana!, browserName === 'webkit' ? devices['iPhone 15'] : {
    viewport: { width: 390, height: 844 },
    permissions: ['microphone'],
  });
  let allowUpload!: () => void;
  const upload = new Promise<void>((resolve) => { allowUpload = resolve; });
  try {
    const page = await context.newPage();
    await page.route('**/dictation', async (route) => {
      await upload;
      await route.continue();
    });
    if (browserName === 'webkit') await useWebKitMicrophoneStandIn(page);
    await page.goto(`/clubs/${club.id}/chat`);
    const input = page.getByTestId('chat-input');
    await input.fill('I have a question:');
    await page.getByRole('button', { name: 'Dictate' }).click();
    const finish = page.getByRole('button', { name: 'Finish dictation' });
    await expect(finish).toBeVisible();
    // A real MediaRecorder needs a short clip to produce its first audio packets.
    if (browserName === 'chromium') await page.waitForTimeout(600);
    await finish.click();
    await expect(page.getByRole('button', { name: 'Cancel transcription' })).toBeVisible();
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await input.press('Enter');
    await expect(input).toHaveValue('I have a question:');
    await expect(page.getByTestId('chat-message')).toHaveCount(0);
    allowUpload();

    await expect(input).toHaveValue('I have a question: Tell me about chapter one.');
    await expect(page.getByTestId('chat-message')).toHaveCount(0);
    await testInfo.attach('chat dictated draft', { body: await page.getByTestId('chat-composer').screenshot(), contentType: 'image/png' });
    await input.fill('Can we talk about chapter one?');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-message')).toContainText('Can we talk about chapter one?');
  } finally {
    allowUpload();
    await context.close();
  }
});


test('chat dictation pauses a playing audiobook until the microphone closes', async ({ browser, browserName }) => {
  const { club, book } = await clubWithAlice([], { audio: 'tiny' });
  const context = await browserAs(browser, club.owner, {
    ...(browserName === 'webkit' ? devices['iPhone 15'] : { permissions: ['microphone'] }),
    audioOnlyView: true,
  });
  try {
    const page = await context.newPage();
    if (browserName === 'webkit') await useWebKitMicrophoneStandIn(page);
    await page.goto(`/books/${book.id}/listen`);
    const play = page.getByTestId('play-pause');
    await play.click();
    const paused = () => page.getByTestId('audio-element').evaluate((audio: HTMLAudioElement) => audio.paused);
    await expect.poll(paused).toBe(false);

    await page.getByTestId('open-chat-sheet').click();
    await expect.poll(paused).toBe(false);
    await page.getByRole('button', { name: 'Dictate' }).click();
    const finish = page.getByRole('button', { name: 'Finish dictation' });
    await expect(finish).toBeVisible();
    await expect.poll(paused).toBe(true);
    if (browserName === 'chromium') await page.waitForTimeout(600);
    await finish.click();
    await expect(page.getByTestId('chat-input')).toHaveValue('Tell me about chapter one.');
    await expect.poll(paused).toBe(false);
  } finally {
    await context.close();
  }
});
