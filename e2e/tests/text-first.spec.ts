import { type Page, expect, test } from '@playwright/test';
import { SYNTHETIC_DIR, audioFolder, browserAs, clubWithAlice, makeClub, uploadBook } from '../helpers/api';
import { listenFromThisPage, openBookSettings, openFromBookPage } from '../helpers/open';

/*
 * The book is its text (D197): whichever format you were in, a book with a text opens as text and
 * the audiobook is played over it; a book that is only an audiobook opens in the player. And the
 * audiobook's controls can be hidden: your default in Settings, each book's own choice over it (in
 * Book settings since D198). No audio-only screen by default (D198): a link to the player opens
 * the text, unless Settings allows the full player on that device.
 */

test.describe('the book is its text', () => {
  test('hide the audiobook: by default for every book in Settings, and shown again for one book', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    // Shown to start with: this book's choice in Book settings, and Listen in the reader's footer
    // (the book page itself has only its one way in, D198).
    await page.goto(`/books/${book.id}`);
    await expect((await openBookSettings(page)).getByTestId('book-hide-audio')).not.toBeChecked();
    await page.keyboard.press('Escape');
    await openFromBookPage(page, book, { label: 'Open', kind: 'epub', along: false });
    await expect(page.getByTestId('listen-here')).toBeVisible({ timeout: 30_000 });

    // Hidden by default, in Settings.
    await page.goto('/settings#listening');
    const hide = page.getByTestId('hide-audio-controls');
    await expect(hide).not.toBeChecked();
    await hide.check();
    await expect.poll(async () => ((await (await page.request.get('/api/me/audio-controls')).json()) as { hidden: boolean }).hidden).toBe(true);
    await page.goto(`/books/${book.id}`);
    await expect((await openBookSettings(page)).getByTestId('book-hide-audio')).toBeChecked();
    await page.keyboard.press('Escape');
    await openFromBookPage(page, book, { kind: 'epub', along: false });
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

    // And on the book page, in Book settings (D198), back to "as my default": hidden again.
    await page.goto(`/books/${book.id}`);
    const toggle = (await openBookSettings(page)).getByTestId('book-hide-audio');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect.poll(async () => ((await (await page.request.get(`/api/books/${book.id}/progress`)).json()) as { audioControls: { hidden: boolean | null } | null }).audioControls?.hidden).toBeNull();
    // Where it showed, in the reader's footer, it is gone again.
    await page.keyboard.press('Escape');
    await openFromBookPage(page, book, { kind: 'epub', along: false });
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('listen-here')).toHaveCount(0);
    await ctx.close();
  });

  test('an audiobook playing is never hidden: its controls are how it is stopped', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    // Into the book by its one way in, and Listen in the reader's footer (D198).
    await openFromBookPage(page, book, { label: 'Open', kind: 'epub' });
    await listenFromThisPage(page);
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
    // Into the book by its one way in, and Listen in the reader's footer (D198).
    await openFromBookPage(page, book, { label: 'Open', kind: 'epub' });
    await listenFromThisPage(page);
    await page.getByRole('link', { name: /^Back to / }).click();
    await page.locator('.mini-player .mini-link').click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/read\\?edition=`));
    await expect(page.locator('.reader-dock')).toBeVisible();

    const solo = await makeClub([], 'Ida');
    const tracks = await uploadBook(solo.owner, solo.id, 'audio', audioFolder(SYNTHETIC_DIR), { title: 'Only Heard', author: 'Ada Tone' });
    const ida = await browserAs(browser, solo.owner);
    const listener = await ida.newPage();
    // Its one way in, Open, is the player (D198), with no audio-only view to allow.
    await openFromBookPage(listener, tracks, { label: 'Open', kind: 'audio' });
    await expect(listener.getByTestId('listen-page')).toBeVisible();
    await expect(listener.getByTestId('show-text')).toHaveCount(0);
    await ida.close();
    await ctx.close();
  });

  test('no audio-only screen by default (D198): a link to the audiobook opens the text there with it docked, Full player keeps to the dock, and Allow audio-only view in Settings brings the player back on that device', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const three = book.chapters.findIndex((c) => c.title.startsWith('CHAPTER III.'));
    const inThree = (book.chapters[three]!.t + book.chapters[three + 1]!.t) / 2;
    const audioSrc = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? '');
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    // A link to a moment of the audiobook (a history line's Listen, a note heard there): the
    // book's text at that place, the audiobook docked over it, never a page of its own.
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}&at=${inThree}`);
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/read`));
    // Which track it started on, checked before the EPUB's own slower pagination (page-number's
    // `data-ready`, `.reader-chapter`) gives the tiny fixture's few-seconds-long tracks a real
    // window to play past it first: docking does not wait on pagination to begin.
    await expect(page.locator('.reader-dock')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => audioSrc(page)).toMatch(/\/tracks\/2(\?|$)/);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(page.locator('.reader-chapter')).toContainText(/CHAPTER III/i);
    await expect(page.getByTestId('listen-page')).toHaveCount(0);
    // Now in this book's Full player keeps to the docked player while the view is not allowed.
    await page.getByTestId('dock-expand').click();
    await page.getByRole('dialog', { name: 'Now in this book' }).getByTestId('open-full-player').click();
    await expect(page.getByRole('dialog', { name: 'Now in this book' })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/read`));
    await expect(page.locator('.reader-dock')).toBeVisible();

    // Allowed in Settings → Listening (off until chosen): the full player, as before.
    await page.goto('/settings#listening');
    const allow = page.getByTestId('allow-audio-only');
    await expect(allow).not.toBeChecked();
    await allow.check();
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await expect(page.getByTestId('listen-page')).toBeVisible();
    await expect(page.getByTestId('play-pause')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('listen-page')).toBeVisible();
    // Kept on this device only: another device of hers still opens the text.
    const other = await browserAs(browser, club.owner);
    const phone = await other.newPage();
    await phone.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await expect(phone).toHaveURL(new RegExp(`/books/${book.id}/read`));
    await expect(phone.getByTestId('listen-page')).toHaveCount(0);
    await other.close();
    await ctx.close();
  });
});
