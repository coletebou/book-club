import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { type BookDetail } from '@bookclub/shared';
import { ALICE_EPUB, ALICE_PDF, ALICE_TINY_DIR, FIXTURES, SYNTHETIC_DIR, aliceEpub, browserAs, clubWithAlice, makeClub, postComment, uploadBook } from '../helpers/api';
import { readdirSync } from 'node:fs';

async function openUpload(page: Page, clubId: string) {
  await page.goto(`/clubs/${clubId}`);
  await page.getByRole('button', { name: 'Add a book' }).click();
}

async function coverLoaded(page: Page, selector: string) {
  await expect
    .poll(async () => page.locator(selector).first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 15_000 })
    .toBe(true);
}

test.describe('bringing a book in', () => {
  test('an EPUB fills in its own title, author and cover', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openUpload(page, club.id);
    await page.getByTestId('file-input').setInputFiles(ALICE_EPUB);
    await expect(page.getByTestId('upload-title')).toHaveValue("Alice's Adventures in Wonderland");
    await expect(page.getByTestId('upload-author')).toHaveValue('Lewis Carroll');
    await coverLoaded(page, '[data-testid=upload-cover]');
    await page.getByTestId('upload-start').click();
    await expect(page).toHaveURL(/\/books\//, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1, name: "Alice's Adventures in Wonderland" })).toBeVisible();
    await expect(page.getByTestId('open-epub')).toBeVisible({ timeout: 30_000 });
    await coverLoaded(page, '.book-hero-cover');
    await ctx.close();
  });

  test('a PDF fills in title and author from its info and uses page one as the cover', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openUpload(page, club.id);
    await page.getByTestId('file-input').setInputFiles(ALICE_PDF);
    await expect(page.getByTestId('upload-title')).toHaveValue("Alice's Adventures in Wonderland");
    await expect(page.getByTestId('upload-author')).toHaveValue('Lewis Carroll');
    await coverLoaded(page, '[data-testid=upload-cover]');
    await page.getByTestId('upload-start').click();
    await expect(page.getByTestId('open-pdf')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('edition').filter({ hasText: 'PDF' })).toContainText('91 pages');
    await coverLoaded(page, '.book-hero-cover');
    await ctx.close();
  });

  test('a multi-track audiobook fills in title, author and cover from its tags, tracks in filename order', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openUpload(page, club.id);
    const files = readdirSync(SYNTHETIC_DIR).map((f) => path.join(SYNTHETIC_DIR, f));
    await page.getByTestId('file-input').setInputFiles([...files].reverse());
    await expect(page.getByTestId('upload-title')).toHaveValue('The Synthetic Tale');
    await expect(page.getByTestId('upload-author')).toHaveValue('Ada Tone');
    await coverLoaded(page, '[data-testid=upload-cover]');
    const rows = page.getByTestId('track-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('The Beginning');
    await expect(rows.nth(1)).toContainText('The Middle');
    await expect(rows.nth(2)).toContainText('The End');
    await page.getByTestId('upload-start').click();
    await expect(page.getByTestId('open-audio')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('edition').filter({ hasText: 'Audiobook' })).toContainText('3 tracks');
    await coverLoaded(page, '.book-hero-cover');
    await ctx.close();
  });

  test('a single-file audiobook (M4B) keeps the chapters inside it: the player lists them, goes to each, names the one playing and ends each', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openUpload(page, club.id);
    await page.getByTestId('file-input').setInputFiles(path.join(FIXTURES, 'audio/m4b/tale-in-three-chapters.m4b'));
    await expect(page.getByTestId('upload-title')).toHaveValue('A Tale in Three Chapters');
    await expect(page.getByTestId('upload-author')).toHaveValue('Ada Tone');
    await page.getByTestId('upload-start').click();
    await expect(page.getByTestId('open-audio')).toBeVisible({ timeout: 30_000 });
    // Ana leaves a note in the middle chapter.
    const bookId = page.url().split('/books/')[1]!.split(/[?#]/)[0]!;
    const detail = (await (await page.request.get(`/api/books/${bookId}`)).json()) as BookDetail;
    const audio = detail.editions.find((e) => e.kind === 'audio')!;
    await postComment(club.members.Ana!, bookId, { editionId: audio.id, locator: { kind: 'audio', track: 0, ms: 5000 }, text: 'Hear how the middle hums' });
    await page.getByTestId('open-audio').click();
    await page.getByTestId('toggle-tracks').click();
    const items = page.locator('.track-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('Chapter One: The Start');
    await expect(items.nth(1)).toContainText('Chapter Two: The Middle');
    await expect(items.nth(2)).toContainText('Chapter Three: The End');
    // The second chapter starts four seconds into the file.
    await items.nth(1).click();
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(3.9);
    await expect(items.nth(1)).toHaveAttribute('aria-current', 'true');
    // The title names the chapter playing, not the file's first.
    const title = page.locator('.listen-title');
    await expect(title).toHaveText('Chapter Two: The Middle');
    // A chapter from the list is a look until Play (D72): played there.
    await page.getByTestId('play-pause').click();
    // Heard to its end, inside the one file: the chapter's end, with what friends said in it.
    await expect(page.getByTestId('chapter-end')).toContainText('1 note from Ana', { timeout: 15_000 });
    await expect(title).toHaveText('Chapter Three: The End');
    await ctx.close();
  });

  test('bringing a format the club already has says so, and makes a second book only when asked', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openUpload(page, club.id);
    const tracks = readdirSync(ALICE_TINY_DIR).filter((f) => /\.(mp3|jpg)$/i.test(f));
    await page.getByTestId('file-input').setInputFiles(tracks.map((f) => path.join(ALICE_TINY_DIR, f)));
    const notice = page.getByTestId('already-have');
    await expect(notice).toContainText(`The club already has the audiobook of “${book.title}”`);
    await expect(page.getByTestId('upload-start')).toBeDisabled();
    await expect(page.getByTestId('attach-match')).toHaveCount(0);
    // Asked for: then it can go.
    await page.getByTestId('add-separately').check();
    await expect(page.getByTestId('upload-start')).toBeEnabled();
    // Or open the one the club has.
    await notice.getByRole('link', { name: 'Open it' }).click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}$`));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await ctx.close();
  });

  test('tracks can be reordered before uploading, and play in the chosen order', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openUpload(page, club.id);
    await page.getByTestId('file-input').setInputFiles(readdirSync(SYNTHETIC_DIR).map((f) => path.join(SYNTHETIC_DIR, f)));
    await expect(page.getByTestId('track-row')).toHaveCount(3);
    await page.getByRole('button', { name: 'Move The End up' }).click();
    await expect(page.getByTestId('track-row').nth(1)).toContainText('The End');
    await page.getByTestId('upload-start').click();
    await expect(page.getByTestId('open-audio')).toBeVisible({ timeout: 30_000 });
    const bookId = page.url().split('/books/')[1]!;
    const detail = (await (await page.request.get(`/api/books/${bookId}`)).json()) as { editions: { kind: string; tracks: { title: string }[] }[] };
    expect(detail.editions.find((e) => e.kind === 'audio')!.tracks.map((t) => t.title)).toEqual(['The Beginning', 'The End', 'The Middle']);
    await ctx.close();
  });

  test('a LibriVox-style folder takes its cover from the folder and joins the existing book as its audiobook', async ({ browser }) => {
    const club = await makeClub([]);
    const book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openUpload(page, club.id);
    await page.getByTestId('file-input').setInputFiles(readdirSync(ALICE_TINY_DIR).filter((f) => !f.endsWith('.txt')).map((f) => path.join(ALICE_TINY_DIR, f)));
    await expect(page.getByTestId('upload-title')).toHaveValue('Alice in Wonderland');
    await expect(page.getByTestId('upload-author')).toHaveValue('Lewis Carroll');
    await coverLoaded(page, '[data-testid=upload-cover]');
    await expect(page.getByTestId('track-row')).toHaveCount(12);
    await expect(page.getByTestId('track-row').first()).toContainText('Chapter 1');
    await page.getByTestId('attach-match').check();
    await page.getByTestId('upload-start').click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}$`), { timeout: 30_000 });
    await expect(page.getByTestId('open-audio')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('open-epub')).toBeVisible();
    // Tracks line up with the book's chapters (count and numbers), and take the chapter names.
    const detail = (await (await page.request.get(`/api/books/${book.id}`)).json()) as {
      chapters: { title: string }[];
      editions: { kind: string; alignment: { method: string }; tracks: { chapter: number | null }[] }[];
    };
    const audio = detail.editions.find((e) => e.kind === 'audio')!;
    expect(audio.alignment.method).toBe('number');
    expect(detail.chapters[audio.tracks[0]!.chapter!]!.title).toMatch(/^CHAPTER I\. /);
    expect(detail.chapters[audio.tracks[11]!.chapter!]!.title).toMatch(/^CHAPTER XII\. /);
    await ctx.close();
  });

  test('a file that is not a book is refused before anything is uploaded', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openUpload(page, club.id);
    await page.getByTestId('file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('just some text') });
    await expect(page.getByRole('alert')).toContainText('Choose an EPUB, a PDF, or audiobook tracks');
    await ctx.close();
  });

  test('cancelling before the upload leaves no book behind', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openUpload(page, club.id);
    await page.getByTestId('file-input').setInputFiles(ALICE_EPUB);
    await expect(page.getByTestId('upload-title')).toHaveValue("Alice's Adventures in Wonderland");
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const books = (await (await page.request.get(`/api/clubs/${club.id}/books`)).json()) as unknown[];
    expect(books).toHaveLength(0);
    await ctx.close();
  });
});
