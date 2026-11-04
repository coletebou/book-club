import { expect, test } from '@playwright/test';
import { SYNTHETIC_DIR, audioFolder, browserAs, clubWithAlice, makeClub, uploadBook } from '../helpers/api';

/*
 * The book is its text (D197): whichever format you were in, a book with a text opens as text and
 * the audiobook is played over it; a book that is only an audiobook opens in the player. And the
 * audiobook's controls can be hidden: your default in Settings, each book's own choice over it.
 */

test.describe('the book is its text', () => {
  test('hide the audiobook: by default for every book in Settings, and shown again for one book', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    // Shown to start with: on the book page, and in the reader's footer.
    await page.goto(`/books/${book.id}`);
    await expect(page.getByTestId('open-audio')).toBeVisible();
    await page.getByTestId('open-epub').click();
    await expect(page.getByTestId('listen-here')).toBeVisible({ timeout: 30_000 });

    // Hidden by default, in Settings.
    await page.goto('/settings#listening');
    const hide = page.getByTestId('hide-audio-controls');
    await expect(hide).not.toBeChecked();
    await hide.check();
    await expect.poll(async () => ((await (await page.request.get('/api/me/audio-controls')).json()) as { hidden: boolean }).hidden).toBe(true);
    await page.goto(`/books/${book.id}`);
    await expect(page.getByTestId('open-epub')).toBeVisible();
    await expect(page.getByTestId('open-audio')).toHaveCount(0);
    await expect(page.getByTestId('book-hide-audio')).toBeChecked();
    await page.getByTestId('open-epub').click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('listen-here')).toHaveCount(0);

    // This book says otherwise, in its reading settings: shown here, still hidden in other books.
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('audio-controls-default')).toBeChecked();
    // The choice's label is what one taps (its radio is visually hidden, as every setting's is).
    await page.locator('label', { has: page.getByTestId('audio-controls-show') }).click();
    await expect(page.getByTestId('audio-controls-show')).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('listen-here')).toBeVisible();
    await expect.poll(async () => ((await (await page.request.get(`/api/books/${book.id}/progress`)).json()) as { audioControls: { hidden: boolean | null } | null }).audioControls?.hidden).toBe(false);

    // On another device (a new context): the server's choices, the same.
    const other = await browserAs(browser, club.owner);
    const phone = await other.newPage();
    await phone.goto(`/books/${book.id}/read`);
    await expect(phone.getByTestId('listen-here')).toBeVisible({ timeout: 30_000 });
    await other.close();

    // And on the book page, back to "as my default": hidden again.
    await page.goto(`/books/${book.id}`);
    const toggle = page.getByTestId('book-hide-audio');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(page.getByTestId('open-audio')).toHaveCount(0);
    await expect.poll(async () => ((await (await page.request.get(`/api/books/${book.id}/progress`)).json()) as { audioControls: { hidden: boolean | null } | null }).audioControls?.hidden).toBeNull();
    await ctx.close();
  });

  test('an audiobook playing is never hidden: its controls are how it is stopped', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.getByTestId('open-audio').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    // Hidden for this book while it plays: the dock stays, and Stop puts it away.
    await page.getByTestId('open-settings').click();
    await page.locator('label', { has: page.getByTestId('audio-controls-hide') }).click();
    await expect(page.getByTestId('audio-controls-hide')).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.locator('.reader-dock')).toBeVisible();
    await page.getByTestId('dock-stop').click();
    await expect(page.locator('.reader-dock')).toHaveCount(0);
    await expect(page.getByTestId('listen-here')).toHaveCount(0);
    await ctx.close();
  });

  test('away from the book, the mini player opens its text where the narrator is; a book that is only an audiobook opens in the player', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.getByTestId('open-audio').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await page.getByRole('link', { name: /^Back to / }).click();
    await page.locator('.mini-player .mini-link').click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/read\\?edition=`));
    await expect(page.locator('.reader-dock')).toBeVisible();

    const solo = await makeClub([], 'Ida');
    const tracks = await uploadBook(solo.owner, solo.id, 'audio', audioFolder(SYNTHETIC_DIR), { title: 'Only Heard', author: 'Ada Tone' });
    const ida = await browserAs(browser, solo.owner);
    const listener = await ida.newPage();
    await listener.goto(`/books/${tracks.id}`);
    await listener.getByTestId('open-audio').click();
    await expect(listener.getByTestId('listen-page')).toBeVisible();
    await expect(listener.getByTestId('show-text')).toHaveCount(0);
    await ida.close();
    await ctx.close();
  });
});
