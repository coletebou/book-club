import { type Page, expect, test } from '@playwright/test';
import { browserAs, makeClub } from '../helpers/api';

const bubble = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });

async function editGrantMention(page: Page, draft: string) {
  const input = page.getByTestId('chat-input');
  await input.fill(draft);
  const beforeR = draft.indexOf('@') + 2;
  await input.evaluate((element: HTMLTextAreaElement, caret) => element.setSelectionRange(caret, caret), beforeR);
  await input.press('ArrowRight');
  return input;
}

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

  test('Enter picks at once when the name was put in whole (pasted, dictated, a phone’s suggestion)', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben Carter']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    const input = ana.getByTestId('chat-input');
    // fill() puts the text in as a paste does: no key is pressed for it, so the caret moves unseen.
    await input.fill('@ben');
    await expect(ana.getByTestId('chat-mention-picker')).toBeVisible();
    await input.press('Enter');
    await expect(input).toHaveValue('@Ben ');
    await expect(ana.getByTestId('chat-mention-picker')).toHaveCount(0);
    // The Enter picked; it sent nothing.
    await expect(ana.getByTestId('chat-message')).toHaveCount(0);
    await anaCtx.close();
  });

  test('replacing a known multi-word mention at the caret preserves the following sentence', async ({ browser }, testInfo) => {
    const club = await makeClub(['Grant Lee', 'Grant Smith']);
    const context = await browserAs(browser, club.owner);
    try {
      const page = await context.newPage();
      await page.goto(`/clubs/${club.id}/chat`);
      const draft = 'Please ask @Grant Smith before the meeting.';
      const input = await editGrantMention(page, draft);
      const options = page.getByTestId('chat-mention-option');
      await expect(options).toHaveText(['GLGrant Lee', 'GSGrant Smith']);
      await input.press('Tab');

      const picked = 'Please ask @Grant Lee before the meeting.';
      await expect(input).toHaveValue(picked);
      await expect(input).toBeFocused();
      expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(picked.indexOf('before'));
      await testInfo.attach('mention replaced at the caret', { body: await page.getByTestId('chat-composer').screenshot(), contentType: 'image/png' });
      await input.press('Enter');

      const mention = bubble(page, picked).getByTestId('chat-mention');
      await expect(mention).toHaveText('@Grant Lee');
      await expect(mention).toHaveAttribute('data-mention-user', club.members['Grant Lee']!.id);
    } finally {
      await context.close();
    }
  });

  test('editing a known mention preserves punctuation and resolves the selected member before sending', async ({ browser }) => {
    const club = await makeClub(['Grant', 'Grant Lee', 'Grant Smith']);
    const context = await browserAs(browser, club.owner);
    try {
      const page = await context.newPage();
      await page.goto(`/clubs/${club.id}/chat`);
      const pick = (name: string) => page.getByTestId('chat-mention-option').filter({ has: page.getByText(name, { exact: true }) }).click();

      const input = await editGrantMention(page, 'Please ask @Grant Smith. Then call.');
      await pick('Grant Lee');
      await expect(input).toHaveValue('Please ask @Grant Lee. Then call.');
      await editGrantMention(page, 'Please pick up @Grant Smith’s book.');
      await pick('Grant Lee');
      await expect(input).toHaveValue('Please pick up @Grant Lee’s book.');

      await editGrantMention(page, 'Please tell @Grant Smith Lee is arriving.');
      await pick('Grant');
      await expect(input).toHaveValue('Please tell @Grant  Lee is arriving.');
      await input.press('Enter');
      const mention = bubble(page, 'Lee is arriving.').getByTestId('chat-mention');
      await expect(mention).toHaveText('@Grant');
      await expect(mention).toHaveAttribute('data-mention-user', club.members.Grant!.id);
    } finally {
      await context.close();
    }
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
