import { type Page, expect, test } from '@playwright/test';
import type { BookDetail } from '@bookclub/shared';
import { browserAs, clubWithAlice, readAlong } from '../helpers/api';
import { continueButton, listenFromThisPage, openBookSettings, openFromBookPage } from '../helpers/open';

/*
 * One book, read or heard or both (D186, D187; one way in, D198): the book page's one Continue goes
 * on in the text you were in, the audiobook along in the same tap if you were listening and have
 * not hidden it; opening the text from where you listened marks where you stopped; Play in the book
 * reads on from the page you are on; the paused audiobook catches up with reading done since.
 */

const audioTime = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime);

/** Listen a while from `at` seconds into the first track, over the text (D197, D198), then pause. */
async function listenThenPause(page: Page, book: Pick<BookDetail, 'id' | 'editions'>, at: number) {
  await openFromBookPage(page, book, { label: 'Open', kind: 'epub', along: false });
  await listenFromThisPage(page);
  await page.getByTestId('dock-scrubber').fill(String(at));
  await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(at - 1);
  await page.waitForTimeout(1200);
  await page.getByTestId('footer-play').click();
  await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Play the audiobook');
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
  test('the book page’s one Continue goes on where you were, the audiobook along after listening; the book marks where you stopped listening; Play in the book reads on from your page', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listenThenPause(page, book, 100);

    // Back to the book page in the app (a reload would empty the player, which this is about).
    await page.getByRole('link', { name: /^Back to / }).click();
    // One way in (D198), no button for each format: Continue, into the text, the audiobook along.
    await expect(page.locator('.format-actions').getByRole('link')).toHaveCount(1);
    await expect(continueButton(page)).toHaveClass(/btn-primary/);
    await openFromBookPage(page, book, { label: 'Continue', kind: 'epub', along: true });
    // Where you stopped listening, marked; no longer said in a toast (D198).
    await expect(page.getByTestId('landing-mark').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.toast-text').filter({ hasText: /Where you stopped|Reading along from/ })).toHaveCount(0);
    // The audiobook plays on from where it stopped, in the same tap.
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.src)).toMatch(/\/tracks\/0(\?|$)/);
    expect(await audioTime(page)).toBeGreaterThan(99);

    // Paused, then read on from chapter III, then Play in the book's footer: the audiobook plays
    // from there, not from chapter I where it stopped.
    await page.getByTestId('footer-play').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Play the audiobook');
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
    await listenThenPause(page, book, 100);
    // The player keeps the audiobook while you read on in the book (in the app: a reload would
    // empty the player, which this is about).
    await readFromChapterThree(page);
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await page.waitForTimeout(1000);
    await page.getByRole('link', { name: /^Back to / }).click();
    // Reading last now: Continue opens the text there, without starting the audiobook (D198)…
    await openFromBookPage(page, book, { label: 'Continue', kind: 'epub', along: false });
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(page.locator('.reader-chapter')).toContainText(/CHAPTER III/i);
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Play the audiobook');
    // …and listening again (over the text, D197): from where you read on to, not where it stopped.
    await page.getByTestId('footer-play').click();
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? ''), { timeout: 15_000 }).toMatch(/\/tracks\/2(\?|$)/);
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await ctx.close();
  });

  test('listening last, the book page’s one Continue starts the audiobook in that tap, at your place, over the text, and the pages follow it; hidden for the book, Continue opens the text alone (D194, D197, D198)', async ({ browser }) => {
    const { club, book: uploaded } = await clubWithAlice([], { audio: 'librivox' });
    const audio = uploaded.editions.find((e) => e.kind === 'audio')!;
    const book = await readAlong(club.owner, uploaded, audio.id);
    // Last heard twenty seconds into the first track.
    const res = await club.owner.api.put(`/api/books/${book.id}/progress`, { data: { editionId: audio.id, locator: { kind: 'audio', track: 0, ms: 20_000 }, readSpans: [], at: Date.now() } });
    expect(res.ok()).toBe(true);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openFromBookPage(page, book, { label: 'Continue', kind: 'epub', along: true });
    await expect(page).toHaveURL(/\/read\?edition=/);
    // Asked for once: the address forgets it, so a reload does not start it again.
    await expect(page).not.toHaveURL(/along=/);
    // Playing, with no second tap (D187 asked for one, on Play below), and no prompt to tap.
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await expect(page.getByTestId('along-start')).toHaveCount(0);
    await expect(page.locator('.reader-dock')).toBeVisible();
    // The narrator is followed: before the text (LibriVox's opening) or reading a sentence.
    const reader = page.getByTestId('reader');
    await expect.poll(async () => (await page.getByTestId('narration-before').count()) > 0 || (await reader.getAttribute('data-narrated')) !== '', { timeout: 20_000 }).toBe(true);
    await ctx.close();

    // The audiobook hidden for this book, in Book settings (D198): Continue opens the text alone.
    const other = await browserAs(browser, club.owner);
    const phone = await other.newPage();
    await phone.goto(`/books/${book.id}`);
    await expect(continueButton(phone)).toHaveAttribute('href', /[?&]along=/);
    const hide = (await openBookSettings(phone)).getByTestId('book-hide-audio');
    await hide.check();
    await expect(hide).toBeChecked();
    await phone.keyboard.press('Escape');
    await openFromBookPage(phone, book, { label: 'Continue', kind: 'epub', along: false });
    await expect(phone.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(phone.locator('.reader-dock')).toHaveCount(0);
    await expect(phone.getByTestId('listen-here')).toHaveCount(0);
    await other.close();
  });
});
