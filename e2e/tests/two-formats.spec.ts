import { type Page, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, readAlong } from '../helpers/api';

/*
 * One book, read or heard or both (D186, D187): the book page continues in the format you were in
 * and offers the other from the same place; opening the other format marks where you stopped;
 * Play in the book reads on from the page you are on; the paused player catches up with reading
 * done since; and reading along is one tap from the book page.
 */

const audioTime = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime);

async function listenThenPause(page: Page, bookId: string, at: number) {
  await page.goto(`/books/${bookId}/listen`);
  await page.getByTestId('scrubber').fill(String(at));
  await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(at - 1);
  await page.getByTestId('play-pause').click();
  await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
  await page.waitForTimeout(1200);
  await page.getByTestId('play-pause').click();
  await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false');
}

/** Read from chapter III: the contents, then "Read from here". */
async function readFromChapterThree(page: Page) {
  const reader = page.getByTestId('reader');
  const before = await reader.getAttribute('data-section');
  await page.getByTestId('open-toc').click();
  await page.getByRole('button', { name: /CHAPTER III\./ }).click();
  await expect(reader).not.toHaveAttribute('data-section', before ?? '');
  await page.getByTestId('read-from-here').click();
  await expect(page.getByTestId('look-chip')).toHaveCount(0);
}

test.describe('one book, read or heard or both', () => {
  test('the book page continues where you were and offers the other format from there; the book marks where you stopped listening; Play in the book reads on from your page', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listenThenPause(page, book.id, 100);

    // Back to the book page in the app (a reload would empty the player, which this is about).
    await page.getByRole('link', { name: /^Back to / }).click();
    await expect(page.getByTestId('open-audio')).toHaveText('Continue listening');
    await expect(page.getByTestId('open-audio')).toHaveClass(/btn-primary/);
    await expect(page.getByTestId('open-epub')).toHaveText('Read from Chapter 1');
    await page.getByTestId('open-epub').click();
    // Where you stopped listening, marked, and said so.
    await expect(page.getByTestId('landing-mark').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^Where you stopped listening: Chapter 1/)).toBeVisible();

    // Read on from chapter III, then Play in the book's footer: the audiobook plays from there,
    // not from chapter I where it stopped.
    await readFromChapterThree(page);
    await expect(page.getByTestId('landing-mark')).toHaveCount(0);
    await page.getByTestId('footer-play').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.src)).toMatch(/\/tracks\/2(\?|$)/);
    // The footer's skip back, past the track's first 15 s (before them it goes on into the track
    // before, as it should, and the time is that track's).
    await expect.poll(() => audioTime(page), { timeout: 30_000 }).toBeGreaterThan(16);
    const t = await audioTime(page);
    await page.getByTestId('footer-skip-back').click();
    await expect.poll(() => audioTime(page)).toBeLessThan(Math.max(0.5, t - 10));
    await ctx.close();
  });

  test('the paused player catches up with what you read since: Play goes on from there', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listenThenPause(page, book.id, 100);
    // The player keeps the audiobook while you read on in the book (in the app: a reload would
    // empty the player, which this is about).
    await page.getByRole('link', { name: /^Back to / }).click();
    await page.getByTestId('open-epub').click();
    await readFromChapterThree(page);
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await page.waitForTimeout(1000);
    await page.getByRole('link', { name: /^Back to / }).click();
    // Listening again (over the text, D197): from where you read on to, not where it stopped.
    await expect(page.getByTestId('open-audio')).toHaveText('Listen from Chapter 3');
    await page.getByTestId('open-audio').click();
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? ''), { timeout: 15_000 }).toMatch(/\/tracks\/2(\?|$)/);
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await ctx.close();
  });

  test('listening is one tap from the book page: that tap starts the audiobook at your page, over the text, and the pages follow it (D194, D197)', async ({ browser }) => {
    const { club, book: uploaded } = await clubWithAlice([], { audio: 'librivox' });
    const audio = uploaded.editions.find((e) => e.kind === 'audio')!;
    await readAlong(club.owner, uploaded, audio.id);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${uploaded.id}`);
    await page.getByTestId('open-audio').click();
    await expect(page).toHaveURL(/\/read\?edition=/);
    await expect(page).not.toHaveURL(/along=/);
    // Playing, with no second tap (D187 asked for one, on Play below), and no prompt to tap.
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await expect(page.getByTestId('along-start')).toHaveCount(0);
    await expect(page.locator('.reader-dock')).toBeVisible();
    // The narrator is followed: before the text (LibriVox's opening) or reading a sentence.
    const reader = page.getByTestId('reader');
    await expect.poll(async () => (await page.getByTestId('narration-before').count()) > 0 || (await reader.getAttribute('data-narrated')) !== '', { timeout: 20_000 }).toBe(true);
    await ctx.close();
  });
});
