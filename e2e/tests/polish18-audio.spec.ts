import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { BookDetail } from '@bookclub/shared';
import { LIBRIVOX_DIR, SYNTHETIC_DIR, aliceEpub, audioFolder, browserAs, clubWithAlice, makeClub, readAlong, uploadBook } from '../helpers/api';

/**
 * Fidelity review round 18, end to end, with the demo's LibriVox Alice and its transcript: the
 * track list makes up no chapter from a track's closing words (FR160); once lined up, every track
 * is named by the chapter it holds, its tag tidied where nothing better is known (FR161); and a
 * tag's track number before its chapter's is dropped on the upload form (FR164).
 */

const audioTime = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime);
const lockScreen = (page: Page) => page.evaluate(() => navigator.mediaSession?.metadata?.title ?? null);
const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
/** The names the track list shows, without each entry's length. */
const listed = (page: Page) => page.locator('[data-testid=track-item] > span:first-child, [data-testid=track-chapter] > span:first-child');

test.describe('the track list and the player name the chapter heard (FR160, FR161)', () => {
  test('the demo’s LibriVox Alice lists each chapter once, a track each, and plays the first track’s credits under Chapter I', async ({ browser }) => {
    const { club, book: uploaded } = await clubWithAlice([], { audio: 'librivox' });
    const audioId = uploaded.editions.find((e) => e.kind === 'audio')!.id;
    const book = await readAlong(club.owner, uploaded, audioId);
    const audio = book.editions.find((e) => e.id === audioId)!;
    const story = book.chapters.filter((c) => c.title.startsWith('CHAPTER'));
    // Each chapter is heard starting in its own track, in its opening, and nowhere else.
    expect(audio.tracks.map((tr) => tr.chapters?.map((c) => book.chapters[c.chapter]!.title))).toEqual(story.map((c) => [c.title]));
    for (const tr of audio.tracks) expect(tr.chapters![0]!.ms).toBeLessThan(60_000);

    // The full player and its track list, which this device allows (Settings, D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await page.getByTestId('toggle-tracks').click();
    // One row a track, each its chapter's: none twice, none inside a track (the reviewer's list had
    // "CHAPTER II. The Pool of Tears 0:07" under the first track, and again as the second).
    await expect(listed(page)).toHaveText(story.map((c) => c.title));
    await expect(page.getByTestId('track-chapter')).toHaveCount(0);
    // The first track's last seconds: "End of chapter 1. Read by Krista McQuillan, Tokyo, Japan…".
    await page.getByTestId('track-item').first().click();
    const listen = page.getByTestId('listen-page');
    await expect(listen).toHaveAttribute('data-track', '0');
    await page.getByTestId('scrubber').fill('636');
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(635);
    await expect(page.getByTestId('listen-title')).toHaveText('CHAPTER I. Down the Rabbit-Hole');
    await expect(page.getByTestId('readalong-current')).toHaveText('So she set to work, and very soon finished off the cake.');
    await expect(page.locator('.reader-chapter')).toHaveText(/^Chapter 1 · /);
    await expect.poll(() => lockScreen(page)).toBe('CHAPTER I. Down the Rabbit-Hole');
    // Played on into the second track: its opening is Chapter II's.
    await page.getByTestId('play-pause').click();
    await expect(listen).toHaveAttribute('data-track', '1', { timeout: 30_000 });
    await expect(page.getByTestId('listen-title')).toHaveText('CHAPTER II. The Pool of Tears');
    await expect(page.locator('.reader-chapter')).toHaveText(/^Chapter 2 · /);
    await expect.poll(() => lockScreen(page)).toBe('CHAPTER II. The Pool of Tears');
    await page.getByTestId('play-pause').click();
    await ctx.close();
  });

  test('a recording numbered its own way: tags tidied before it is lined up, each track its chapter’s after', async ({ browser }) => {
    const club = await makeClub();
    let book: BookDetail = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    // As LibriVox numbers The Time Machine's files ("06 - Chapter 6" holds its chapter IX): here one
    // ahead of the book's own numbers, which no chapter match pairs with its chapters (D73).
    const files = audioFolder(LIBRIVOX_DIR);
    const tags = files.map((_, i) => `${String(i + 1).padStart(2, '0')} - Chapter ${i + 2}`);
    book = await uploadBook(club.owner, club.id, 'audio', files, { title: book.title, author: book.author, bookId: book.id, trackTitles: tags });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    expect(audio.alignment.unitToChapter.every((c) => c === null)).toBe(true);
    expect(audio.tracks.map((tr) => tr.title)).toEqual(tags);

    // The full player and its track list, which this device allows (Settings, D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    // Before it is lined up nothing better is known: the tags, without the number before the chapter's.
    await expect(page.getByTestId('listen-title')).toHaveText('Chapter 2');
    await page.getByTestId('toggle-tracks').click();
    await expect(listed(page)).toHaveText(tags.map((_, i) => `Chapter ${i + 2}`));

    // Lined up sentence by sentence: each track is named by the chapter it holds.
    book = await readAlong(club.owner, book, audio.id);
    const story = book.chapters.filter((c) => c.title.startsWith('CHAPTER'));
    expect(book.editions.find((e) => e.id === audio.id)!.tracks.map((tr) => book.chapters[tr.chapter!]!.title)).toEqual(story.map((c) => c.title));
    await page.reload();
    await page.getByTestId('toggle-tracks').click();
    await expect(listed(page)).toHaveText(story.map((c) => c.title));
    // "06 - Chapter 7" holds CHAPTER VI: the title, the lock screen, and no "Chapter 7" under it.
    await page.getByTestId('track-item').nth(5).click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '5');
    await expect(page.getByTestId('listen-title')).toHaveText('CHAPTER VI. Pig and Pepper');
    await expect(page.getByTestId('listen-sub')).toHaveText('Lewis Carroll');
    await expect.poll(() => lockScreen(page)).toBe('CHAPTER VI. Pig and Pepper');
    // A note made here is pinned "in" the chapter, not in "Chapter 7".
    await page.getByTestId('add-note').click();
    await expect(page.getByText(/^Pinned at \d+:\d\d in CHAPTER VI\. Pig and Pepper\./)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText(/^Pinned at /)).toHaveCount(0);
    // Away from the player, on the book's page, the mini player says it too.
    await page.getByRole('link', { name: `Back to ${book.title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}$`));
    await expect(page.getByTestId('mini-player')).toContainText('CHAPTER VI. Pig and Pepper');
    await ctx.close();
  });
});

/* An MP3 tagged as LibriVox tags a track: an ID3v2.4 title in front of a fixture's MPEG frames. */
const syncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
function taggedMp3(title: string): Buffer {
  const text = Buffer.concat([Buffer.from([3]), Buffer.from(title, 'utf8')]);
  const frame = Buffer.concat([Buffer.from('TIT2', 'latin1'), syncsafe(text.length), Buffer.from([0, 0]), text]);
  const audio = readFileSync(path.join(SYNTHETIC_DIR, '02 - The Middle.mp3'));
  const size = audio.toString('latin1', 0, 3) === 'ID3' ? 10 + ((audio[6]! << 21) | (audio[7]! << 14) | (audio[8]! << 7) | audio[9]!) : 0;
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), syncsafe(frame.length), frame, audio.subarray(size)]);
}

test('the upload form names tracks tagged "01 - Chapter I" as "Chapter I" (FR164)', async ({ browser }) => {
  const club = await makeClub();
  const ctx = await browserAs(browser, club.owner);
  const page = await ctx.newPage();
  await page.goto(`/clubs/${club.id}`);
  await page.getByRole('button', { name: 'Add a book' }).click();
  const tags = ['01 - Chapter I', '02 - Chapter II', '03 - Chapter III', '13 - Epilogue'];
  await page.getByTestId('file-input').setInputFiles(tags.map((tag, i) => ({ name: `timemachine_${String(i + 1).padStart(2, '0')}_wells_64kb.mp3`, mimeType: 'audio/mpeg', buffer: taggedMp3(tag) })));
  const names = page.getByTestId('track-row').locator('.track-name');
  // A tag that names something besides its number keeps the number it is matched by.
  await expect(names).toHaveText([exactly('Chapter I ·'), exactly('Chapter II ·'), exactly('Chapter III ·'), exactly('13 - Epilogue ·')]);
  await ctx.close();
});
