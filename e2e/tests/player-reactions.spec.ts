import { expect, test } from '@playwright/test';
import type { CommentView } from '@bookclub/shared';
import { browserAs, clubWithAlice, postComment, putProgress } from '../helpers/api';

test('a reader reaction can be retried and only animates once the server accepts it', async ({ browser }) => {
  const { club, book } = await clubWithAlice([], { audio: 'librivox' });
  const ctx = await browserAs(browser, club.owner, { serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const animate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')?.value as Element['animate'] | undefined;
      if (!animate) return;
      Element.prototype.animate = function (keyframes, options) {
        if (this instanceof HTMLButtonElement && this.classList.contains('reaction-btn')) this.dataset.animated = 'true';
        return animate.call(this, keyframes, options);
      };
    });
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('listen-here').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('data-playing', 'true');
    await page.getByTestId('footer-play').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('data-playing', 'false');
    await page.getByTestId('dock-expand').click();
    const sheet = page.getByRole('dialog', { name: 'Now in this book' });
    const love = sheet.getByRole('button', { name: 'Love at this moment' });
    const comments = `**/api/books/${book.id}/comments`;
    let failing = true;
    await page.route(comments, (route) => failing && route.request().method() === 'POST'
      ? route.fulfill({ status: 400, json: { error: { code: 'bad_request', message: 'Could not save the reaction.' } } })
      : route.continue());
    await love.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Could not save the reaction.')).toBeVisible();
    await expect(love).not.toHaveAttribute('data-animated', 'true');

    failing = false;
    await page.keyboard.press('Enter');
    await expect(page.getByText(/❤️ pinned at/)).toBeVisible();
    await expect(love).toHaveAttribute('data-animated', 'true');
    await expect(love).toBeFocused();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const laugh = sheet.getByRole('button', { name: 'Laughing at this moment' });
    await laugh.click();
    await expect(page.getByText(/😂 pinned at/)).toBeVisible();
    await expect(laugh).not.toHaveAttribute('data-animated', 'true');

    await page.evaluate(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined }); });
    const accepted = page.waitForResponse((response) => response.url().endsWith(`/api/books/${book.id}/comments`) && response.request().method() === 'POST');
    const angry = sheet.getByRole('button', { name: 'Angry at this moment' });
    await angry.click();
    expect((await accepted).ok()).toBe(true);
    await expect(page.getByText(/😡 pinned at/)).toBeVisible();
    await expect(angry).not.toHaveAttribute('data-animated', 'true');
  } finally {
    await ctx.close();
  }
});

test('friends’ reactions appear on a heard passage and stay quiet after a seek', async ({ browser }) => {
  const { club, book } = await clubWithAlice(['Ana'], { audio: 'librivox' });
  const friend = club.members.Ana!;
  const edition = book.editions.find((entry) => entry.kind === 'audio')!;
  const at = (ms: number) => ({ kind: 'audio' as const, track: 0, ms });
  await putProgress(friend, book.id, edition.id, at(100_000), [{ from: at(0), to: at(100_000) }]);
  await putProgress(club.owner, book.id, edition.id, at(0), [{ from: at(5_000), to: at(7_000) }]);
  const early = await postComment(friend, book.id, { editionId: edition.id, locator: at(3_000), reaction: '❤️' });
  const skipped = await postComment(friend, book.id, { editionId: edition.id, locator: at(6_000), reaction: '😂' });
  const withheld = await postComment(friend, book.id, { editionId: edition.id, locator: at(80_000), reaction: '🤯', text: 'The part Ana read ahead.' });
  const comments = async () => (await (await club.owner.api.get(`/api/books/${book.id}/comments`)).json()) as CommentView[];
  const before = await comments();
  expect(before.find((entry) => entry.id === early.id)?.hidden).toBe(true);
  expect(before.find((entry) => entry.id === skipped.id)?.hidden).toBe(false);
  expect(before.find((entry) => entry.id === withheld.id)?.hidden).toBe(true);

  const ctx = await browserAs(browser, club.owner);
  try {
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('listen-here').click();
    const audio = page.getByTestId('audio-element');
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(3.2);
    await page.getByTestId('footer-play').click();
    await expect.poll(async () => (await comments()).find((entry) => entry.id === early.id)?.hidden).toBe(false);
    await expect(page.getByText('Ana reacted ❤️')).toBeVisible();

    const play = page.getByTestId('footer-play');
    await play.click();
    await expect(play).toHaveAttribute('data-playing', 'true');
    await audio.evaluate((el: HTMLAudioElement) => { el.currentTime = 70; });
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThanOrEqual(70);
    await audio.evaluate((el: HTMLAudioElement) => { el.currentTime = 90; });
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThanOrEqual(90);
    await expect(page.getByText('Ana reacted 😂')).toHaveCount(0);
    await expect(page.getByText('Ana reacted 🤯')).toHaveCount(0);
    await expect(page.getByText('The part Ana read ahead.')).toHaveCount(0);
  } finally {
    await ctx.close();
  }

  await putProgress(club.owner, book.id, edition.id, at(0), [{ from: at(3_300), to: at(4_500) }]);
  const noteWithReaction = await friend.api.post(`/api/books/${book.id}/comments`, { data: {
    editionId: edition.id, locator: at(3_500), reaction: '😢', text: 'This sentence made me pause.', aboutHere: true,
  } });
  expect(noteWithReaction.status()).toBe(201);
  const fullContext = await browserAs(browser, club.owner, { audioOnlyView: true });
  try {
    const page = await fullContext.newPage();
    await page.goto(`/books/${book.id}/listen?edition=${edition.id}`);
    const audio = page.getByTestId('audio-element');
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(10);
    await audio.evaluate((el: HTMLAudioElement) => { el.currentTime = 1; });
    await page.getByTestId('play-pause').click();
    await expect(page.getByText('Ana reacted ❤️')).toBeVisible();
    await expect(page.getByTestId('note-cue')).toContainText('Ana left a note here');
    await expect(page.getByText('Ana reacted 😢')).toHaveCount(0);
  } finally {
    await fullContext.close();
  }
});
