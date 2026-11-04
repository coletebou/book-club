import { expect, test } from '@playwright/test';
import type { WidgetSnapshot } from '@bookclub/shared';
import { browserAs, clubWithAlice, putProgress } from '../helpers/api';

/*
 * The iOS app's widgets and Live Activity, from the page's side (D188): inside the app the page
 * hands native a snapshot of your reading and your Live Activity choice; in a browser, nothing.
 * The app's bridge is stood in for, as native-bridge's unit tests do, by a `BookClubNative` that
 * keeps what it is sent.
 */

const NATIVE = () => {
  const w = window as unknown as { __native: unknown[]; BookClubNative: { postMessage(json: string): void } };
  w.__native = [];
  w.BookClubNative = { postMessage: (json: string) => void w.__native.push(JSON.parse(json)) };
};

test.describe('the iOS app’s widgets and Live Activity', () => {
  test('inside the app, the page sends your current book and the next stop for the widgets; the Live Activity is off until turned on', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await putProgress(club.owner, book.id, epub.id, { kind: 'epub', section: 6, offset: 0 }, []);
    const ctx = await browserAs(browser, club.owner);
    await ctx.addInitScript(NATIVE);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    const sent = () => page.evaluate(() => (window as unknown as { __native: { type: string }[] }).__native);
    await expect.poll(async () => (await sent()).find((m) => m.type === 'widgets'), { timeout: 15_000 }).toBeTruthy();
    const widgets = (await sent()).find((m) => m.type === 'widgets') as unknown as { snapshot: WidgetSnapshot; covers: Record<string, string> };
    expect(widgets.snapshot.current).toEqual(expect.objectContaining({ bookId: book.id, title: book.title, format: 'epub' }));
    expect(widgets.covers[book.id]).toMatch(/shape=square&w=384$/);
    expect((await page.request.get(widgets.covers[book.id]!)).status()).toBe(200);
    expect((await sent()).filter((m) => m.type === 'live-activity')).toEqual([{ type: 'live-activity', enabled: false }]);
    await page.goto('/settings');
    await page.getByTestId('live-activity').check();
    await expect.poll(async () => (await sent()).filter((m) => m.type === 'live-activity').at(-1)).toEqual({ type: 'live-activity', enabled: true });
    await ctx.close();
  });

  test('in a browser there is no Live Activity to choose, and the snapshot is yours alone', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await putProgress(club.members.Ana!, book.id, epub.id, { kind: 'epub', section: 8, offset: 0 }, []);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await expect(page.getByTestId('live-activity')).toHaveCount(0);
    const mine = (await (await page.request.get('/api/widget')).json()) as WidgetSnapshot;
    expect(mine.current).toBeNull(); // Ana's reading is not the owner's
    await ctx.close();
  });
});
