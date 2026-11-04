import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { BookDetail, EpubLocator } from '@bookclub/shared';
import { ALICE_TINY_DIR, FIXTURES, aliceEpub, audioFolder, browserAs, clubWithAlice, makeClub, putProgress, uploadBook } from '../helpers/api';

/*
 * Fidelity review round 15: a novel that numbers its chapters afresh in each part (Gutenberg's
 * Crime and Punishment, #2554), the front matter of an EPUB added to an audiobook, and listening
 * from the page (D86).
 */
const CRIME = { name: 'pg2554.epub', path: path.join(FIXTURES, 'books/crime-gutenberg-2554.epub'), type: 'application/epub+zip', role: 'main' as const };

async function ready(page: Page) {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

test.describe('a book in parts, front matter and listening from the page (D86)', () => {
  test('a novel in parts names each chapter with its part: the stops to choose, the stop chosen, a friend’s place', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const book = await uploadBook(club.owner, club.id, 'epub', [CRIME], { title: 'Crime and Punishment', author: 'Fyodor Dostoyevsky' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const toc = ((await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number; offset: number }[] }).toc;
    const entry = (part: string, chapter: string): EpubLocator => {
      const p = toc.findIndex((e) => e.title === part);
      const c = toc.findIndex((e, i) => i > p && e.title === chapter);
      return { kind: 'epub', section: toc[c]!.section, offset: toc[c]!.offset };
    };
    // Ana has read to Part I's third chapter.
    const third = entry('PART I', 'CHAPTER III');
    await putProgress(club.members.Ana!, book.id, epub.id, { ...third, offset: third.offset + 200 }, [{ from: entry('PART I', 'CHAPTER I'), to: { ...third, offset: third.offset + 200 } }]);
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.getByTestId('meeting-set').click();
    const dialog = page.getByRole('dialog', { name: 'The next stop' });
    const options = (await dialog.getByTestId('meeting-stop').locator('option').allTextContents()).map((o) => o.split(' · ')[0]!);
    expect(options).toContain('The end of Part 1, Chapter 1');
    expect(options).toContain('The end of Part 2, Chapter 1');
    expect(new Set(options).size).toBe(options.length);
    await dialog.getByTestId('meeting-stop').selectOption({ index: options.indexOf('The end of Part 2, Chapter 1') });
    await dialog.getByTestId('meeting-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('meeting-headline')).toHaveText('The end of Part 2, Chapter 1');
    // She is in Part I: not there, and the book page says where she is with its part.
    const row = page.locator(`[data-testid="meeting-member"][data-user="${club.members.Ana!.id}"]`);
    await expect(row).toHaveAttribute('data-there', 'false');
    await expect(page.locator(`[data-testid="member-progress"][data-user="${club.members.Ana!.id}"]`)).toContainText('Part 1, Chapter 3');
    // And the reader's heading names the part over the chapter.
    await page.goto(`/books/${book.id}/read`);
    await ready(page);
    await expect(page.locator('.reader-chapter')).toHaveText(/^Part 1 · CHAPTER III/);
    // Its contents list Part I over its chapters, as they list the parts after it, the chapter she is in marked.
    await page.getByTestId('open-toc').click();
    const contents = page.getByRole('dialog', { name: 'Contents' });
    const entries = (await contents.locator('.toc-item > span:first-child').allTextContents()).map((t) => t.replace(' (ahead of you)', ''));
    expect(entries.slice(0, 3)).toEqual(['TRANSLATOR’S PREFACE', 'PART I', 'CHAPTER I']);
    expect(entries.filter((t) => /^PART [IV]+$/.test(t))).toEqual(['PART I', 'PART II', 'PART III', 'PART IV', 'PART V', 'PART VI']);
    const current = contents.locator('.toc-item[aria-current="true"]');
    await expect(current).toHaveCount(1);
    expect(await contents.locator('.toc-item').evaluateAll((items) => items.findIndex((b) => b.getAttribute('aria-current') === 'true'))).toBe(entries.indexOf('CHAPTER III'));
    await ctx.close();
    // Opened at its start, the book is before Part 1's first chapter, the part's own title page too.
    const owner = await browserAs(browser, club.owner);
    const start = await owner.newPage();
    await start.goto(`/books/${book.id}/read`);
    await ready(start);
    await expect(start.locator('.reader-chapter')).toHaveText('Before Part 1, Chapter 1');
    await owner.close();
  });

  test('an EPUB added to an audiobook keeps its title page and contents before the story, and counts no chapter there', async ({ browser }) => {
    const club = await makeClub([]);
    let book: BookDetail = await uploadBook(club.owner, club.id, 'audio', audioFolder(ALICE_TINY_DIR), { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: book.title, author: book.author, bookId: book.id });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    await expect(page.locator('.reader-chapter')).toHaveText('Before Chapter 1');
    await expect(page.getByTestId('chapter-page')).toBeHidden();
    // The contents start with the story, and end before the licence.
    await page.getByTestId('open-toc').click();
    const contents = page.getByRole('dialog', { name: 'Contents' });
    await expect(contents.getByRole('button').filter({ hasText: /CHAPTER I\. Down the Rabbit-Hole/ })).toHaveCount(1);
    await expect(contents.getByRole('button').filter({ hasText: /THE MILLENNIUM FULCRUM|LICENSE|^Contents/ })).toHaveCount(0);
    await ctx.close();
  });

  test('a new member opening an EPUB at its start is before the story on every page of its front matter, no chapter counted', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await ready(page);
    // The title page, then the contents: neither is a chapter's page.
    for (const n of ['1', '2']) {
      await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', n);
      await expect(page.locator('.reader-chapter')).toHaveText('Before Chapter 1');
      await expect(page.getByTestId('chapter-page')).toBeHidden();
      if (n === '1') await page.getByTestId('next-page').click();
    }
    await ctx.close();
  });

  test('from the page, the headphones open the audiobook where you are reading', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ben'], { audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const toc = ((await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number }[] }).toc;
    const third = toc.find((e) => e.title.startsWith('CHAPTER III.'))!.section;
    await putProgress(club.members.Ben!, book.id, epub.id, { kind: 'epub', section: third, offset: 300 }, [{ from: { kind: 'epub', section: third, offset: 0 }, to: { kind: 'epub', section: third, offset: 300 } }]);
    const ctx = await browserAs(browser, club.members.Ben!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', String(third));
    // Listen over the page (D197). Chapter III is the third track.
    await page.getByTestId('listen-here').click();
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? ''), { timeout: 15_000 }).toMatch(new RegExp(`/media/editions/${audio.id}/tracks/2(\\?|$)`));
    await ctx.close();
  });

  test('a row of stars between scenes stays one line, inside its page, at the largest type', async ({ browser }) => {
    const club = await makeClub([]);
    const book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const toc = ((await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number }[] }).toc;
    const first = toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section;
    await putProgress(club.owner, book.id, epub.id, { kind: 'epub', section: first, offset: 0 }, [{ from: { kind: 'epub', section: first, offset: 0 }, to: { kind: 'epub', section: first, offset: 1 } }]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', String(first));
    await page.getByTestId('open-settings').click();
    while (await page.getByTestId('font-larger').isEnabled()) {
      const before = await page.getByTestId('font-scale').textContent();
      await page.getByTestId('font-larger').click();
      await expect(page.getByTestId('font-scale')).not.toHaveText(before!);
    }
    await expect(page.getByTestId('font-scale')).toHaveText('200%');
    await page.keyboard.press('Escape');
    await ready(page);
    const frame = (await (await page.locator('iframe.epub-frame').elementHandle()).contentFrame())!;
    // Chapter I has two such breaks, each three rows of seven or six stars.
    const rows = await frame.evaluate(() => {
      const column = parseFloat(getComputedStyle(document.documentElement).columnWidth);
      return [...document.querySelectorAll('[data-bc-asterism]')].flatMap((el) =>
        [...el.childNodes]
          .filter((n): n is Text => n instanceof Text && n.data.includes('*'))
          .map((t) => {
            const range = document.createRange();
            range.selectNodeContents(t);
            const boxes = [...range.getClientRects()].filter((r) => r.width > 0);
            return { lines: new Set(boxes.map((r) => Math.round(r.top))).size, width: Math.max(...boxes.map((r) => r.right)) - Math.min(...boxes.map((r) => r.left)), column };
          }),
      );
    });
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.lines).toBe(1);
      expect(row.width).toBeLessThanOrEqual(row.column);
    }
    await ctx.close();
  });
});
