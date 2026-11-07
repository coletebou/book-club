import { type Page, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, makeClub, putProgress } from '../helpers/api';

/**
 * Agents of other services in the club's chat (D205). The stack names one, Lux, in every club,
 * played by the stand-in agent (tools/fake-agent, the demo stack's `agent` service): it checks
 * each delivery's signature itself, says it is typing, and answers in the thread through Book
 * Club's agent API ("Lux here. I read: …"); a message holding "[fail]" it refuses, every time.
 */

/** Where the stand-in says what it was sent (GET /deliveries). */
const AGENT = process.env.E2E_AGENT_URL ?? 'http://127.0.0.1:47103';

interface Delivery {
  readonly verified: boolean;
  readonly event: string | null;
  readonly body: { club: { id: string }; channel: { kind: string }; message: { text: string; author: { name: string } }; thread: { text: string }[] } | null;
}

const bubble = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });
const luxSays = (page: Page) => page.locator('[data-testid="chat-message"][data-agent="lux"]');

async function deliveriesFor(clubId: string): Promise<Delivery[]> {
  const all = (await (await fetch(`${AGENT}/deliveries`)).json()) as Delivery[];
  return all.filter((d) => d.body?.club.id === clubId);
}

test.describe('agents of other services in chat (D205)', () => {
  test('a friend asks @lux: it gets the message, signed, and answers in the thread as a bot', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    const input = ana.getByTestId('chat-input');
    // Offered as a name is, with its own mark and where a message naming it goes, before anything is sent.
    await input.fill('@lu');
    const lux = ana.getByTestId('chat-mention-option').filter({ hasText: 'Lux' });
    await expect(lux).toContainText('@lux');
    await expect(lux.locator('.chat-agent-avatar')).toHaveText('🦊');
    await expect(lux.getByTestId('chat-mention-about')).toContainText('outside Book Club');
    await input.press('Enter');
    await expect(input).toHaveValue('@lux ');
    await input.pressSequentially('could the chat show who reacted?');
    await input.press('Enter');
    await expect(bubble(ana, '@lux could the chat show who reacted?').getByTestId('chat-mention')).toHaveText('@lux');

    // The stand-in answers through the agent API: in the thread, as itself.
    const answer = luxSays(ana);
    await expect(answer).toContainText('Lux here. I read: “@lux could the chat show who reacted?”', { timeout: 20_000 });
    await expect(answer.getByTestId('chat-agent-badge')).toHaveText('Bot');
    await expect(answer.getByTestId('chat-quote')).toContainText('could the chat show who reacted?');
    await expect(bubble(ana, '@lux could the chat show who reacted?').getByTestId('chat-replies')).toHaveText(/1 reply/);

    // What it was sent: signed (it checked), from Ana, in General.
    const [delivery] = await deliveriesFor(club.id);
    expect(delivery).toMatchObject({ verified: true, event: 'chat.mention', body: { channel: { kind: 'general' }, message: { text: '@lux could the chat show who reacted?', author: { name: 'Ana' } } } });

    // Ben sees the same answer, live.
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    await expect(luxSays(ben)).toContainText('Lux here.');
    await anaCtx.close();
    await benCtx.close();
  });

  test('the composer says a message will leave Book Club before it goes; a follow-up in its thread goes to it, and is answered', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    const input = ana.getByTestId('chat-input');
    const note = ana.getByTestId('chat-outside-note');
    await input.fill('@lux could the chat show who reacted?');
    await expect(note).toHaveText('Sent to Lux, outside Book Club');
    await input.fill('just the club, this one');
    await expect(note).toHaveCount(0);
    await input.fill('@lux could the chat show who reacted?');
    await input.press('Enter');
    await expect(luxSays(ana)).toContainText('Lux here.', { timeout: 20_000 });

    // In its thread, the follow-up answers Lux: said in the reply bar, and that it leaves Book Club.
    await bubble(ana, '@lux could the chat show who reacted?').getByTestId('chat-replies').click();
    await expect(ana.getByTestId('chat-reply-bar')).toContainText('Replying to Lux');
    await expect(note).toHaveText('Sent to Lux, outside Book Club');
    await input.fill('and who read it?');
    await input.press('Enter');
    // Delivered to it as any message naming it is, and answered in the thread.
    await expect(luxSays(ana).filter({ hasText: 'I read: “and who read it?”' })).toHaveCount(1, { timeout: 20_000 });
    await anaCtx.close();
  });

  test('while the club’s agents cannot be looked up, a message that may name one waits; one that names none goes', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    // No service worker, so its copy of the list cannot stand in for the lookup that fails.
    const anaCtx = await browserAs(browser, club.members.Ana!, { serviceWorkers: 'block' });
    const ana = await anaCtx.newPage();
    await ana.route('**/api/clubs/*/chat/agents', (route) => route.abort());
    await ana.goto(`/clubs/${club.id}/chat`);
    const input = ana.getByTestId('chat-input');
    const note = ana.getByTestId('chat-outside-note');
    await input.fill('@lux could the chat show who reacted?');
    await expect(note).toHaveText('Waiting to learn whether @lux is an agent outside Book Club before this is sent');
    await input.press('Enter');
    await expect(input).toHaveValue('@lux could the chat show who reacted?');
    await input.fill('just the club, this one');
    await expect(note).toHaveCount(0);
    await input.press('Enter');
    await expect(bubble(ana, 'just the club, this one')).toBeVisible();
    await expect(bubble(ana, 'could the chat show who reacted?')).toHaveCount(0);
    expect(await deliveriesFor(club.id)).toHaveLength(0);
    await anaCtx.close();
  });

  test('when it cannot be reached, only the friend who asked is told', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('chat-input').fill('@lux [fail] please');
    await ana.getByTestId('chat-send').click();
    // Tried three times (1 s, then 4 s apart), then said, to Ana alone.
    await expect(ana.getByTestId('toasts')).toContainText('Lux could not be reached', { timeout: 20_000 });
    await expect(bubble(ben, '@lux [fail] please')).toBeVisible();
    await expect(ben.getByTestId('toasts')).not.toContainText('could not be reached');
    await expect(luxSays(ana)).toHaveCount(0);
    expect((await deliveriesFor(club.id)).length).toBe(3);
    await anaCtx.close();
    await benCtx.close();
  });

  test('its answer to a fenced question in a book’s channel is hidden from a friend not as far', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const start = { kind: 'epub' as const, section: 0, offset: 0 };
    const mid = { kind: 'epub' as const, section: Math.max(1, Math.floor(geometry.sectionLengths.length / 2)), offset: 0 };
    await putProgress(club.members.Ana!, book.id, epub.id, mid, [{ from: start, to: mid }]);

    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    // Ana is ahead of Ben: her message is fenced at her place (the composer's own suggestion).
    await expect(ana.getByTestId('chat-spoiler-toggle')).toBeChecked();
    await ana.getByTestId('chat-input').fill('@lux the trial scene needs a reaction picker');
    await ana.getByTestId('chat-send').click();
    await expect(luxSays(ana)).toContainText('Lux here.', { timeout: 20_000 });
    await expect(luxSays(ana)).toContainText(/Spoiler up to/);

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    await ben.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    await expect(luxSays(ben)).toHaveAttribute('data-hidden', 'true');
    await expect(ben.getByTestId('chat-panel')).not.toContainText('the trial scene');
    await anaCtx.close();
    await benCtx.close();
  });

  test('its answer to an open question is still fenced when what it was sent with the question was', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const start = { kind: 'epub' as const, section: 0, offset: 0 };
    const mid = { kind: 'epub' as const, section: Math.max(1, Math.floor(geometry.sectionLengths.length / 2)), offset: 0 };
    await putProgress(club.members.Ana!, book.id, epub.id, mid, [{ from: start, to: mid }]);

    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    const input = ana.getByTestId('chat-input');
    const fence = ana.getByTestId('chat-spoiler-toggle');
    // First a spoiler, fenced at her place; then a question about the app, open to everyone.
    await fence.check();
    await input.fill('The Hatter’s riddle never gets an answer!');
    await ana.getByTestId('chat-send').click();
    await expect(bubble(ana, 'The Hatter’s riddle never gets an answer!')).toBeVisible();
    await fence.uncheck();
    await input.fill('@lux could chat show a reading-progress badge?');
    await ana.getByTestId('chat-send').click();
    // The question starts a conversation, so the channel's last messages went with it, the spoiler too.
    const answer = luxSays(ana);
    await expect(answer).toContainText('(1 earlier in the conversation)', { timeout: 20_000 });
    await expect(answer).toContainText(/Spoiler up to/);

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    await ben.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    // Ben may read the question (a person's message; Lux's answer quotes it too), not the answer: it could carry what was fenced.
    const question = ben.locator('[data-testid="chat-message"]:not([data-agent])').filter({ hasText: 'could chat show a reading-progress badge?' });
    await expect(question).toHaveAttribute('data-hidden', 'false');
    await expect(luxSays(ben)).toHaveAttribute('data-hidden', 'true');
    await expect(ben.getByTestId('chat-panel')).not.toContainText('Hatter');
    await anaCtx.close();
    await benCtx.close();
  });
});
