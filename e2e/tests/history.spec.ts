import { type Page, expect, test } from '@playwright/test';
import type { Locator } from '@bookclub/shared';
import { browserAs, clubWithAlice, placeSaved, putProgress } from '../helpers/api';

/*
 * Your own reading and listening history (D191): real page turns in the reader and a stretch of
 * listening reported as the player reports it, then the History page's lines, a line opening the
 * book where that stretch began, the other format from the same line, and nobody else seeing any
 * of it.
 */

async function pageNumber(page: Page): Promise<number> {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  return Number(await page.getByTestId('page-number').getAttribute('data-page'));
}

test.describe('your reading history', () => {
  test('pages read and a stretch heard are lines by day; a line opens that place, in either format; only you see it', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number }[] };
    const ch1 = pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section;
    // Your place: the start of chapter I (nothing read yet).
    await putProgress(club.owner, book.id, epub.id, { kind: 'epub', section: ch1, offset: 0 }, []);

    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    const first = await pageNumber(page);
    for (let i = 0; i < 5; i++) {
      await page.getByTestId('next-page').click();
      await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(first + i + 1));
    }
    await placeSaved(page, book.id);

    // A stretch heard earlier today, as the player reports it: tracks 1 to 3 played through.
    const start = Date.now() - 2 * 3600_000;
    let since = start;
    for (const track of [0, 1, 2]) {
      const ms = audio.tracks[track]!.durationMs;
      const from: Locator = { kind: 'audio', track, ms: 0 };
      const to: Locator = { kind: 'audio', track, ms };
      // Wall time as at an eighth of the speed: the fixture's tracks are seconds long, a sitting is worth a line from twenty.
      const at = since + ms * 8;
      const res = await club.owner.api.put(`/api/books/${book.id}/progress`, { data: { editionId: audio.id, locator: to, readSpans: [{ from, to, since, at }], at } });
      expect(res.ok()).toBe(true);
      since = at;
    }

    await page.goto(`/books/${book.id}`);
    await page.getByTestId('open-history').click();
    await expect(page.getByTestId('history-page')).toBeVisible();
    const day = page.getByTestId('history-day').first();
    await expect(day.locator('h2')).toContainText('Today');
    await expect(day.getByTestId('history-day-total')).toContainText(/read/);
    await expect(page.getByTestId('history-total')).toContainText(/listened/);
    const read = page.locator('[data-testid="history-entry"][data-kind="epub"]');
    await expect(read).toHaveCount(1);
    await expect(read.getByTestId('history-title')).toHaveText(`Read pages ${first}–${first + 5}`);
    await expect(read.getByTestId('history-meta')).toContainText(/\d:\d\d.*·.*·/);
    const heard = page.locator('[data-testid="history-entry"][data-kind="audio"]');
    await expect(heard).toHaveCount(1);
    await expect(heard.getByTestId('history-title')).toHaveText(/^Listened 0:00–0:\d\d \(ch\. 1–3\)$/);

    // The line opens the book where that stretch began: a look, with a way back to your place.
    await read.getByTestId('history-open').click();
    await expect(page).toHaveURL(/\/read/);
    expect(await pageNumber(page)).toBe(first);
    await expect(page.getByTestId('back-to-reading')).toBeVisible();

    // The listening line's other format: the book, at the same place.
    await page.goto(`/books/${book.id}/history`);
    await heard.getByTestId('history-other').click();
    await expect(page).toHaveURL(/\/read/);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', /\d+/);
    // And the reading line's: the audiobook, at the same place, over the book's text (D198: a book
    // with a text has no audio-only screen unless Settings allows one; the link's place is kept).
    await page.goto(`/books/${book.id}/history`);
    await read.getByTestId('history-other').click();
    await expect(page).toHaveURL(/\/read/);
    expect(await pageNumber(page)).toBe(first);
    await expect(page.locator('.reader-dock')).toBeVisible();
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? '')).toMatch(/\/tracks\/0(\?|$)/);
    await expect(page.getByTestId('listen-page')).toHaveCount(0);
    // Put away at once: not heard long enough to be a line of its own in the history below.
    await page.getByTestId('dock-stop').click();
    await expect(page.locator('.reader-dock')).toHaveCount(0);

    // Across books too, from Settings.
    await page.goto('/settings');
    await page.getByTestId('open-all-history').click();
    await expect(page.getByTestId('history-entry')).toHaveCount(2);

    // Nobody else sees it: Ana's history of the same book is empty.
    const ana = await browserAs(browser, club.members.Ana!);
    const anaPage = await ana.newPage();
    await anaPage.goto(`/books/${book.id}/history`);
    await expect(anaPage.getByTestId('history-empty')).toBeVisible();
    await anaPage.goto('/history');
    await expect(anaPage.getByTestId('history-empty')).toBeVisible();
    await ana.close();

    // Forgetting a line.
    await page.goto(`/books/${book.id}/history`);
    await heard.getByTestId('history-forget').click();
    await page.getByRole('button', { name: 'Forget', exact: true }).click();
    await expect(heard).toHaveCount(0);
    await expect(read).toHaveCount(1);
    await ctx.close();
  });
});
