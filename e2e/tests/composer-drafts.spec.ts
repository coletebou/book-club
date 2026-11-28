import { type Page, devices, expect, test } from '@playwright/test';
import type { ChatMessageView } from '@bookclub/shared';
import { browserAs, clubWithAlice } from '../helpers/api';

const phone = (browserName: string) => browserName === 'webkit' ? devices['iPhone 15'] : { viewport: { width: 390, height: 844 } };

async function openCal(page: Page) {
  await page.getByTestId('cal-launcher').click();
  await expect(page.getByTestId('cal-new-chat')).toBeEnabled();
}

async function holdChatPost(page: Page, path: string) {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === 'POST') await wait;
    await route.continue();
  });
  const requested = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === path);
  return { release, requested };
}

test('chat restores each channel and thread draft and clears text once sent', async ({ browser, browserName }, testInfo) => {
  const { club, book } = await clubWithAlice(['Ben']);
  const base = `/api/clubs/${club.id}/chat`;
  const root = await club.owner.api.post(base, { data: { text: 'Where do we stop reading?' } });
  expect(root.ok()).toBe(true);
  const { id } = (await root.json()) as ChatMessageView;
  expect((await club.members.Ben!.api.post(base, { data: { text: 'At the end of chapter one.', parentId: id } })).ok()).toBe(true);

  const context = await browserAs(browser, club.owner, { ...phone(browserName), serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(`/clubs/${club.id}/chat`);
    const input = page.getByTestId('chat-input');
    const general = page.getByRole('button', { name: 'General', exact: true });
    const bookChannel = page.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`);
    const thread = page.getByTestId('chat-message').filter({ hasText: 'Where do we stop reading?' }).getByTestId('chat-replies');
    const generalText = 'I will bring tea to the next meeting.';
    const bookText = 'My notes on the White Rabbit.\nFinish this thought tomorrow.';
    const threadText = 'Chapter one works for me.';

    await input.fill(generalText);
    await page.reload();
    await expect(input).toHaveValue(generalText);
    await testInfo.attach('Restored General chat draft', { body: await page.getByTestId('chat-composer').screenshot(), contentType: 'image/png' });
    await bookChannel.click();
    await expect(input).toHaveValue('');
    await input.fill(bookText);
    await general.click();
    await expect(input).toHaveValue(generalText);
    await thread.click();
    await expect(input).toHaveValue('');
    await input.fill(threadText);

    await page.reload();
    await expect(input).toHaveValue(generalText);
    await thread.click();
    await expect(input).toHaveValue(threadText);
    const sent = await holdChatPost(page, base);
    try {
      await Promise.all([sent.requested, page.getByTestId('chat-send').click()]);
      await page.getByTestId('chat-thread-close').click();
      await bookChannel.click();
      await expect(input).toHaveValue(bookText);
    } finally {
      sent.release();
    }
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    await expect(input).toHaveValue(bookText);
    await general.click();
    await thread.click();
    await expect(page.getByTestId('chat-thread')).toContainText(threadText);
    await expect(input).toHaveValue('');
    await page.reload();
    await expect(input).toHaveValue(generalText);
    await thread.click();
    await expect(input).toHaveValue('');
    await page.getByTestId('chat-thread-close').click();
    await bookChannel.click();
    await expect(input).toHaveValue(bookText);

    // Keep the stored drafts through the fixture's account switch. A real sign-out would
    // wipe them, which would hide a missing account component in the draft keys.
    const savedDrafts = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('bookclub:draft:')).sort());
    const oldDrafts = await savedDrafts();
    expect(oldDrafts.map(([, text]) => text)).toEqual(expect.arrayContaining([generalText, bookText]));
    const ben = club.members.Ben!;
    await context.clearCookies();
    await context.addCookies((await ben.api.storageState()).cookies);
    await page.evaluate((userId) => localStorage.setItem('bookclub:last-user', userId), ben.id);
    await page.reload();
    await expect(thread).toBeVisible();
    await expect(input).toHaveValue('');
    await bookChannel.click();
    await expect(input).toHaveValue('');
    expect(await savedDrafts()).toEqual(oldDrafts);
  } finally {
    await context.close();
  }
});

test('reopening the reader chat sheet during a post cannot send the same draft again', async ({ browser, browserName }) => {
  const { club, book } = await clubWithAlice([]);
  const context = await browserAs(browser, club.owner, { ...phone(browserName), serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(`/books/${book.id}/read`);
    const open = page.getByTestId('open-chat-sheet');
    const input = page.getByTestId('chat-input');
    const send = page.getByTestId('chat-send');
    const text = 'Let’s meet at the library.';
    await open.click();
    await input.fill(text);
    const sent = await holdChatPost(page, `/api/clubs/${club.id}/chat`);
    try {
      await Promise.all([sent.requested, send.click()]);
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await open.click();
      await expect(input).toHaveValue(text);
      await expect(send).toBeDisabled();
    } finally {
      sent.release();
    }
    await expect(page.getByTestId('chat-message').filter({ hasText: text })).toHaveCount(1);
    await expect(input).toHaveValue('');
  } finally {
    await context.close();
  }
});

test('Cal recovers new questions by book and keeps existing conversation drafts separate', async ({ browser, browserName }, testInfo) => {
  const { club, book } = await clubWithAlice([]);
  const context = await browserAs(browser, club.owner, phone(browserName));
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      // Expose capture on Linux WebKit as well, but deny permission before any audio is read.
      window.MediaRecorder ??= class {} as unknown as typeof MediaRecorder;
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: async () => { throw new DOMException('The microphone was denied.', 'NotAllowedError'); } },
      });
    });
    await page.goto(`/books/${book.id}`);
    await openCal(page);
    const input = page.getByTestId('cal-input');
    const existingQuestion = 'What is the title of the first chapter?';
    const followUp = 'Tell me more about its opening.';
    const unsentQuestion = 'How does the book introduce the White Rabbit?';
    const thread = page.getByTestId('cal-thread-current');
    const existingThread = page.getByTestId('cal-thread').filter({ hasText: existingQuestion });
    const threadList = page.getByTestId('cal-threads-open');
    const newChat = page.getByTestId('cal-new-chat');
    const send = page.getByTestId('cal-send');

    await input.fill(existingQuestion);
    await send.click();
    await expect(thread).toHaveText(existingQuestion);
    await input.fill(followUp);
    await newChat.click();
    await expect(input).toHaveValue('');
    await input.fill(unsentQuestion);
    await page.getByRole('button', { name: 'Talk to Cal', exact: true }).click();
    await expect(page.getByText('Could not use the microphone.', { exact: true })).toBeVisible();
    await page.reload();
    await openCal(page);
    await expect(thread).toHaveText('New chat');
    await expect(input).toHaveValue(unsentQuestion);
    await testInfo.attach('Restored new Cal question', { body: await page.locator('.cal-input').screenshot(), contentType: 'image/png' });
    await expect(page.getByTestId('cal-message-user')).toHaveCount(0);
    await threadList.click();
    await existingThread.click();
    await expect(input).toHaveValue(followUp);
    await send.click();
    await expect(page.getByTestId('cal-message-user').last()).toHaveText(followUp);
    await expect(newChat).toBeEnabled();
    await page.reload();
    await openCal(page);
    await expect(input).toHaveValue(unsentQuestion);
    await threadList.click();
    await existingThread.click();
    await expect(input).toHaveValue('');

    await page.goto(`/clubs/${club.id}/chat`);
    await openCal(page);
    await newChat.click();
    await expect(input).toHaveValue('');
  } finally {
    await context.close();
  }
});
