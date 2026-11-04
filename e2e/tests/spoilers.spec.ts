import { type Page, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, postComment, placeSaved } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

async function openAt(page: Page, bookId: string, editionId: string, t?: number) {
  await page.goto(`/books/${bookId}/read?edition=${editionId}${t !== undefined ? `&at=${t}` : ''}`);
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

/** Select the first sentence of the current page inside the book frame. */
async function selectOnPage(page: Page) {
  const frame = (await (await page.locator('iframe.epub-frame').elementHandle()).contentFrame())!;
  const start = Number(await page.getByTestId('reader').getAttribute('data-start'));
  await frame.evaluate((offset) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let at = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const visible = t.data.trim().length > 20;
      if (at + t.data.length > offset && visible) {
        const from = Math.max(0, offset - at) + (t.data.slice(Math.max(0, offset - at)).search(/\S/) || 0);
        const range = document.createRange();
        range.setStart(t, from);
        range.setEnd(t, Math.min(t.data.length, from + 30));
        const sel = document.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      at += t.data.length;
    }
  }, start);
}

test.describe('comments and reactions, without spoilers', () => {
  test('a reaction pinned to a passage reaches a friend only as a marker until they get there', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    // Cole reads into chapter VI and reacts to a passage there.
    const cole = await browserAs(browser, club.owner);
    const colePage = await cole.newPage();
    await openAt(colePage, book.id, epub.id, 0.45);
    await selectOnPage(colePage);
    await expect(colePage.getByTestId('selection-menu')).toBeVisible();
    await colePage.getByTestId('note-from-selection').click();
    await colePage.getByTestId('note-text').fill('The Duchess and her pepper: I laughed out loud');
    await colePage.getByRole('button', { name: 'Shocked' }).click();
    await colePage.getByTestId('note-submit').click();
    await expect(colePage.getByTestId('margin-marker')).toHaveCount(1);
    await expect(colePage.getByTestId('margin-marker')).toHaveAttribute('data-hidden', 'false');

    // Ana has only read the beginning: she sees who reacted and the emoji, never the words.
    const ana = await browserAs(browser, club.members.Ana!);
    const anaPage = await ana.newPage();
    await anaPage.goto(`/books/${book.id}`);
    const note = anaPage.getByTestId('note').first();
    await expect(note).toHaveAttribute('data-hidden', 'true');
    await expect(note).toContainText('😱');
    await expect(note).toContainText('You will see it when you get there');
    await expect(anaPage.getByText('The Duchess and her pepper')).toHaveCount(0);
    const api = (await (await anaPage.request.get(`/api/books/${book.id}/comments`)).json()) as { hidden: boolean; text?: string; quote?: string; approx?: boolean }[];
    expect(api[0]!.hidden).toBe(true);
    expect(api[0]!.text).toBeUndefined();
    expect(api[0]!.quote).toBeUndefined();
    // Nor its exact place, its passage there to be looked up: only roughly (D80).
    expect(api[0]!.approx).toBe(true);
    await expect(anaPage.getByTestId('bar-comment')).toHaveAttribute('data-hidden', 'true');

    // She goes to that page and reads there: the marker in the margin opens the note. (Gone to by
    // a link, far past where she has read, it is a look until she says she reads there: D72.)
    await openAt(anaPage, book.id, epub.id, 0.45);
    const marker = anaPage.getByTestId('margin-marker');
    await expect(marker).toHaveCount(1);
    await marker.click();
    await anaPage.getByTestId('sheet-read-here').click();
    await expect(anaPage.getByTestId('sheet-note-text')).toHaveText('The Duchess and her pepper: I laughed out loud', { timeout: 10_000 });
    await anaPage.keyboard.press('Escape');
    await anaPage.goto(`/books/${book.id}`);
    await expect(anaPage.getByTestId('note').first()).toHaveAttribute('data-hidden', 'false');
    await cole.close();
    await ana.close();
  });

  test('jumping ahead through the contents does not reveal the chapters skipped', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: 5, offset: 400 }, text: 'Chapter four secret', reaction: '🤯' });
    const ana = await browserAs(browser, club.members.Ana!);
    const page = await ana.newPage();
    await openAt(page, book.id, epub.id);
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER IX\./ }).click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true');
    // Reading on there (three pages: chapter IX is past where she has read, D72) is saved (Ana's
    // place is now chapter IX), and still the skipped note stays closed.
    for (let i = 0; i < 3; i++) await page.getByTestId('next-page').click();
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await placeSaved(page, book.id);
    const comments = (await (await page.request.get(`/api/books/${book.id}/comments`)).json()) as { hidden: boolean; t: number }[];
    expect(comments[0]!.hidden).toBe(true);
    const ranges = ((await (await page.request.get(`/api/books/${book.id}/progress`)).json()) as { mine: { readRanges: [number, number][] } }).mine.readRanges;
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every(([a, b]) => b <= comments[0]!.t || a > comments[0]!.t)).toBe(true);
    await ana.close();
  });

  test('a reaction without words is a spoiler-free marker on the club bar', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: 10, offset: 200 }, reaction: '😢' });
    const ben = await browserAs(browser, club.members.Ben!);
    const page = await ben.newPage();
    await openAt(page, book.id, epub.id);
    const barNote = page.getByTestId('bar-comment');
    await expect(barNote).toHaveText('😢');
    await expect(barNote).toHaveAttribute('data-hidden', 'true');
    await expect(barNote).toHaveAttribute('aria-label', /reacted 😢 ahead of you/);
    await ben.close();
  });

  test('your own notes are always yours to read and delete', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await openAt(page, book.id, epub.id);
    await page.getByTestId('add-note').click();
    await page.getByTestId('note-text').fill('Starting tonight!');
    await page.getByTestId('note-submit').click();
    await page.goto(`/books/${book.id}`);
    const note = page.getByTestId('note').filter({ hasText: 'Starting tonight!' });
    await expect(note).toHaveAttribute('data-hidden', 'false');
    // Asked first: a stray tap keeps the note (no delete is sent; the one below is the only one).
    const deletes: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'DELETE' && r.url().includes('/api/comments/')) deletes.push(r.url());
    });
    await note.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Delete your note?' })).toHaveAccessibleDescription('It goes for everyone in the club.');
    await answerQuestion(page, 'Delete your note?', 'Keep');
    await expect(note).toBeVisible();
    await note.getByRole('button', { name: 'Delete' }).click();
    await answerQuestion(page, 'Delete your note?', 'Delete');
    await expect(page.getByText('Starting tonight!')).toHaveCount(0);
    expect(deletes).toHaveLength(1);
    await ctx.close();
  });

  test('a comment cannot be written without a position (v1 bug) and lands where it was written', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openAt(page, book.id, epub.id, 0.3);
    const section = Number(await page.getByTestId('reader').getAttribute('data-section'));
    const start = Number(await page.getByTestId('reader').getAttribute('data-start'));
    await page.getByTestId('add-note').click();
    await page.getByTestId('note-text').fill('Pinned here');
    await page.getByTestId('note-submit').click();
    await expect(page.getByTestId('margin-marker')).toHaveCount(1);
    const comments = (await (await page.request.get(`/api/books/${book.id}/comments`)).json()) as { locator: { section: number; offset: number }; t: number }[];
    expect(comments[0]!.locator).toEqual({ kind: 'epub', section, offset: start });
    expect(comments[0]!.t).toBeGreaterThan(0.25);
    await ctx.close();
  });

  test('a new comment appears live on a friend’s screen, gated for them', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ana = await browserAs(browser, club.members.Ana!);
    const page = await ana.newPage();
    await page.goto(`/books/${book.id}`);
    await expect(page.getByText('No notes yet')).toBeVisible();
    // Live: the page's connection is up (it subscribes to the club as it connects).
    await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
    await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: 8, offset: 100 }, text: 'Off with their heads', reaction: '😡' });
    const note = page.getByTestId('note').first();
    await expect(note).toBeVisible({ timeout: 5000 });
    await expect(note).toHaveAttribute('data-hidden', 'true');
    await expect(page.getByText('Off with their heads')).toHaveCount(0);
    await ana.close();
  });
});
