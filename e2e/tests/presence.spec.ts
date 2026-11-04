import { expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';

test.describe('presence: reading alone together', () => {
  test('a friend sees who is online and who is reading, live', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const watcher = await browserAs(browser, club.members.Ana!);
    const w = await watcher.newPage();
    await w.goto(`/clubs/${club.id}`);
    const owner = w.getByTestId('presence-member').filter({ hasText: 'Olive' });
    await expect(owner).toHaveAttribute('data-status', 'away');

    const reader = await browserAs(browser, club.owner);
    const r = await reader.newPage();
    await r.goto(`/books/${book.id}/read`);
    await expect(r.getByTestId('page-number')).toBeVisible();
    await expect(owner).toHaveAttribute('data-status', 'reading', { timeout: 2000 });
    await expect(owner).toContainText('reading now');

    await reader.close();
    await expect(owner).toHaveAttribute('data-status', 'away', { timeout: 10_000 });
    await watcher.close();
  });

  test("a friend's marker moves on my screen within two seconds of their page turn", async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(ana.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });

    const oliveCtx = await browserAs(browser, club.owner);
    const olive = await oliveCtx.newPage();
    await olive.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(olive.getByTestId('page-number')).toBeVisible();
    const marker = ana.locator(`[data-testid=member-marker][data-user="${club.owner.id}"]`);
    await expect(marker).toHaveAttribute('data-live', 'true', { timeout: 2000 });
    const before = Number(await marker.getAttribute('data-t'));

    // Olive goes to chapter IV from the contents and reads on: her marker follows within two seconds
    // of the page turn that is reading there (the third: chapter IV is past where she has read, D72).
    await olive.getByTestId('open-toc').click();
    await olive.getByRole('button', { name: /CHAPTER IV\./ }).click();
    await expect(olive.getByTestId('chapter-page')).toHaveAttribute('data-page', '1', { timeout: 30_000 });
    for (const n of ['2', '3']) {
      await olive.getByTestId('next-page').click();
      await expect(olive.getByTestId('chapter-page')).toHaveAttribute('data-page', n);
    }
    await olive.getByTestId('next-page').click();
    const started = Date.now();
    await expect.poll(async () => Number(await marker.getAttribute('data-t')), { timeout: 2000, intervals: [50] }).toBeGreaterThan(before + 0.1);
    expect(Date.now() - started).toBeLessThan(2000);

    const mid = Number(await marker.getAttribute('data-t'));
    await olive.getByTestId('next-page').click();
    await expect.poll(async () => Number(await marker.getAttribute('data-t')), { timeout: 2000, intervals: [50] }).toBeGreaterThan(mid);
    await anaCtx.close();
    await oliveCtx.close();
  });

  test("a listener shows within two seconds of pressing play, and their marker keeps moving as they listen", async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { audio: 'tiny' });
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/books/${book.id}`);
    const marker = ana.locator(`[data-testid=member-marker][data-user="${club.members.Ben!.id}"]`);

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}/listen`);
    const pressed = Date.now();
    await ben.getByTestId('play-pause').click();
    await expect(marker).toHaveAttribute('data-live', 'true', { timeout: 2000 });
    expect(Date.now() - pressed).toBeLessThan(2000);
    await expect.poll(() => ben.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 10_000 }).toBeGreaterThan(0);
    // While Ben listens, his marker on Ana's screen moves at least every two seconds.
    let last = Number(await marker.getAttribute('data-t'));
    for (let i = 0; i < 2; i++) {
      await expect.poll(async () => Number(await marker.getAttribute('data-t')), { timeout: 2000, intervals: [100] }).toBeGreaterThan(last);
      last = Number(await marker.getAttribute('data-t'));
    }
    await anaCtx.close();
    await benCtx.close();
  });

  test('saved progress of members who are not online still shows on the bar', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await club.members.Ben!.api.put(`/api/books/${book.id}/progress`, {
      data: {
        editionId: epub.id,
        locator: { kind: 'epub', section: 7, offset: 0 },
        readSpans: [{ from: { kind: 'epub', section: 2, offset: 0 }, to: { kind: 'epub', section: 7, offset: 0 } }],
        at: Date.now(),
      },
    });
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const ben = page.locator(`[data-testid=member-marker][data-user="${club.members.Ben!.id}"]`);
    await expect(ben).toHaveAttribute('data-live', 'false');
    expect(Number(await ben.getAttribute('data-t'))).toBeGreaterThan(0.3);
    await expect(page.getByTestId('member-progress').filter({ hasText: 'Ben' })).toContainText('Chapter 6');
    await ctx.close();
  });
});
