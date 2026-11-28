import { type Page, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';

async function openReader(page: Page, bookId: string) {
  await page.goto(`/books/${bookId}/read`);
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

async function openPausedPlayer(page: Page) {
  await page.getByTestId('listen-here').click();
  const dock = page.getByRole('group', { name: /^Now playing:/ });
  const play = dock.getByTestId('footer-play');
  await expect(play).toHaveAttribute('data-playing', 'true');
  await play.click();
  await expect(play).toHaveAttribute('data-playing', 'false');
  await dock.getByTestId('dock-expand').click();
  return page.getByRole('dialog', { name: 'Now in this book' });
}

test('two members can start and join listening together in the reader and keep playing after closing Now Playing', async ({ browser }) => {
  const { club, book } = await clubWithAlice(['Ana'], { audio: 'librivox' });
  const hostContext = await browserAs(browser, club.owner);
  const guestContext = await browserAs(browser, club.members.Ana!, { serviceWorkers: 'block' });
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    let unavailableVoiceChunk = false;
    await guest.route(/\/assets\/PartyVoiceSync-[^/]+\.js$/, async (route) => {
      unavailableVoiceChunk = true;
      await route.abort();
    });
    await Promise.all([openReader(host, book.id), openReader(guest, book.id)]);
    await guest.getByTestId('open-chat-sheet').click();
    const chat = guest.getByTestId('chat-sheet');
    await expect(chat.getByRole('button', { name: 'Join voice' })).toBeVisible();
    await guest.keyboard.press('Escape');
    await expect(chat).toHaveCount(0);

    const [hostSheet, guestSheet] = await Promise.all([openPausedPlayer(host), openPausedPlayer(guest)]);
    await hostSheet.getByRole('button', { name: 'Listen together' }).click();
    await expect(hostSheet.getByTestId('party-bar')).toHaveAttribute('data-joined', 'true');
    await guestSheet.getByTestId('party-join').click();
    const warn = guest.getByRole('button', { name: 'Join anyway' });
    const joined = guestSheet.locator('[data-testid="party-bar"][data-joined="true"]');
    await expect(warn.or(joined).first()).toBeVisible();
    if (await warn.isVisible()) await warn.click();
    await expect(joined).toBeVisible();
    await expect.poll(() => unavailableVoiceChunk).toBe(true);
    await expect(hostSheet.getByTestId('party-bar')).toContainText('with Ana');
    await expect(hostSheet.getByRole('button', { name: 'Chapters', exact: true })).toBeDisabled();

    await Promise.all([host.keyboard.press('Escape'), guest.keyboard.press('Escape')]);
    await expect(hostSheet).toHaveCount(0);
    await expect(guestSheet).toHaveCount(0);
    const hostPlay = host.getByTestId('footer-play');
    const guestPlay = guest.getByTestId('footer-play');
    await expect(hostPlay).toHaveAttribute('data-playing', 'false');
    const command = host.waitForRequest((request) => request.url().endsWith(`/api/books/${book.id}/party/control`) && request.method() === 'POST');
    await hostPlay.click();
    expect((await command).postDataJSON()).toMatchObject({ action: 'play' });
    await expect(guestPlay).toHaveAttribute('data-playing', 'true');
    const clock = (page: Page) => page.getByTestId('audio-element').evaluate((element: HTMLAudioElement) => ({ paused: element.paused, time: element.currentTime }));
    await expect.poll(async () => {
      const [a, b] = await Promise.all([clock(host), clock(guest)]);
      return !a.paused && !b.paused && Math.abs(a.time - b.time) < 1.5;
    }).toBe(true);
    await hostPlay.click();
    await expect(guestPlay).toHaveAttribute('data-playing', 'false');
    await expect.poll(async () => (await clock(guest)).paused).toBe(true);
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
