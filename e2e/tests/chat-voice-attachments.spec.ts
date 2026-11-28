import { type Page, devices, expect, test } from '@playwright/test';
import { type ChatMessageView } from '@bookclub/shared';
import { browserAs, clubWithAlice, makeClub, putProgress, readUpTo } from '../helpers/api';
import { stubRecorderScript } from '../helpers/voice';

const recorderButton = (page: Page) => page.getByRole('button', { name: 'Record a voice message' });
const reportCarPlay = (page: Page, connected: boolean) => page.evaluate((carPlayConnected) => {
  Object.assign(window, { BookClubNative: { carPlayConnected, postMessage() {} } });
  window.dispatchEvent(new Event('bookclub:carplay-connection'));
}, connected);

test('a reviewed voice clip sends with the chosen spoiler fence and plays after the friend reaches it', async ({ browser, browserName }, testInfo) => {
  const { club, book } = await clubWithAlice(['Ben']);
  const ben = club.members.Ben!;
  const epub = book.editions.find((e) => e.kind === 'epub')!;
  const geometry = epub.geometry;
  if (geometry?.kind !== 'epub') throw new Error('expected an epub edition');
  const mid = { kind: 'epub' as const, section: Math.max(1, Math.floor(geometry.sectionLengths.length / 2)), offset: 0 };
  await putProgress(club.owner, book.id, epub.id, mid, [{ from: { kind: 'epub', section: 0, offset: 0 }, to: mid }]);
  const device = browserName === 'webkit' ? devices['iPhone 15'] : { viewport: { width: 390, height: 844 } };
  const sender = await browserAs(browser, club.owner, { ...device, serviceWorkers: 'block', ...(browserName === 'chromium' ? { permissions: ['microphone'] } : {}) });
  const recipient = await browserAs(browser, ben, device);
  try {
    const selectBook = (page: Page) => page.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    const theirs = await recipient.newPage();
    const received: ChatMessageView[] = [];
    theirs.on('websocket', (socket) => {
      if (!socket.url().endsWith('/ws')) return;
      socket.on('framereceived', ({ payload }) => {
        const event = JSON.parse(payload.toString()) as { type: string; message?: ChatMessageView };
        if (event.type === 'chat:new' && event.message) received.push(event.message);
      });
    });
    await theirs.goto(`/clubs/${club.id}/chat`);
    await selectBook(theirs);
    await expect(theirs.getByText('No messages yet. Say hello.')).toBeVisible();

    const mine = await sender.newPage();
    await mine.route(/\/chat\/attachments\?kind=voice$/, (route) => route.fulfill({
      status: 503,
      json: { error: { code: 'voice_upload_busy', message: 'Try attaching this recording again shortly.' } },
    }), { times: 1 });
    if (browserName === 'webkit') await mine.addInitScript(stubRecorderScript());
    await mine.goto(`/clubs/${club.id}/chat`);
    await selectBook(mine);
    await mine.getByTestId('chat-spoiler-toggle').check();
    await recorderButton(mine).click();
    await expect(mine.getByTestId('voice-recorder')).toHaveAttribute('data-state', 'recording');
    if (browserName === 'chromium') await mine.waitForTimeout(600);
    await mine.getByTestId('voice-stop').click();
    const preview = mine.getByTestId('voice-preview-player');
    await expect(preview).toBeVisible();
    const recordedUrl = await preview.getAttribute('src');
    await expect(mine.getByTestId('chat-send')).toBeDisabled();
    await mine.getByTestId('voice-use').click();
    await expect(mine.getByText('Try attaching this recording again shortly.')).toBeVisible();
    await expect(preview).toHaveAttribute('src', recordedUrl!);
    await expect(mine.getByTestId('chat-send')).toBeDisabled();
    let finishUpload!: () => void;
    const uploadCanFinish = new Promise<void>((resolve) => { finishUpload = resolve; });
    await mine.route(/\/chat\/attachments\?kind=voice$/, async (route) => {
      await uploadCanFinish;
      await route.continue();
    }, { times: 1 });
    const uploadStarted = mine.waitForRequest(/\/chat\/attachments\?kind=voice$/);
    try {
      await mine.getByTestId('voice-use').click();
      await uploadStarted;
      await mine.getByRole('button', { name: 'General', exact: true }).click();
      await expect(mine.getByTestId('chat-attachment')).toHaveCount(0);
    } finally {
      finishUpload();
    }
    await selectBook(mine);
    await expect(mine.getByTestId('chat-attachment')).toHaveAttribute('data-status', 'ready');
    await mine.getByRole('button', { name: 'General', exact: true }).click();
    await expect(mine.getByTestId('chat-attachment')).toHaveCount(0);
    await selectBook(mine);
    await expect(mine.getByTestId('chat-attachment')).toHaveAttribute('data-status', 'ready');
    await expect(mine.getByTestId('chat-spoiler-toggle')).toBeChecked();
    await expect(mine.getByTestId('chat-message')).toHaveCount(0);
    const sent = mine.waitForResponse((res) => res.url().endsWith(`/api/clubs/${club.id}/chat`) && res.request().method() === 'POST');
    await mine.getByTestId('chat-send').click();
    const posted = await sent;
    expect(posted.status()).toBe(201);
    const body = await posted.json() as ChatMessageView;
    if (body.hidden || body.attachments[0]?.kind !== 'voice') throw new Error('expected a sent voice message');
    const url = body.attachments[0].url;
    await expect(mine.getByTestId('chat-voice-player')).toBeVisible();

    await expect.poll(() => received.find((m) => m.id === body.id)?.attachments).toEqual([{ kind: 'voice' }]);
    await expect(theirs.getByTestId('chat-spoiler-marker')).toContainText('Voice message');
    await expect(theirs.getByTestId('chat-voice-player')).toHaveCount(0);
    expect((await theirs.request.get(url, { headers: { Range: 'bytes=0-15' } })).status()).toBe(404);

    // Read through the fenced place. A range that ends at the start of a chapter is exclusive.
    await readUpTo(ben, book.id, epub.id, { ...mid, offset: 200 });
    expect((await theirs.request.get(url, { headers: { Range: 'bytes=0-15' } })).status()).toBe(206);
    await theirs.reload();
    await selectBook(theirs);
    const audio = theirs.getByTestId('chat-voice-player');
    await expect(audio).toHaveAttribute('src', url);
    await audio.evaluate((element: HTMLAudioElement) => element.play());
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime > 0 || element.ended)).toBe(true);
    await expect(theirs.getByTestId('chat-message-menu-btn')).toHaveAttribute('aria-expanded', 'false');
    await testInfo.attach('received voice message', { body: await theirs.getByTestId('chat-panel').screenshot(), contentType: 'image/png' });
  } finally {
    await sender.close();
    await recipient.close();
  }
});

test('CarPlay refuses chat capture and releases both a pending and an active microphone', async ({ browser, browserName }) => {
  const club = await makeClub([]);
  const context = await browserAs(browser, club.owner, browserName === 'webkit' ? devices['iPhone 15'] : { viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(stubRecorderScript());
    await page.goto(`/clubs/${club.id}/chat`);
    await page.evaluate(() => {
      const probe = { requested: 0, stopped: 0, release: () => {} };
      Object.assign(window, { chatVoiceProbe: probe });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: () => {
          probe.requested++;
          return new Promise((resolve) => {
            const track = { stop: () => { probe.stopped++; } };
            probe.release = () => resolve({ getTracks: () => [track] });
          });
        },
      } });
    });
    const counts = () => page.evaluate(() => {
      const { requested, stopped } = (window as unknown as { chatVoiceProbe: { requested: number; stopped: number } }).chatVoiceProbe;
      return [requested, stopped];
    });
    const release = () => page.evaluate(() => (window as unknown as { chatVoiceProbe: { release(): void } }).chatVoiceProbe.release());
    const input = page.getByTestId('chat-input');
    await input.fill('This stays editable');

    await reportCarPlay(page, true);
    await expect(recorderButton(page)).toHaveCount(0);
    expect(await counts()).toEqual([0, 0]);

    await reportCarPlay(page, false);
    await recorderButton(page).click();
    await expect(page.getByTestId('voice-recorder')).toHaveAttribute('data-state', 'starting');
    await reportCarPlay(page, true);
    await release();
    await expect.poll(counts).toEqual([1, 1]);
    await expect(page.getByTestId('voice-recorder')).toHaveCount(0);

    await reportCarPlay(page, false);
    await recorderButton(page).click();
    await expect(page.getByTestId('voice-recorder')).toHaveAttribute('data-state', 'starting');
    await release();
    await expect(page.getByTestId('voice-recorder')).toHaveAttribute('data-state', 'recording');
    await reportCarPlay(page, true);
    await expect.poll(counts).toEqual([2, 2]);
    await expect(page.getByTestId('voice-recorder')).toHaveCount(0);
    await expect(page.getByTestId('chat-attachment')).toHaveCount(0);
    await expect(input).toHaveValue('This stays editable');
  } finally {
    await context.close();
  }
});
