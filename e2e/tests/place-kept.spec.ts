import { type Page, expect, test } from '@playwright/test';
import { type BookDetail, type Locator, locatorToT } from '@bookclub/shared';
import { browserAs, clubWithAlice, readAlong, serverPlace } from '../helpers/api';
import { openFromBookPage } from '../helpers/open';

/*
 * Your place survives closing the app (D196): stop listening anywhere, close, reopen, and you are
 * where the narrator stopped, never back where reading along began or at the chapter's start.
 */

const audioTime = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime);

async function aliceReadingAlong() {
  const { club, book } = await clubWithAlice([], { audio: 'librivox' });
  const audio = book.editions.find((e) => e.kind === 'audio')!;
  const lined = await readAlong(club.owner, book, audio.id);
  return { club, book: lined, audio: lined.editions.find((e) => e.kind === 'audio')!, epub: lined.editions.find((e) => e.kind === 'epub')! };
}

/** Where a saved place is on the book's timeline. */
function tOf(book: BookDetail, editionId: string, l: Locator): number {
  const e = book.editions.find((x) => x.id === editionId)!;
  return locatorToT({ geometry: e.geometry!, sync: e.sync! }, l);
}

/** Read from chapter III: the contents, then "Read from here". */
async function readFromChapterThree(page: Page) {
  const reader = page.getByTestId('reader');
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  const before = await reader.getAttribute('data-section');
  await page.getByTestId('open-toc').click();
  await page.getByRole('button', { name: /CHAPTER III\./ }).click();
  await expect(reader).not.toHaveAttribute('data-section', before ?? '');
  await page.getByTestId('read-from-here').click();
  await expect(page.getByTestId('look-chip')).toHaveCount(0);
  return { section: (await reader.getAttribute('data-section'))!, start: Number(await reader.getAttribute('data-start')) };
}

test.describe('your place survives closing the app', () => {
  test('read along a while, then stop: the place saved is where the narrator stopped, not where reading along began, and a reopen comes back there', async ({ browser }) => {
    const { club, book, audio } = await aliceReadingAlong();
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    const opened = await readFromChapterThree(page);
    const reader = page.getByTestId('reader');

    // Reading along from chapter III's first page; the narrator goes on, well into the chapter
    // (the same section of the book), and the pages follow.
    await page.getByTestId('listen-here').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(1);
    await page.getByTestId('dock-scrubber').fill('300');
    await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(300);
    await expect.poll(async () => Number(await reader.getAttribute('data-start')), { timeout: 15_000 }).toBeGreaterThan(opened.start);
    await expect(reader).toHaveAttribute('data-section', opened.section);
    const narratorPage = Number(await reader.getAttribute('data-start'));
    const heard = await audioTime(page);

    // Stop listening: the audiobook stops and the dock goes, the page laid out again.
    await page.getByTestId('dock-stop').click();
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? '')).toBe('');
    // Whatever the reader and the player save as they settle (a debounced page report included).
    await page.waitForTimeout(2_000);

    // The place saved is the narrator's: in the audiobook to the second, or the narrator's page.
    const saved = await serverPlace(page, book.id);
    expect(saved).not.toBeNull();
    const narratorT = tOf(book, audio.id, { kind: 'audio', track: 2, ms: Math.round(heard * 1000) });
    const savedT = saved!.kind === 'audio' ? tOf(book, audio.id, saved!) : tOf(book, book.editions.find((e) => e.kind === 'epub')!.id, saved!);
    // Not where reading along began (chapter III's first page), however it is said.
    const beganT = tOf(book, book.editions.find((e) => e.kind === 'epub')!.id, { kind: 'epub', section: Number(opened.section), offset: opened.start });
    expect(savedT).toBeGreaterThan(beganT + (narratorT - beganT) / 2);

    // Close the app and open it again: the book opens at the narrator's page, not chapter III's first.
    await page.close();
    const again = await ctx.newPage();
    await again.goto(`/books/${book.id}/read`);
    const reopened = again.getByTestId('reader');
    await expect(again.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(reopened).toHaveAttribute('data-section', opened.section);
    expect(Number(await reopened.getAttribute('data-start'))).toBeGreaterThanOrEqual(narratorPage);
    // The book reopened there reports that page as the place it opened at, with the time the
    // narrator was there, which keeps the narrator's place: the audiobook, opened next by the
    // book page's one Continue (D198: the text, the audiobook along in the same tap), plays on
    // from the narrator's second.
    await again.waitForTimeout(1_500);
    await again.close();
    const player = await ctx.newPage();
    await openFromBookPage(player, book, { label: 'Continue', kind: 'epub', along: true });
    await expect.poll(() => player.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? '')).toMatch(/\/tracks\/2(\?|$)/);
    await expect.poll(() => audioTime(player), { timeout: 15_000 }).toBeGreaterThan(heard - 1.5);
    // Playing on from there, as the tap starts it: a moment past it at most.
    expect(await audioTime(player)).toBeLessThan(heard + 3);
    await ctx.close();
  });

  test('paused while reading along, the page laid out again (the phone turned): the place stays the narrator’s', async ({ browser }) => {
    const { club, book, audio } = await aliceReadingAlong();
    const ctx = await browserAs(browser, club.owner, { viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    const opened = await readFromChapterThree(page);
    const reader = page.getByTestId('reader');
    await page.getByTestId('listen-here').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(1);
    await page.getByTestId('dock-scrubber').fill('300');
    await expect.poll(async () => Number(await reader.getAttribute('data-start')), { timeout: 15_000 }).toBeGreaterThan(opened.start);
    await page.getByTestId('footer-play').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Play the audiobook');
    const heard = await audioTime(page);

    // The window changes size (a phone turned, the app back from the background): laid out again.
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.waitForTimeout(2_000);

    const saved = await serverPlace(page, book.id);
    const narratorT = tOf(book, audio.id, { kind: 'audio', track: 2, ms: Math.round(heard * 1000) });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const savedT = saved!.kind === 'audio' ? tOf(book, audio.id, saved!) : tOf(book, epub.id, saved!);
    const beganT = tOf(book, epub.id, { kind: 'epub', section: Number(opened.section), offset: opened.start });
    expect(savedT).toBeGreaterThan(beganT + (narratorT - beganT) / 2);
    await ctx.close();
  });

  test('read along from the book page: the audiobook plays on from the very second you stopped listening', async ({ browser }) => {
    const { club, book, audio } = await aliceReadingAlong();
    // Stopped listening 8 s into the first track: its opening words, before the text begins, all at
    // one moment of the book (a flat stretch of its map), so a place gone through the timeline
    // comes back at the track's first second.
    const ms = 8_000;
    const res = await club.owner.api.put(`/api/books/${book.id}/progress`, { data: { editionId: audio.id, locator: { kind: 'audio', track: 0, ms }, readSpans: [], at: Date.now() } });
    expect(res.ok()).toBe(true);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    // Continue, listening last (D197, D198): the book's text, the audiobook playing over it from the saved second.
    await openFromBookPage(page, book, { label: 'Continue', kind: 'epub', along: true });
    await expect(page.getByTestId('reader')).toBeVisible();
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? '')).toMatch(/\/tracks\/0(\?|$)/);
    // Where it started: where you stopped, to the second (it plays on from there), not the
    // track's first second.
    await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(0.2);
    const first = await audioTime(page);
    expect(first).toBeGreaterThan(ms / 1000 - 0.5);
    expect(first).toBeLessThan(ms / 1000 + 3);
    await ctx.close();
  });
});
