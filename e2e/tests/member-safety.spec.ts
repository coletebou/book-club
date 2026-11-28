import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SYNTHETIC_DIR, browserAs, clubWithAlice, makeClub, postComment, putProgress } from '../helpers/api';

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

test('a voice-only report shows its kind in the owner’s preview', async ({ browser }, testInfo) => {
  const club = await makeClub(['Ana', 'Ben']);
  const ana = club.members.Ana!;
  const ben = club.members.Ben!;
  const chat = `/api/clubs/${club.id}/chat`;
  const name = '01 - The Beginning.mp3';
  const response = await ben.api.post(`${chat}/attachments?kind=voice`, {
    multipart: { file: { name, mimeType: 'audio/mpeg', buffer: await readFile(path.join(SYNTHETIC_DIR, name)) } },
  });
  expect(response.status()).toBe(201);
  const clip = await response.json();
  expect(clip.status).toBe('ready');
  const posted = await ben.api.post(chat, { data: { attachmentIds: [clip.id] } });
  expect(posted.status()).toBe(201);
  const message = await posted.json();
  expect((await ana.api.post(`/api/clubs/${club.id}/reports`, { data: { kind: 'chat', targetId: message.id, reason: 'spam' } })).status()).toBe(204);
  expect((await club.owner.api.put(`/api/clubs/${club.id}/blocks/${ben.id}`, { data: {} })).status()).toBe(200);

  const context = await browserAs(browser, club.owner);
  try {
    const page = await context.newPage();
    await page.goto(`/clubs/${club.id}/settings`);
    await page.getByRole('button', { name: 'Review message' }).click();
    const preview = page.getByRole('dialog', { name: 'Reported item' });
    await expect(preview.getByText('Voice message', { exact: true })).toBeVisible();
    await expect(preview.locator('audio')).toHaveCount(0);
    await testInfo.attach('reported voice kind', { body: await preview.screenshot(), contentType: 'image/png' });
  } finally {
    await context.close();
  }
});

test('a member reports chat, a note and a reaction, then blocks and unblocks their author', async ({ browser }) => {
  const { club, book } = await clubWithAlice(['Ana', 'Ben']);
  const ana = club.members.Ana!;
  const ben = club.members.Ben!;
  const editionId = book.editions.find((edition) => edition.kind === 'epub')!.id;
  const at = (offset: number) => ({ kind: 'epub' as const, section: 0, offset });
  await putProgress(ana, book.id, editionId, at(30), [{ from: at(0), to: at(30) }]);
  await putProgress(club.owner, book.id, editionId, at(30), [{ from: at(0), to: at(30) }]);
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
    await owner.getByTestId('bell').click();
    const notifications = owner.getByTestId('notification').filter({ hasText: 'A member filed a content report' });
    await expect(notifications).toHaveCount(3);
    await notifications.first().click();
    await expect(owner).toHaveURL(/#club-reports-title$/);
    expect((await club.owner.api.put(`/api/clubs/${club.id}/blocks/${ben.id}`, { data: {} })).ok()).toBe(true);
    await reports.getByRole('button', { name: 'Review note' }).click();
    const preview = owner.getByRole('dialog', { name: 'Reported item' });
    await expect(preview).toContainText('Ben’s note for this demo');
    await preview.getByRole('button', { name: 'Close' }).click();

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
