import { expect, test, type Locator, type Page } from '@playwright/test';
import { browserAs, clubWithAlice, postComment, putProgress } from '../helpers/api';

async function sendReport(page: Page, button: Locator, subject: string) {
  await button.click();
  const dialog = page.getByRole('dialog', { name: `Report ${subject}` });
  await expect(dialog.getByRole('button', { name: 'Send report' })).toBeDisabled();
  await dialog.getByLabel('Reason').selectOption('harassment');
  await dialog.getByLabel('Details (optional)').fill(`Please review this ${subject}.`);
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Report sent to the club owner.').last()).toBeVisible();
}

test('a member reports chat, a note and a reaction, then blocks and unblocks their author', async ({ browser }) => {
  const { club, book } = await clubWithAlice(['Ana', 'Ben']);
  const ana = club.members.Ana!;
  const ben = club.members.Ben!;
  const editionId = book.editions.find((edition) => edition.kind === 'epub')!.id;
  const at = (offset: number) => ({ kind: 'epub' as const, section: 0, offset });
  await putProgress(ana, book.id, editionId, at(30), [{ from: at(0), to: at(30) }]);
  const note = await postComment(ben, book.id, { editionId, locator: at(3), text: 'Ben’s note for this demo' });
  const reaction = await postComment(ben, book.id, { editionId, locator: at(10), reaction: '❤️' });
  await postComment(club.owner, book.id, { editionId, locator: at(5), text: 'An unaffected note' });
  const chatPath = `/api/clubs/${club.id}/chat`;
  expect((await ben.api.post(chatPath, { data: { text: 'Ben’s message for this demo' } })).status()).toBe(201);
  expect((await club.owner.api.post(chatPath, { data: { text: 'An unaffected message' } })).status()).toBe(201);

  const ctx = await browserAs(browser, ana);
  const ownerCtx = await browserAs(browser, club.owner);
  try {
    const chat = await ctx.newPage();
    await chat.goto(`/clubs/${club.id}/chat`);
    const bubble = chat.getByTestId('chat-message').filter({ hasText: 'Ben’s message for this demo' });
    await bubble.getByTestId('chat-message-menu-btn').click();
    await sendReport(chat, bubble.getByRole('button', { name: 'Report message' }), 'message');

    const notes = await ctx.newPage();
    await notes.goto(`/books/${book.id}`);
    const benNote = notes.locator(`[data-comment="${note.id}"]`);
    const benReaction = notes.locator(`[data-comment="${reaction.id}"]`);
    await expect(benNote).toContainText('Ben’s note for this demo');
    await sendReport(notes, benNote.getByRole('button', { name: 'Report note' }), 'note');
    await sendReport(notes, benReaction.getByRole('button', { name: 'Report reaction' }), 'reaction');

    const owner = await ownerCtx.newPage();
    await owner.goto(`/clubs/${club.id}/settings`);
    const reports = owner.getByRole('region', { name: 'Content reports' });
    await expect(reports.getByText(/^Please review this /)).toHaveCount(3);
    await expect(reports.getByText('Ben’s note for this demo')).toHaveCount(0);

    const search = await ctx.newPage();
    let missedBlock = false;
    let dropBlock = true;
    let reconnectSearch: (() => void) | undefined;
    await search.routeWebSocket('**/ws', (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const { type } = JSON.parse(message.toString()) as { type: string };
        if (type === 'moderation:blocks' && dropBlock) missedBlock = true;
        else socket.send(message);
      });
      reconnectSearch = () => void socket.close({ code: 1001 });
    });
    await search.goto(`/clubs/${club.id}`);
    await search.getByRole('button', { name: 'Search', exact: true }).click();
    await search.getByRole('combobox', { name: 'Search this club' }).fill('for this demo');
    const matches = search.getByRole('option');
    await expect(matches).toHaveCount(2);

    await bubble.getByTestId('chat-message-menu-btn').click();
    await bubble.getByTestId('chat-message-reply').click();
    await expect(chat.getByTestId('chat-reply-bar')).toContainText('Ben’s message for this demo');
    await bubble.getByTestId('chat-message-menu-btn').click();
    await bubble.getByRole('button', { name: 'Block member' }).click();
    const confirmation = chat.getByRole('alertdialog', { name: 'Block Ben?' });
    await confirmation.getByRole('button', { name: 'Block member' }).click();
    await expect(chat.getByText('Blocked Ben. You can unblock them in Settings.')).toBeVisible();
    await expect(bubble).toHaveCount(0);
    await expect(chat.getByTestId('chat-reply-bar')).toHaveCount(0);
    await expect(chat.getByText('An unaffected message')).toBeVisible();
    await expect(benNote).toHaveCount(0);
    await expect(benReaction).toHaveCount(0);
    await expect(notes.getByText('An unaffected note')).toBeVisible();
    // A second device can miss the change. Reconnecting takes a fresh account block snapshot.
    await expect.poll(() => missedBlock).toBe(true);
    await expect(matches).toHaveCount(2);
    dropBlock = false;
    reconnectSearch?.();
    await expect(search.getByText('No matches.', { exact: true })).toBeVisible();
    await expect(matches).toHaveCount(0);

    const settings = await ctx.newPage();
    await settings.goto('/settings');
    await settings.getByRole('button', { name: 'Unblock Ben' }).click();
    await expect(settings.getByText('You haven’t blocked anyone.')).toBeVisible();
    await expect(bubble).toBeVisible();
    await expect(benNote).toBeVisible();
    await expect(benReaction).toBeVisible();
    await expect(matches).toHaveCount(2);
  } finally {
    await Promise.all([ctx.close(), ownerCtx.close()]);
  }
});

test('playing through two saved reactions announces only the unblocked member', async ({ browser }) => {
  const { club, book } = await clubWithAlice(['Ana', 'Ben'], { audio: 'librivox' });
  const ana = club.members.Ana!;
  const ben = club.members.Ben!;
  const editionId = book.editions.find((edition) => edition.kind === 'audio')!.id;
  const at = (ms: number) => ({ kind: 'audio' as const, track: 0, ms });
  await putProgress(club.owner, book.id, editionId, at(0), [{ from: at(0), to: at(5_000) }]);
  await postComment(ben, book.id, { editionId, locator: at(1_000), reaction: '❤️' });
  await postComment(ana, book.id, { editionId, locator: at(2_000), reaction: '😂' });
  expect((await club.owner.api.put(`/api/clubs/${club.id}/blocks/${ben.id}`, { data: {} })).status()).toBe(200);

  const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
  try {
    const page = await ctx.newPage();
    const notices: string[] = [];
    await page.exposeFunction('recordReactionNotice', (text: string) => { notices.push(text); });
    await page.addInitScript(() => {
      const record = (window as Window & { recordReactionNotice?: (text: string) => void }).recordReactionNotice;
      new MutationObserver((records) => {
        for (const mutation of records) {
          for (const node of mutation.addedNodes) {
            if (node instanceof HTMLElement && node.textContent?.includes(' reacted ')) record?.(node.textContent);
          }
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`/books/${book.id}/listen`);
    await page.getByTestId('play-pause').click();
    await expect(page.getByText('Ana reacted 😂')).toBeVisible();
    await expect.poll(() => notices.some((message) => message.includes('Ana reacted 😂'))).toBe(true);
    expect(notices.some((message) => message.includes('Ben reacted ❤️'))).toBe(false);
  } finally {
    await ctx.close();
  }
});
