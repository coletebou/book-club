import { expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, putProgress } from '../helpers/api';

test.describe('the club bar', () => {
  test('tapping a friend’s marker says who it is and where, and tapping again closes it', async ({ browser }, testInfo) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    // Ana has read into chapter V.
    const place = { kind: 'epub' as const, section: 6, offset: 200 };
    await putProgress(club.members.Ana!, book.id, epub.id, place, [{ from: { ...place, offset: 0 }, to: place }]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const marker = page.locator(`[data-testid=member-marker][data-user="${club.members.Ana!.id}"]`).first();
    await expect(marker).toBeVisible();
    const touch = !!testInfo.project.use.hasTouch;
    const press = () => (touch ? marker.tap() : marker.click());
    await press();
    const tip = page.locator('.club-bar-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Ana');
    await expect(tip).toContainText('Chapter 5');
    // A tap (or a click) keeps it open; the next one closes it.
    if (!touch) await page.mouse.move(0, 0);
    await expect(tip).toBeVisible();
    await press();
    await expect(tip).toHaveCount(0);
    await ctx.close();
  });
});
