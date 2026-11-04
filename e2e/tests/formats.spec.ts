import { expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, postComment, placeSaved } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

test.describe('more formats on the same timeline', () => {
  test('a note made in the PDF appears at the matching place in the EPUB', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    // Chapter VII starts on its own page in the PDF (outline entry); comment at its top.
    const ch7 = pdf.units.find((u) => u.title.startsWith('CHAPTER VII.'))!;
    const note = await postComment(club.owner, book.id, { editionId: pdf.id, locator: { kind: 'pdf', page: Math.floor(ch7.m), y: 0.1 }, text: 'Tea party in the PDF', reaction: '😂' });
    const i = book.chapters.findIndex((c) => c.title.startsWith('CHAPTER VII.'));
    expect(note.t).toBeGreaterThanOrEqual(book.chapters[i]!.t - 1e-9);
    expect(note.t).toBeLessThan(book.chapters[i + 1]!.t);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}&at=${note.t}`);
    await expect(page.locator('.reader-chapter')).toContainText('A Mad Tea-Party', { timeout: 30_000 });
    await expect(page.getByTestId('margin-marker').filter({ hasText: '😂' })).toBeVisible();
    await ctx.close();
  });

  test('switching from the EPUB to the PDF lands in the same chapter', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER X\./ }).click();
    await expect(page.locator('.reader-chapter')).toContainText('Lobster Quadrille');
    // Reading on there makes it the place (a chapter from the contents is a look until then;
    // past where you have read, until three pages are read there: D72).
    for (let i = 0; i < 3; i++) await page.getByTestId('next-page').click();
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await placeSaved(page, book.id);
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.locator('.reader-chapter')).toContainText('Lobster Quadrille', { timeout: 30_000 });
    await ctx.close();
  });

  test('audio saved for offline plays and seeks with no network', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await expect.poll(async () => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20_000 }).toBe(true);
    await page.reload();
    const audioRow = page.getByTestId('edition').filter({ hasText: 'Audiobook' });
    await audioRow.getByTestId('offline-toggle').click();
    await expect(audioRow.getByTestId('offline-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await page.goto(`/books/${book.id}/listen`);
    await expect(page.getByTestId('play-pause')).toBeVisible();
    await ctx.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('play-pause')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('next-track').click();
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await page.getByTestId('scrubber').fill('2');
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(1.9);
    await ctx.setOffline(false);
    await ctx.close();
  });
});

test.describe('a book’s formats on its page', () => {
  test('the owner deletes one format from its menu; the book and its other formats stay', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { pdf: true });
    // A member reads the book page without the owner's tools.
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/books/${book.id}`);
    await expect(ana.getByTestId('edition')).toHaveCount(2);
    await expect(ana.getByTestId('format-menu')).toHaveCount(0);
    await anaCtx.close();

    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const pdfRow = page.getByTestId('edition').filter({ hasText: 'PDF' });
    await pdfRow.getByTestId('format-menu').click();
    await expect(pdfRow.getByRole('button', { name: 'Match to chapters' })).toBeVisible();
    await pdfRow.getByRole('button', { name: 'Delete the PDF' }).click();
    await answerQuestion(page, `Delete the PDF of “${book.title}”?`, 'Delete');
    await expect(page.getByTestId('edition')).toHaveCount(1);
    await expect(page.getByTestId('edition')).toHaveAttribute('data-kind', 'epub');
    await expect(page.getByTestId('open-epub')).toBeVisible();
    await ctx.close();
  });
});

test.describe('the book page on a phone', () => {
  test('fits the screen, the owner’s format menus and buttons included', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny', pdf: true });
    for (const width of [393, 375]) {
      const ctx = await browserAs(browser, club.owner, { viewport: { width, height: 700 }, hasTouch: true, isMobile: true });
      const page = await ctx.newPage();
      await page.goto(`/books/${book.id}`);
      await expect(page.getByTestId('edition')).toHaveCount(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `width ${width}`).toBeLessThanOrEqual(width);
      for (const testId of ['open-epub', 'open-pdf', 'open-audio']) await expect(page.getByTestId(testId)).toBeInViewport({ ratio: 1 });
      for (const row of await page.getByTestId('edition').all()) {
        const box = (await row.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      await ctx.close();
    }
  });
});
