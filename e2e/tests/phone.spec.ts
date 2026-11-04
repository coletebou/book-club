import { expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';

/*
 * A sheet on a phone sits in the part of the screen still seen (D88): with the keyboard up, iOS
 * shortens only the visual viewport, and a sheet fixed to the page's bottom had its Post button
 * under the keys. Playwright shows no keyboard, so the screen is made shorter instead: the sheet
 * follows the visual viewport, its Post button inside what is seen.
 */
test.describe('a sheet on a phone (D88)', () => {
  test('the note composer keeps to the part of the screen still seen, its Post button in it', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}&at=0.2`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.getByTestId('add-note').click();
    await page.getByTestId('note-text').click();
    await page.getByTestId('note-text').fill('Curiouser and curiouser!');
    const fit = () =>
      page.evaluate(() => {
        const backdrop = document.querySelector<HTMLElement>('.modal-backdrop')!;
        const post = document.querySelector<HTMLElement>('[data-testid="note-submit"]')!.getBoundingClientRect();
        const view = window.visualViewport!;
        return { seen: backdrop.style.getPropertyValue('--seen-height'), height: `${Math.round(view.height)}px`, postBottom: post.bottom, seenBottom: view.offsetTop + view.height, sheet: backdrop.getBoundingClientRect().bottom };
      });
    const before = await fit();
    expect(before.seen).toBe(before.height);
    expect(before.postBottom).toBeLessThanOrEqual(before.seenBottom);
    // A shorter screen, as with the keyboard up: the sheet follows, its Post button still seen.
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.55) });
    await expect.poll(async () => (await fit()).seen).toBe(`${Math.round(size.height * 0.55)}px`);
    const after = await fit();
    expect(after.sheet).toBeLessThanOrEqual(after.seenBottom + 1);
    // The sheet scrolls within what is seen; scrolled to its end, Post is there to press.
    await page.getByTestId('note-submit').scrollIntoViewIfNeeded();
    const post = (await page.getByTestId('note-submit').boundingBox())!;
    expect(post.y + post.height).toBeLessThanOrEqual(after.seenBottom + 1);
    await page.getByTestId('note-submit').click();
    await expect(page.getByRole('dialog', { name: 'Leave a note' })).toHaveCount(0);
    await ctx.close();
  });
});
