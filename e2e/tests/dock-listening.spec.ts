import { expect, test } from '@playwright/test';
import type { AudioLocator, CommentView } from '@bookclub/shared';
import { allowCal, browserAs, clubWithAlice, serverPlace } from '../helpers/api';
import { stubRecorderScript } from '../helpers/voice';

test('the reader dock opens book-scoped Cal and pins reactions and notes to the audiobook', async ({ browser }, info) => {
  const { club, book } = await clubWithAlice([], { audio: 'tiny' });
  await allowCal(club.owner);
  const edition = book.editions.find((e) => e.kind === 'audio')!;
  const viewport = info.project.name === 'webkit-iphone' ? {} : { viewport: { width: 393, height: 659 } };
  // Hold a real progress request regardless of which browser would register the service worker.
  const ctx = await browserAs(browser, club.owner, { ...viewport, serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    // Keep this check on the typed flow when capture is unavailable. cal-voice.spec covers
    // hands-free launch after the same confirmed place save.
    await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { value: undefined }));
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.getByTestId('listen-here').click();
    const dock = page.getByRole('group', { name: /^Now playing:/ });
    await expect(dock.getByTestId('footer-play')).toHaveAttribute('data-playing', 'true');
    await dock.getByTestId('footer-play').click();
    await expect(dock.getByTestId('footer-play')).toHaveAttribute('data-playing', 'false');
    const progressUrl = `**/api/books/${book.id}/progress`;
    let finishSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => { finishSave = resolve; });
    await page.route(progressUrl, async (route) => {
      const request = route.request();
      if (request.method() === 'PUT') await saveHeld;
      await route.continue();
    });
    await dock.getByTestId('dock-scrubber').fill('1');
    const position = () => page.getByTestId('audio-element').evaluate((audio: HTMLAudioElement) => Math.round(audio.currentTime * 1_000));
    await expect.poll(position).toBe(1_000);

    const ask = dock.getByRole('button', { name: /^Ask Cal(?: by voice)? about the audiobook$/ });
    await ask.focus();
    await page.keyboard.press('Enter');
    const cal = page.getByRole('dialog', { name: 'Ask Cal' });
    await expect(ask).toHaveAttribute('aria-disabled', 'true');
    await expect(cal).toHaveCount(0);
    expect(await serverPlace(page, book.id)).not.toEqual({ kind: 'audio', track: 0, ms: 1_000 });
    finishSave();
    await expect(cal).toBeVisible();
    const saved = { kind: 'audio', track: 0, ms: 1_000 };
    expect(await serverPlace(page, book.id)).toEqual(saved);
    await cal.getByTestId('cal-input').fill('What has happened so far?');
    const thread = page.waitForResponse((response) => /\/api\/clubs\/[^/]+\/cal\/conversations$/.test(response.url()) && response.request().method() === 'POST');
    await cal.getByTestId('cal-send').click();
    expect((await thread).request().postDataJSON()).toEqual({ bookId: book.id });
    await expect(cal.getByTestId('cal-message-assistant')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(ask).toBeFocused();
    await page.unroute(progressUrl);

    await page.route(progressUrl, async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 503, json: { error: 'unavailable' } });
      } else {
        await route.continue();
      }
    });
    await page.keyboard.press('Enter');
    await expect(page.getByText('Could not sync your listening position. Try again.')).toBeVisible();
    await expect(cal).toHaveCount(0);
    await page.unroute(progressUrl);

    await dock.getByTestId('dock-expand').click();
    const sheet = page.getByRole('dialog', { name: 'Now in this book' });
    await expect(sheet.getByRole('button', { name: /^Ask Cal(?: by voice)?$/ })).toBeVisible();
    const reactions = sheet.getByRole('group', { name: 'React at this moment' });
    await expect(reactions.getByRole('button')).toHaveCount(6);
    await reactions.getByRole('button', { name: 'Love at this moment' }).focus();
    await page.keyboard.press('Enter');
    const noteButton = sheet.getByRole('button', { name: 'Note here' });
    await noteButton.focus();
    await page.keyboard.press('Enter');
    const composer = page.getByRole('dialog', { name: 'Leave a note' });
    await expect(composer.getByTestId('note-text')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(noteButton).toBeFocused();
    await noteButton.click();
    await composer.getByTestId('note-text').fill('At the narrator’s place');
    await composer.getByTestId('note-submit').click();
    await expect(composer).toHaveCount(0);
    await expect(sheet).toBeVisible();

    const response = await club.owner.api.get(`/api/books/${book.id}/comments`);
    expect(response.ok()).toBe(true);
    const comments = await response.json() as CommentView[];
    expect(comments).toHaveLength(2);
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ editionId: edition.id, locator: saved, reaction: '❤️' }),
      expect.objectContaining({ editionId: edition.id, locator: saved, text: 'At the narrator’s place' }),
    ]));
  } finally {
    await ctx.close();
  }
});

test('a voice note starts recording in one tap from the reader’s Now Playing sheet', async ({ browser, browserName }) => {
  // Give the test time to open Now Playing before the track can end.
  const { club, book } = await clubWithAlice([], { audio: 'librivox' });
  const edition = book.editions.find((e) => e.kind === 'audio')!;
  const ctx = await browserAs(browser, club.owner, browserName === 'chromium' ? { permissions: ['microphone'] } : {});
  try {
    if (browserName === 'webkit') await ctx.addInitScript(stubRecorderScript());
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.getByTestId('listen-here').click();
    await page.getByTestId('dock-expand').click();
    const sheet = page.getByRole('dialog', { name: 'Now in this book' });
    await expect(sheet.getByTestId('sheet-play')).toHaveAttribute('data-playing', 'true');
    const record = sheet.getByRole('button', { name: 'Record voice note' });
    await record.click();
    const note = page.getByRole('dialog', { name: 'Leave a note' });
    await expect(note.getByTestId('voice-recorder')).toHaveAttribute('data-state', 'recording');
    await expect(sheet.getByTestId('sheet-play')).toHaveAttribute('data-playing', 'false');
    const pausedAt = await page.getByTestId('audio-element').evaluate((audio: HTMLAudioElement) => audio.currentTime * 1_000);
    // Let the fake microphone produce audio before stopping it, as with voice notes from the page.
    await expect(note.getByTestId('voice-elapsed')).toContainText(/^0:01/);
    await note.getByTestId('voice-stop').click();
    await expect(note.getByTestId('voice-preview-player')).toBeVisible();
    await note.getByTestId('voice-use').click();
    await expect(note.getByTestId('media-attachment')).toHaveAttribute('data-status', 'ready', { timeout: 15_000 });
    await expect(sheet.getByTestId('sheet-play')).toHaveAttribute('data-playing', 'true');
    const post = page.waitForResponse((response) => response.url().endsWith(`/api/books/${book.id}/comments`) && response.request().method() === 'POST');
    await note.getByTestId('note-submit').click();
    const comment = await (await post).json() as CommentView;
    expect(comment).toMatchObject({ editionId: edition.id, locator: { kind: 'audio', track: 0 }, media: [{ kind: 'voice' }] });
    expect(Math.abs((comment.locator as AudioLocator).ms - pausedAt)).toBeLessThan(500);
    await expect(note).toHaveCount(0);
    await expect(record).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(note.getByTestId('voice-recorder')).toHaveAttribute('data-state', 'recording');
  } finally {
    await ctx.close();
  }
});

test('one Play tap reads the open page after a deadline elapsed while paused', async ({ browser }) => {
  const { club, book } = await clubWithAlice([], { audio: 'librivox' });
  const ctx = await browserAs(browser, club.owner);
  try {
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.getByTestId('listen-here').click();
    await page.getByTestId('dock-expand').click();
    const sheet = page.getByRole('dialog', { name: 'Now in this book' });
    const play = sheet.getByTestId('sheet-play');
    const timer = sheet.getByTestId('sheet-sleep');
    const audio = page.getByTestId('audio-element');
    await expect(audio).toHaveAttribute('src', /\/tracks\/0$/);
    await expect(play).toHaveAttribute('data-playing', 'true');
    await timer.selectOption('15');
    await expect(timer).toHaveValue('on');
    await play.click();
    await expect(play).toHaveAccessibleName('Play');
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    const reader = page.getByTestId('reader');
    const previousSection = await reader.getAttribute('data-section');
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /pool of tears/i }).click();
    await expect(reader).not.toHaveAttribute('data-section', previousSection ?? '');
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '1');
    await page.getByTestId('read-from-here').click();
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await expect(audio).toHaveAttribute('src', /\/tracks\/0$/);
    await page.evaluate(() => {
      const now = Date.now.bind(Date);
      Date.now = () => now() + 16 * 60_000;
    });
    const footerPlay = page.getByTestId('footer-play');
    await footerPlay.click();
    await expect(audio).toHaveAttribute('src', /\/tracks\/1$/);
    const position = () => audio.evaluate((element: HTMLAudioElement) => element.currentTime);
    const start = await position();
    await expect.poll(position).toBeGreaterThan(start + 1);
    await expect(footerPlay).toHaveAccessibleName('Pause the audiobook');
    await page.getByTestId('dock-expand').click();
    await expect(timer).toHaveValue('off');
  } finally {
    await ctx.close();
    await club.owner.api.dispose();
  }
});

for (const seekWhileHeld of [false, true]) {
  test(`the reader stays paused when a recording closes after sleep expiry ${seekWhileHeld ? 'with' : 'without'} a seek`, async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    try {
      await ctx.addInitScript(stubRecorderScript());
      const page = await ctx.newPage();
      await page.goto(`/books/${book.id}/read`);
      await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
      await page.getByTestId('listen-here').click();
      await page.getByTestId('dock-expand').click();
      const sheet = page.getByRole('dialog', { name: 'Now in this book' });
      const play = sheet.getByTestId('sheet-play');
      const timer = sheet.getByTestId('sheet-sleep');
      await expect(play).toHaveAttribute('data-playing', 'true');
      await timer.selectOption('15');
      await expect(timer).toHaveValue('on');
      await sheet.getByRole('button', { name: 'Record voice note' }).click();
      const note = page.getByRole('dialog', { name: 'Leave a note' });
      await expect(note.getByTestId('voice-recorder')).toHaveAttribute('data-state', 'recording');
      await expect(play).toHaveAttribute('data-playing', 'false');
      const audio = page.getByTestId('audio-element');
      await audio.evaluate((element: HTMLAudioElement, seekWhileHeld) => {
        const now = Date.now.bind(Date);
        Date.now = () => now() + 16 * 60_000;
        element.dataset.resumed = 'no';
        element.addEventListener('play', () => { element.dataset.resumed = 'yes'; });
        if (seekWhileHeld) element.currentTime += 2;
      }, seekWhileHeld);
      if (seekWhileHeld) await expect(timer).toHaveValue('off');
      await note.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(note).toHaveCount(0);
      await expect(timer).toHaveValue('off');
      await expect(play).toHaveAccessibleName('Play');
      await expect(audio).toHaveAttribute('data-resumed', 'no');
      expect(await audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    } finally {
      await ctx.close();
      await club.owner.api.dispose();
    }
  });
}
