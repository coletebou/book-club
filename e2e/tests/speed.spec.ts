import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { BookDetail, BookProgress, ListeningSettings } from '@bookclub/shared';
import { ALICE_TINY_DIR, type Person, audioFolder, browserAs, chooseSpeed, makeClub, uploadBook } from '../helpers/api';

/**
 * Listening speed (D195): any speed from 0.5× to 3.0× in 0.05 steps, a default on your profile,
 * and each book's own last speed, kept by the server so it follows you from device to device.
 */

/** An audiobook of its own (the tiny LibriVox-shaped one), in the person's club. */
const audiobook = (person: Person, clubId: string, title: string): Promise<BookDetail> =>
  uploadBook(person, clubId, 'audio', audioFolder(ALICE_TINY_DIR).slice(0, 2), { title, author: 'Lewis Carroll' });

async function listen(page: Page, bookId: string): Promise<void> {
  await page.goto(`/books/${bookId}/listen`);
  await expect(page.getByTestId('play-pause')).toBeVisible();
}

const elementRate = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.playbackRate);

/** What the server has as this person's speed for a book (null: none chosen). */
async function serverRate(person: Person, bookId: string): Promise<number | null> {
  const progress = (await (await person.api.get(`/api/books/${bookId}/progress`)).json()) as BookProgress;
  return progress.playback?.rate ?? null;
}

async function serverDefault(person: Person): Promise<number> {
  return ((await (await person.api.get('/api/me/listening')).json()) as ListeningSettings).defaultRate;
}

test.describe('listening speed', () => {
  test('the stepper moves in 0.05 steps and the presets are one tap, played exactly', async ({ browser }) => {
    const club = await makeClub();
    const book = await audiobook(club.owner, club.id, 'Stepper');
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await listen(page, book.id);
    await expect(page.getByTestId('speed')).toHaveText('1.0×');
    await page.getByTestId('speed').click();
    const sheet = page.getByRole('dialog', { name: 'Playback speed' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('radio', { name: '1.0 times' })).toHaveAttribute('aria-checked', 'true');
    // Seven taps of + : 1.35×, which no preset offers.
    for (let i = 0; i < 7; i++) await sheet.getByTestId('speed-up').click();
    await expect(sheet.getByTestId('speed-value')).toHaveText('1.35×');
    await expect.poll(() => elementRate(page)).toBe(1.35);
    await expect(sheet.getByRole('radio', { checked: true })).toHaveCount(0);
    await sheet.getByTestId('speed-down').click();
    await expect(sheet.getByTestId('speed-value')).toHaveText('1.3×');
    await expect.poll(() => elementRate(page)).toBe(1.3);
    // A preset.
    await sheet.getByTestId('speed-preset-1.75').click();
    await expect(sheet.getByRole('radio', { name: '1.75 times' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => elementRate(page)).toBe(1.75);
    // The ends of the range.
    await sheet.getByTestId('speed-preset-3').click();
    await expect(sheet.getByTestId('speed-up')).toBeDisabled();
    await sheet.getByTestId('speed-preset-0.75').click();
    for (let i = 0; i < 5; i++) await sheet.getByTestId('speed-down').click();
    await expect(sheet.getByTestId('speed-value')).toHaveText('0.5×');
    await expect(sheet.getByTestId('speed-down')).toBeDisabled();
    await expect.poll(() => elementRate(page)).toBe(0.5);
    // Back up to 1.35× from the bottom, step by step, and it is kept as this book's.
    for (let i = 0; i < 17; i++) await sheet.getByTestId('speed-up').click();
    await expect(sheet.getByTestId('speed-value')).toHaveText('1.35×');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('speed')).toHaveText('1.35×');
    await expect.poll(() => serverRate(club.owner, book.id)).toBe(1.35);
    await ctx.close();
  });

  test('each book remembers its own speed on every device, and a new book starts at 1.0×', async ({ browser }) => {
    const club = await makeClub();
    const first = await audiobook(club.owner, club.id, 'First');
    const second = await audiobook(club.owner, club.id, 'Second');
    const phone = await browserAs(browser, club.owner);
    const page = await phone.newPage();
    await listen(page, first.id);
    await page.getByTestId('speed').click();
    for (let i = 0; i < 2; i++) await page.getByTestId('speed-up').click();
    await expect(page.getByTestId('speed-value')).toHaveText('1.1×');
    await page.keyboard.press('Escape');
    await expect.poll(() => serverRate(club.owner, first.id)).toBe(1.1);
    // The other book is untouched by it.
    await listen(page, second.id);
    await expect(page.getByTestId('speed')).toHaveText('1.0×');
    await expect.poll(() => elementRate(page)).toBe(1);
    await chooseSpeed(page, 2);
    await expect.poll(() => serverRate(club.owner, second.id)).toBe(2);

    // Another device, nothing of this one's storage: each book opens at its own speed.
    const laptop: BrowserContext = await browserAs(browser, club.owner);
    const other = await laptop.newPage();
    await listen(other, first.id);
    await expect(other.getByTestId('speed')).toHaveText('1.1×');
    await expect.poll(() => elementRate(other)).toBe(1.1);
    await listen(other, second.id);
    await expect(other.getByTestId('speed')).toHaveText('2.0×');
    await expect.poll(() => elementRate(other)).toBe(2);
    // Changed there, it is the speed back here next time.
    await chooseSpeed(other, 1.25);
    await expect.poll(() => serverRate(club.owner, second.id)).toBe(1.25);
    await listen(page, first.id);
    await listen(page, second.id);
    await expect(page.getByTestId('speed')).toHaveText('1.25×');
    await expect.poll(() => elementRate(page)).toBe(1.25);
    await phone.close();
    await laptop.close();
  });

  test("a speed made your default is where new audiobooks start; a book's own speed wins over it", async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const ana = club.members['Ana']!;
    const first = await audiobook(club.owner, club.id, 'Default one');
    const ctx = await browserAs(browser, ana);
    const page = await ctx.newPage();
    await listen(page, first.id);
    await page.getByTestId('speed').click();
    const sheet = page.getByRole('dialog', { name: 'Playback speed' });
    await expect(sheet.getByTestId('speed-default')).toHaveText('1.0×');
    await expect(sheet.getByTestId('speed-is-default')).toHaveText('1.0× is your default.');
    for (let i = 0; i < 4; i++) await sheet.getByTestId('speed-up').click();
    await expect(sheet.getByTestId('speed-make-default')).toHaveText('Make 1.2× my default');
    await sheet.getByTestId('speed-make-default').click();
    await expect(page.getByText('1.2× is now your default speed.')).toBeVisible();
    await expect(sheet.getByTestId('speed-default')).toHaveText('1.2×');
    await expect(sheet.getByTestId('speed-is-default')).toBeVisible();
    await expect.poll(() => serverDefault(ana)).toBe(1.2);
    await page.keyboard.press('Escape');

    // A book Ana has never listened to opens at her default; the owner's stays at his own.
    const second = await audiobook(club.owner, club.id, 'Default two');
    await listen(page, second.id);
    await expect(page.getByTestId('speed')).toHaveText('1.2×');
    await expect.poll(() => elementRate(page)).toBe(1.2);
    expect(await serverDefault(club.owner)).toBe(1);
    // Its own speed, once chosen, wins over the default; the first book keeps its own.
    await chooseSpeed(page, 1.75);
    await listen(page, first.id);
    await expect(page.getByTestId('speed')).toHaveText('1.2×');
    await listen(page, second.id);
    await expect(page.getByTestId('speed')).toHaveText('1.75×');

    // Settings: the same default, and changing it there is what the next new book starts at.
    await page.goto('/settings');
    const card = page.getByRole('region', { name: 'Listening' });
    await expect(card.getByTestId('speed-value')).toHaveText('1.2×');
    await card.getByTestId('speed-preset-1.5').click();
    await expect(card.getByTestId('default-speed-status')).toHaveText('Saved. New audiobooks start at 1.5×.');
    await expect.poll(() => serverDefault(ana)).toBe(1.5);
    const third = await audiobook(club.owner, club.id, 'Default three');
    await listen(page, third.id);
    await expect(page.getByTestId('speed')).toHaveText('1.5×');
    // And from the player's sheet, its link goes there.
    await page.getByTestId('speed').click();
    await page.getByRole('link', { name: 'Listening settings' }).click();
    await expect(page).toHaveURL(/\/settings#listening$/);
    await expect(page.getByRole('heading', { name: 'Listening' })).toBeInViewport();
    await ctx.close();
  });
});
