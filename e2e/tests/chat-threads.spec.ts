import { type Page, expect, test } from '@playwright/test';
import type { ChatMessageView } from '@bookclub/shared';
import { browserAs, clubWithAlice, makeClub } from '../helpers/api';

/** One chat bubble, by the text it holds. */
const bubble = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });

test.describe('reply threading in chat (D200)', () => {
  test('a friend answers a message from its menu; the reply quotes it, and the quote and the thread lead back to it', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('chat-input').fill('Who is the White Rabbit late for?');
    await ana.getByTestId('chat-send').click();
    await expect(bubble(ana, 'Who is the White Rabbit late for?')).toBeVisible();

    await ben.goto(`/clubs/${club.id}/chat`);
    const question = bubble(ben, 'Who is the White Rabbit late for?');
    await question.getByTestId('chat-message-menu-btn').click();
    await question.getByTestId('chat-message-reply').click();
    await expect(ben.getByTestId('chat-reply-bar')).toContainText('Replying to Ana');
    await ben.getByTestId('chat-input').fill('The Duchess, I think');
    await ben.getByTestId('chat-input').press('Enter');
    await expect(ben.getByTestId('chat-reply-bar')).toHaveCount(0);

    // Live on Ana's screen: the reply, with its quote of her question, and a count under it.
    const answer = bubble(ana, 'The Duchess, I think');
    await expect(answer.getByTestId('chat-quote')).toContainText('Who is the White Rabbit late for?');
    await expect(bubble(ana, 'Who is the White Rabbit late for?').getByTestId('chat-replies')).toHaveText(/1 reply/);

    // A tap on the quote goes to the question, which glows.
    await answer.getByTestId('chat-quote').click();
    await expect(ana.locator('.chat-message.is-highlighted')).toContainText('Who is the White Rabbit late for?');

    // "1 reply" opens the thread on its own; answering there joins it.
    await bubble(ana, 'Who is the White Rabbit late for?').getByTestId('chat-replies').click();
    const thread = ana.getByTestId('chat-thread');
    await expect(thread.getByTestId('chat-message')).toHaveCount(2);
    await expect(ana.getByTestId('chat-thread-note')).toContainText('Replying in the thread');
    await ana.getByTestId('chat-input').fill('Of course, the Duchess!');
    await ana.getByTestId('chat-send').click();
    await expect(thread.getByTestId('chat-message')).toHaveCount(3);
    await ana.getByTestId('chat-thread-close').click();
    await expect(ana.getByTestId('chat-thread')).toHaveCount(0);
    await expect(bubble(ana, 'Who is the White Rabbit late for?').getByTestId('chat-replies')).toHaveText(/2 replies/);
    // Ben, too, sees the thread grow without a reload.
    await expect(bubble(ben, 'Of course, the Duchess!').getByTestId('chat-quote')).toContainText('Who is the White Rabbit late for?');

    await anaCtx.close();
    await benCtx.close();
  });

  test('a quote is gated exactly as the message it quotes: a friend not that far sees where it opens, never its words', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const mid = Math.max(1, Math.floor(geometry.sectionLengths.length / 2));
    const midLocator = { kind: 'epub' as const, section: mid, offset: 0 };
    const ana = club.members.Ana!;
    await ana.api.put(`/api/books/${book.id}/progress`, {
      data: { editionId: epub.id, locator: midLocator, readSpans: [{ from: { kind: 'epub', section: 0, offset: 0 }, to: midLocator }], at: Date.now() },
    });
    const bookPage = (await (await ana.api.get(`/api/books/${book.id}`)).json()) as { progress: { userId: string; t: number }[] };
    const anasPlace = bookPage.progress.find((p) => p.userId === ana.id)!.t;
    const fenced = (await (
      await ana.api.post(`/api/clubs/${club.id}/chat`, { data: { bookId: book.id, text: 'the Queen wants every head off', spoilerUpToT: anasPlace } })
    ).json()) as ChatMessageView;
    const answer = await ana.api.post(`/api/clubs/${club.id}/chat`, { data: { text: 'and nobody is ever beheaded', parentId: fenced.id } });
    expect(answer.ok()).toBe(true);

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    await ben.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    const reply = bubble(ben, 'and nobody is ever beheaded');
    await expect(reply.getByTestId('chat-quote')).toHaveAttribute('data-hidden', 'true');
    await expect(reply.getByTestId('chat-quote')).toContainText(/Spoiler up to/);
    await expect(ben.getByTestId('chat-panel')).not.toContainText('every head off');
    // The thread on its own shows him no more of it.
    await reply.getByTestId('chat-quote').click();
    await expect(ben.getByTestId('chat-panel')).not.toContainText('every head off');
    await expect(ben.locator('.chat-message.is-highlighted [data-testid="chat-spoiler-marker"]')).toBeVisible();
    await benCtx.close();
  });
});
