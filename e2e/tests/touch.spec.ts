import { type Page, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, postComment, putProgress } from '../helpers/api';

async function pageNumber(page: Page): Promise<number> {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  return Number(await page.getByTestId('page-number').getAttribute('data-page'));
}

test.describe('reading with a finger', () => {
  test('a tap on the right of the page turns it, on the left goes back, in the middle shows or hides the controls', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    // A touch screen in both projects: taps are real touch events, not mouse clicks.
    const ctx = await browserAs(browser, club.owner, { hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    const start = await pageNumber(page);
    const box = (await page.locator('.epub-viewport').boundingBox())!;
    const y = box.y + box.height / 2;
    await page.touchscreen.tap(box.x + box.width * 0.9, y);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(start + 1));
    await page.touchscreen.tap(box.x + box.width * 0.9, y);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(start + 2));
    await page.touchscreen.tap(box.x + box.width * 0.1, y);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(start + 1));
    await page.touchscreen.tap(box.x + box.width * 0.5, y);
    await expect(page.getByTestId('reader')).toHaveClass(/chrome-hidden/);
    await page.touchscreen.tap(box.x + box.width * 0.5, y);
    await expect(page.getByTestId('reader')).not.toHaveClass(/chrome-hidden/);
    await ctx.close();
  });

  // @chromium-only: Playwright can send a moving touch (a swipe) only through Chromium's
  // DevTools protocol; WebKit gets taps alone (see docs/RUNBOOK.md).
  test('a swipe turns the page, and the next tap still works @chromium-only', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner, { hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    const start = await pageNumber(page);
    const box = (await page.locator('.epub-viewport').boundingBox())!;
    const cdp = await ctx.newCDPSession(page);
    const y = Math.round(box.y + box.height / 2);
    const swipe = async (fromX: number, toX: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y }] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(fromX + ((toX - fromX) * i) / 8), y }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(Math.round(box.x + box.width * 0.7), Math.round(box.x + box.width * 0.2));
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(start + 1));
    await swipe(Math.round(box.x + box.width * 0.2), Math.round(box.x + box.width * 0.7));
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(start));
    // The gesture left nothing behind: the next tap turns the page.
    await page.touchscreen.tap(box.x + box.width * 0.9, y);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(start + 1));
    await ctx.close();
  });

  test('the PDF opens with its first page drawn, text and all, before any page turn', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner, { hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.locator('.pdf-text span').first()).toBeAttached({ timeout: 30_000 });
    const canvas = page.locator('.pdf-page canvas');
    await expect.poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(300);
    // Something was painted: the canvas is not one flat colour.
    const varied = await canvas.evaluate((c: HTMLCanvasElement) => {
      const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < data.length && seen.size < 3; i += 4 * 97) seen.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
      return seen.size;
    });
    expect(varied).toBeGreaterThan(1);
    // A tap on the right of the page turns it, as in the EPUB.
    const before = Number(await page.getByTestId('reader').getAttribute('data-page-index'));
    const box = (await page.locator('.pdf-area').boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.92, box.y + box.height / 2);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-page-index', String(before + 1));
    await ctx.close();
  });

  test('a tap that turns the PDF page does not also open a note the next page has under the finger', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const place = { kind: 'pdf' as const, page: 20, y: 0 };
    await putProgress(club.owner, book.id, pdf.id, place, [{ from: { kind: 'pdf', page: 0, y: 0 }, to: place }]);
    // On the next page, half-way down: where the marker sits, at the page's right edge, is where a
    // finger taps to turn the page.
    await postComment(club.owner, book.id, { editionId: pdf.id, locator: { kind: 'pdf', page: 21, y: 0.5 }, text: 'Down the hole', reaction: '🤯' });
    // A phone in both projects: the page fills the screen's width, its right edge under the thumb.
    const ctx = await browserAs(browser, club.owner, { hasTouch: true, viewport: { width: 393, height: 740 } });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-page-index', '20', { timeout: 30_000 });
    await expect(page.locator('.pdf-text span').first()).toBeAttached({ timeout: 30_000 });
    await expect(page.getByTestId('margin-marker')).toHaveCount(0);
    const sheet = page.getByTestId('marker-sheet');
    const box = (await page.locator('.pdf-page').boundingBox())!;
    await page.touchscreen.tap(box.x + box.width - 22, box.y + box.height / 2);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-page-index', '21');
    await expect(page.getByTestId('margin-marker')).toHaveCount(1);
    // Long enough for the tap's click to have landed, had it gone through.
    await page.waitForTimeout(1000);
    await expect(sheet).toHaveCount(0);
    // The marker itself still opens with a tap of its own.
    const marker = (await page.getByTestId('margin-marker').boundingBox())!;
    await page.touchscreen.tap(marker.x + marker.width / 2, marker.y + marker.height / 2);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('sheet-note-text')).toHaveText('Down the hole');
    await ctx.close();
  });

  test('going to a note in the audiobook is a visit: Play makes it your place, Back returns', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    // Ana is listening in chapter 6; Olive's note at the start of chapter 2 is one she has heard.
    await putProgress(club.members.Ana!, book.id, audio.id, { kind: 'audio', track: 5, ms: 2000 }, [
      { from: { kind: 'audio', track: 0, ms: 0 }, to: { kind: 'audio', track: 5, ms: 2000 } },
    ]);
    await postComment(club.owner, book.id, { editionId: audio.id, locator: { kind: 'audio', track: 1, ms: 500 }, text: 'Pool of tears!' });
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen`);
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '5', { timeout: 20_000 });
    // A note you have heard, tapped on the bar: you go there to hear it, as a visit.
    await page.getByTestId('bar-comment').first().click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 6');
    await page.keyboard.press('Escape');
    await page.getByTestId('back-to-reading').click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '5');
    await expect(page.getByTestId('back-to-reading')).toHaveCount(0);

    // Visit again and press Play there: listening there makes it your place.
    await page.getByTestId('bar-comment').first().click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('back-to-reading')).toHaveCount(0);
    await page.waitForTimeout(1200);
    await page.getByTestId('play-pause').click();
    await expect
      .poll(async () => ((await (await page.request.get(`/api/books/${book.id}/progress`)).json()) as { mine: { locator: { track: number } } }).mine.locator.track, { timeout: 20_000 })
      .toBe(1);
    await ctx.close();
  });
});
