import { type Page, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, makeClub, putProgress } from '../helpers/api';

/**
 * Cal in the club's chat (D204). The stack runs his deterministic stand-in mind (CAL_TEST_FAKE_MODEL,
 * docs/DEPLOY.md: real spoiler gate, real search, real citations; only the model's reasoning
 * faked), slowed a little in chat (CAL_TEST_FAKE_MODEL_DELAY_MS) so that "Cal is typing" can be seen.
 */

const bubble = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });
const calSays = (page: Page) => page.locator('[data-testid="chat-message"][data-agent="cal"]');

test.describe('Cal in chat (D204)', () => {
  test('a friend asks @cal in a book’s channel: Cal is typing, then answers in the thread, hidden from anyone not as far', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const start = { kind: 'epub' as const, section: 0, offset: 0 };
    const mid = { kind: 'epub' as const, section: Math.max(1, Math.floor(geometry.sectionLengths.length / 2)), offset: 0 };
    const last = geometry.sectionLengths.length - 1;
    const end = { kind: 'epub' as const, section: last, offset: geometry.sectionLengths[last]! };
    await putProgress(club.members.Ana!, book.id, epub.id, mid, [{ from: start, to: mid }]);

    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    const input = ana.getByTestId('chat-input');
    // He is offered as a name is, with what he is and what he does, before anything is sent.
    await input.fill('@ca');
    const cal = ana.getByTestId('chat-mention-option').filter({ hasText: 'Cal' });
    await expect(cal).toContainText('@cal');
    await expect(cal.getByTestId('chat-mention-about')).toContainText('AI librarian');
    await input.press('Enter');
    await expect(input).toHaveValue('@cal ');
    await input.pressSequentially('What does the White Rabbit say?');
    await input.press('Enter');
    await expect(bubble(ana, '@cal What does the White Rabbit say?')).toBeVisible();
    await expect(bubble(ana, '@cal What does the White Rabbit say?').getByTestId('chat-mention')).toHaveText('@cal');

    // While he works, everyone in the channel sees him at it.
    await expect(ana.getByTestId('chat-typing')).toHaveText('Cal is typing…');
    const answer = calSays(ana);
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await expect(ana.getByTestId('chat-typing')).toHaveText('');
    await expect(answer).toContainText('Here is what the shelf says. [1]');
    await expect(answer).toContainText("[1] Alice's Adventures in Wonderland");
    await expect(answer.getByTestId('chat-agent-badge')).toHaveText('AI');
    await expect(answer.getByTestId('chat-quote')).toContainText('What does the White Rabbit say?');
    // Fenced at Ana's place, and open to her.
    await expect(answer).toContainText(/Spoiler up to/);
    await expect(bubble(ana, '@cal What does the White Rabbit say?').getByTestId('chat-replies')).toHaveText(/1 reply/);

    // Ben has read nothing yet: where it opens, never its words.
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    await ben.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    await expect(calSays(ben)).toHaveAttribute('data-hidden', 'true');
    await expect(calSays(ben).getByTestId('chat-spoiler-marker')).toContainText(/Spoiler up to/);
    await expect(ben.getByTestId('chat-panel')).not.toContainText('Here is what the shelf says');
    // Once he has read as far, it is his to read too.
    await putProgress(club.members.Ben!, book.id, epub.id, end, [{ from: start, to: end }]);
    await ben.reload();
    await ben.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    await expect(calSays(ben)).toContainText('Here is what the shelf says. [1]');

    await anaCtx.close();
    await benCtx.close();
  });

  test('in General he answers for everyone at once, and draws on no book there', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('chat-input').fill('@cal what should we read next?');
    await ana.getByTestId('chat-send').click();

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    const answer = calSays(ben);
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await expect(answer).toHaveAttribute('data-hidden', 'false');
    await expect(answer).toContainText("I couldn't find anything about that");
    await expect(answer).not.toContainText(/Spoiler up to/);
    await expect(answer.getByTestId('chat-quote')).toContainText('what should we read next?');
    await anaCtx.close();
    await benCtx.close();
  });
});
