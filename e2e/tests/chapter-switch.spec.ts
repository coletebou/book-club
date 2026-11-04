import { type Page, expect, test } from '@playwright/test';
import type { BookDetail, Edition, Publication } from '@bookclub/shared';
import { browserAs, clubWithAlice, putProgress, readAlong } from '../helpers/api';

/*
 * A format switch at a chapter's first page lands at that chapter in the other format (fidelity
 * review round 16, FR142; D93). A chapter's first words sit a hair apart in each format's map: the
 * EPUB's at its heading, the lined-up PDF's at its page's first printed line, the transcribed
 * audiobook's at the first word the recogniser matched, after the narrator's "Chapter six". A place
 * at the very start of a chapter in one format fell just before it in another: the audiobook played
 * the last seconds of the chapter before, the PDF opened on its last page.
 */

/** Where an edition's own text, page or track for chapter `i` starts, in its own measure. */
function ownStart(edition: Edition, i: number): number {
  return edition.units[edition.alignment.unitToChapter.indexOf(i)]!.m;
}

async function aliceInThreeFormats(names: string[]) {
  const { club, book: uploaded } = await clubWithAlice(names, { pdf: true, audio: 'librivox' });
  const book: BookDetail = await readAlong(club.owner, uploaded, uploaded.editions.find((e) => e.kind === 'audio')!.id);
  const [epub, pdf, audio] = (['epub', 'pdf', 'audio'] as const).map((kind) => book.editions.find((e) => e.kind === kind)!);
  const pub = (await (await club.owner.api.get(epub!.publicationUrl!)).json()) as Publication;
  // The story's chapters, by their place among the book's (after its front matter).
  const chapters = book.chapters.flatMap((c, i) => (c.title.startsWith('CHAPTER ') ? [{ i, title: c.title, entry: pub.toc.find((e) => (e.chapterTitle ?? e.title) === c.title)! }] : []));
  return { club, book, epub: epub!, pdf: pdf!, audio: audio!, chapters };
}

async function expectAudioAt(page: Page, bookId: string, track: number) {
  await page.goto(`/books/${bookId}/listen`);
  const listen = page.getByTestId('listen-page');
  await expect(listen).toHaveAttribute('data-track', String(track), { timeout: 15_000 });
  // At its start, not its end: the track's beginning, or where the narrator reads the chapter's
  // heading after LibriVox's preamble (the passage the EPUB's first page opens with).
  expect(Number(await listen.getAttribute('data-ms'))).toBeLessThan(45_000);
}

async function expectPdfAt(page: Page, bookId: string, pdfId: string, pageNumber: number) {
  await page.goto(`/books/${bookId}/read?edition=${pdfId}`);
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(pageNumber));
}

test.describe('a format switch at a chapter’s first page (D93)', () => {
  test('from the EPUB’s first page of Chapter VI, the headphones play Chapter VI, and the PDF opens on its first page', async ({ browser }) => {
    test.setTimeout(180_000);
    const { club, book, epub, pdf, audio, chapters } = await aliceInThreeFormats(['Ben']);
    const six = chapters.find((c) => c.title.startsWith('CHAPTER VI.'))!;
    const ctx = await browserAs(browser, club.members.Ben!);
    const page = await ctx.newPage();
    // As the reviewer did: the contents, Chapter VI, read from here, the headphones.
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.getByTestId('open-toc').click();
    await page.getByRole('dialog', { name: 'Contents' }).getByRole('button', { name: /^CHAPTER VI\./ }).click();
    await page.getByTestId('read-from-here').click();
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '1');
    // Listen over the page (D197): the audiobook from chapter VI's own start, not the last moments of V.
    await page.getByTestId('listen-here').click();
    const element = page.getByTestId('audio-element');
    await expect.poll(() => element.evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? ''), { timeout: 15_000 }).toMatch(new RegExp(`/tracks/${audio.alignment.unitToChapter.indexOf(six.i)}(\\?|$)`));
    await expect.poll(() => element.evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await element.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeLessThan(45);
    await expect(page.locator('.dock-heard')).toContainText('CHAPTER VI');
    await page.getByTestId('dock-stop').click();
    // And the PDF, from the same place.
    await expectPdfAt(page, book.id, pdf.id, Math.floor(ownStart(pdf, six.i)) + 1);
    await expect(page.locator('.reader-chapter')).toContainText('CHAPTER VI');
    await ctx.close();
  });

  test('from the EPUB’s first page of every chapter, the audiobook and the PDF open at that chapter', async ({ browser }) => {
    test.setTimeout(600_000);
    const { club, book, epub, pdf, audio, chapters } = await aliceInThreeFormats(['Ben']);
    expect(chapters).toHaveLength(12);
    const ben = club.members.Ben!;
    // Each format opened on a device of its own, which knows no place but the one the EPUB saved
    // (a page left behind saves its own place as it goes, and the newest place is the one opened).
    const fresh = async (check: (page: Page) => Promise<void>) => {
      const ctx = await browserAs(browser, ben);
      const page = await ctx.newPage();
      await check(page);
      // Left, as a page is: what it saves of its own place as it goes is in before the next place.
      await page.goto('about:blank');
      await page.waitForTimeout(1000);
      await ctx.close();
    };
    for (const c of chapters) {
      // The place the reader saves on a chapter's first page: where its file, and its heading, start.
      const first = { kind: 'epub' as const, section: c.entry.section, offset: c.entry.offset };
      await putProgress(ben, book.id, epub.id, first, [{ from: first, to: { ...first, offset: first.offset + 1 } }]);
      await fresh((page) => expectAudioAt(page, book.id, audio.alignment.unitToChapter.indexOf(c.i)));
      await putProgress(ben, book.id, epub.id, first, [{ from: first, to: { ...first, offset: first.offset + 1 } }]);
      await fresh((page) => expectPdfAt(page, book.id, pdf.id, Math.floor(ownStart(pdf, c.i)) + 1));
      // And from the start of the chapter's track (LibriVox's preamble, then its heading), the PDF too.
      const heard = { kind: 'audio' as const, track: audio.alignment.unitToChapter.indexOf(c.i), ms: 0 };
      await putProgress(ben, book.id, audio.id, heard, [{ from: heard, to: { ...heard, ms: 1000 } }]);
      await fresh((page) => expectPdfAt(page, book.id, pdf.id, Math.floor(ownStart(pdf, c.i)) + 1));
    }
  });
});
