import { type Page, expect, test } from '@playwright/test';
import { browserAs, makeClub } from '../helpers/api';

const bubble = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });

test.describe('@-mentions in chat (D201)', () => {
  test('typing @ offers club members; a pick writes the name, the bubble highlights it, and it is marked for the one it names', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben Carter', 'Grant Smith', 'Grant Lee']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    const input = ana.getByTestId('chat-input');
    await input.fill('Quick question @gr');
    const picker = ana.getByTestId('chat-mention-picker');
    await expect(picker.getByTestId('chat-mention-option')).toHaveText(['GLGrant Lee', 'GSGrant Smith']);
    // Ana is never offered herself.
    await input.fill('Quick question @a');
    await expect(picker.getByTestId('chat-mention-option').filter({ hasText: /^AAna$/ })).toHaveCount(0);
    await input.fill('Quick question @gr');
    await input.press('ArrowDown');
    await input.press('Enter');
    // "Grant" alone names two people: the whole name is written.
    await expect(input).toHaveValue('Quick question @Grant Smith ');
    await input.pressSequentially('and @ben');
    await picker.getByTestId('chat-mention-option').filter({ hasText: 'Ben Carter' }).click();
    await expect(input).toHaveValue('Quick question @Grant Smith and @Ben ');
    await input.pressSequentially('are you two coming?');
    await input.press('Enter');
    const sent = bubble(ana, 'are you two coming?');
    await expect(sent.getByTestId('chat-mention')).toHaveText(['@Grant Smith', '@Ben']);

    // On Ben's screen the message is marked as naming him, and his name stands out.
    const benCtx = await browserAs(browser, club.members['Ben Carter']!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    const seen = bubble(ben, 'are you two coming?');
    await expect(seen).toHaveAttribute('data-mentions-me', 'true');
    await expect(seen.locator('[data-testid="chat-mention"][data-me="true"]')).toHaveText('@Ben');

    // Grant Lee was not named (the ambiguous "Grant" was never written): nothing in his bell.
    const lee = club.members['Grant Lee']!;
    const bell = (await (await lee.api.get('/api/notifications')).json()) as { items: { kind: string }[] };
    expect(bell.items.some((n) => n.kind === 'mention')).toBe(false);
    await anaCtx.close();
    await benCtx.close();
  });

  test('the mention in the bell lands on the message itself', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben']);
    const ana = club.members.Ana!;
    // Enough after it that the message would be well off screen were the chat simply opened.
    await ana.api.post(`/api/clubs/${club.id}/chat`, { data: { text: '@Ben the croquet ground is ready' } });
    for (let i = 0; i < 25; i++) await ana.api.post(`/api/clubs/${club.id}/chat`, { data: { text: `filler message ${i}` } });

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}`);
    await ben.getByTestId('bell').click();
    await ben.getByTestId('notification').filter({ hasText: 'Ana mentioned you' }).first().click();
    await expect(ben).toHaveURL(new RegExp(`/clubs/${club.id}/chat\\?message=`));
    const target = ben.locator('.chat-message.is-highlighted');
    await expect(target).toContainText('the croquet ground is ready');
    await expect(target).toBeInViewport();
    await benCtx.close();
  });
});
