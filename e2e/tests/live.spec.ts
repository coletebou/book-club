import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { answerQuestion } from '../helpers/confirm';
import { browserAs, clubWithAlice } from '../helpers/api';

/** Lower the party's auto-pause thresholds so the e2e tone-emitting fake mic trips it quickly. */
async function lowerAutoPauseThresholds(hostApi: APIRequestContext, bookId: string): Promise<void> {
  await hostApi.post(`/api/books/${bookId}/party/control`, {
    data: { action: 'settings', settings: { autoPause: true, autoPauseSensitivityMs: 300, autoResume: true, autoResumeAfterMs: 500, rewindOnResumeMs: 0 } },
  });
}

test.describe('live chat (D150-D152)', () => {
  test('a message round-trips to a friend, who sees an unread badge until they read it', async ({ browser }) => {
    const { club } = await clubWithAlice(['Ana', 'Ben']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('chat-input').fill('hello Ben, @Ben look here');
    await ana.getByTestId('chat-send').click();
    await expect(ana.getByTestId('chat-message').filter({ hasText: 'hello Ben' })).toBeVisible();

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}`);
    await expect(ben.getByTestId('chat-unread-badge')).toHaveText('1', { timeout: 5000 });
    await ben.getByTestId('open-chat').click();
    await expect(ben.getByTestId('chat-message').filter({ hasText: 'hello Ben' })).toBeVisible();

    // The mention notified him (D152).
    const bell = await ben.request.get('/api/notifications');
    const notifications = (await bell.json()) as { items: { kind: string; text: string | null }[] };
    expect(notifications.items.some((n) => n.kind === 'mention')).toBe(true);

    await ben.goto(`/clubs/${club.id}`);
    await expect(ben.getByTestId('chat-unread-badge')).toHaveCount(0);
    await anaCtx.close();
    await benCtx.close();
  });

  test('typing shows to a friend, and a spoiler-fenced message stays hidden until they read that far', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    // Ana has read partway in; Ben, fresh, has not — so the default fence (her own place) hides
    // this message from him, and the test proves the hiding, not a trivial fence at t=0.
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const mid = Math.max(1, Math.floor(geometry.sectionLengths.length / 2));
    const midLocator = { kind: 'epub' as const, section: mid, offset: 0 };
    await club.members.Ana!.api.put(`/api/books/${book.id}/progress`, {
      data: { editionId: epub.id, locator: midLocator, readSpans: [{ from: { kind: 'epub', section: 0, offset: 0 }, to: midLocator }], at: Date.now() },
    });

    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ben.goto(`/clubs/${club.id}/chat`);
    // Both chat pages subscribe to the club over the hub on mount; give that round trip a moment
    // before relying on an ephemeral, one-shot event like typing (unlike a stored message, a
    // missed typing event is never resent).
    await expect(ben.getByTestId('chat-composer')).toBeVisible();
    await ana.waitForTimeout(500);

    await ana.getByTestId('chat-input').fill('typing a long thought');
    await expect(ben.getByTestId('chat-typing')).toContainText('Ana', { timeout: 5000 });

    // The book-tagged channel is a chip (D173), not a `<select>`: tapping it switches the view and the
    // composer onto that book's channel (D199).
    await ana.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    await ana.getByTestId('chat-spoiler-toggle').check();
    await ana.getByTestId('chat-input').fill('the ending is wild');
    await ana.getByTestId('chat-send').click();
    await expect(ana.getByTestId('chat-message').filter({ hasText: 'the ending is wild' })).toBeVisible();

    // A book's chip is its own channel (D199): the message is not in General, only in the book's.
    await expect(ben.getByTestId('chat-message').filter({ hasText: /Spoiler up to/ })).toHaveCount(0, { timeout: 5000 });
    await ben.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    const fenced = ben.getByTestId('chat-message').filter({ hasText: /Spoiler up to/ });
    await expect(fenced).toBeVisible({ timeout: 5000 });
    await expect(fenced.getByTestId('chat-spoiler-marker')).toBeVisible();
    await expect(fenced).not.toContainText('the ending is wild');
    await anaCtx.close();
    await benCtx.close();
  });

  test('editing and deleting your own message through the overflow menu (D173)', async ({ browser }) => {
    const { club } = await clubWithAlice(['Ana']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('chat-input').fill('a first draft');
    await ana.getByTestId('chat-send').click();
    const message = ana.getByTestId('chat-message').filter({ hasText: 'a first draft' });
    await expect(message).toBeVisible();

    await message.getByTestId('chat-message-menu-btn').click();
    await expect(message.getByTestId('chat-message-menu')).toBeVisible();
    await message.getByTestId('chat-message-edit').click();
    // Editing swaps the bubble's text for a `<textarea>` (ChatPanel.tsx): `message`, filtered by
    // its old text, no longer matches once that text is gone, so the rest of this step is found
    // unscoped instead (there is only one message being edited at a time).
    await ana.locator('.chat-edit textarea').fill('a better draft');
    await ana.getByRole('button', { name: 'Save' }).click();
    await expect(ana.getByTestId('chat-message').filter({ hasText: 'a better draft' })).toBeVisible();

    const edited = ana.getByTestId('chat-message').filter({ hasText: 'a better draft' });
    await edited.getByTestId('chat-message-menu-btn').click();
    await edited.getByTestId('chat-message-delete').click();
    // A delete with no replies is dropped from the live view entirely (lib/queries.ts
    // `removeChatMessage`), not shown as a "Message deleted" placeholder — that placeholder is
    // only for a page fetched fresh, when the deleted message still has replies under it.
    await expect(ana.getByTestId('chat-message').filter({ hasText: 'a better draft' })).toHaveCount(0);
    await anaCtx.close();
  });
});

test.describe('the reader/player chat sheet, and Do Not Disturb (D173)', () => {
  test('a header button opens club chat and voice over the book, with an unread badge', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;

    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('chat-input').fill('hello from the club');
    await ana.getByTestId('chat-send').click();
    await expect(ana.getByTestId('chat-message').filter({ hasText: 'hello from the club' })).toBeVisible();

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(ben.getByTestId('open-chat-sheet').getByTestId('chat-unread-badge')).toHaveText('1', { timeout: 5000 });

    await ben.getByTestId('open-chat-sheet').click();
    const sheet = ben.getByTestId('chat-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('chat-message').filter({ hasText: 'hello from the club' })).toBeVisible();
    await expect(sheet.getByTestId('voice-bar')).toBeVisible();
    // Reading is still going on underneath: this is a sheet, not a navigation away from the book.
    await expect(ben).toHaveURL(new RegExp(`/books/${book.id}/read`));

    await ben.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    await anaCtx.close();
    await benCtx.close();
  });

  test('on a portrait phone the player moves Chat out of its header and into its content instead, same button, same badge, same sheet', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });

    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('chat-input').fill('hello from the player');
    await ana.getByTestId('chat-send').click();
    await expect(ana.getByTestId('chat-message').filter({ hasText: 'hello from the player' })).toBeVisible();

    const ownerCtx = await browserAs(browser, club.owner, { viewport: { width: 393, height: 659 }, isMobile: true, hasTouch: true });
    const owner = await ownerCtx.newPage();
    await owner.goto(`/books/${book.id}/listen`);
    await expect(owner.getByTestId('play-pause')).toBeVisible();
    // No room in the header for a third button here (app.css, D170, D173): it holds only Back,
    // Track list and (hidden on a phone) Ask Cal — Chat is not in it at all, not even hidden.
    await expect(owner.locator('.reader-header').getByTestId('open-chat-sheet')).toHaveCount(0);
    const chatBtn = owner.getByTestId('open-chat-sheet');
    await expect(chatBtn).toBeVisible();
    await expect(chatBtn.getByTestId('chat-unread-badge')).toHaveText('1', { timeout: 5000 });

    await chatBtn.click();
    const sheet = owner.getByTestId('chat-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('chat-message').filter({ hasText: 'hello from the player' })).toBeVisible();
    // Listening is still going on underneath: this is a sheet, not a navigation away from the player.
    await expect(owner).toHaveURL(new RegExp(`/books/${book.id}/listen`));

    await owner.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    await anaCtx.close();
    await ownerCtx.close();
  });

  test('Do Not Disturb silences a mention toast, but the bell still records it', async ({ browser }) => {
    const { club } = await clubWithAlice(['Ana', 'Ben']);
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    await ben.getByTestId('chat-dnd-toggle').click();
    await expect(ben.getByTestId('chat-dnd-toggle')).toHaveAttribute('aria-pressed', 'true');

    // Persisted server-side (D173), not just this tab's own state.
    const dnd = await ben.request.get('/api/chat/dnd');
    expect(((await dnd.json()) as { enabled: boolean }).enabled).toBe(true);

    await ben.goto(`/clubs/${club.id}`);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('chat-input').fill('@Ben quiet tonight?');
    await ana.getByTestId('chat-send').click();

    // No toast while DND is on…
    await expect(ben.getByTestId('toast')).toHaveCount(0, { timeout: 4000 });
    // …but the mention is still in the bell, ready for whenever DND comes back off.
    const bell = await ben.request.get('/api/notifications');
    const notifications = (await bell.json()) as { items: { kind: string }[] };
    expect(notifications.items.some((n) => n.kind === 'mention')).toBe(true);
    await anaCtx.close();
    await benCtx.close();
  });
});

test.describe('voice channels (D153-D154) @chromium-only', () => {
  test('both join voice, and a speaking indicator shows for a mic that is actually heard', async ({ browser }) => {
    const { club } = await clubWithAlice(['Ana', 'Ben']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('voice-join').click();
    await expect(ana.getByTestId('voice-mute')).toBeVisible({ timeout: 15_000 });

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    await ben.getByTestId('voice-join').click();
    await expect(ben.getByTestId('voice-mute')).toBeVisible({ timeout: 15_000 });

    // The fake mic plays a real tone (scripts/fixtures/make-voice-tone.mjs): LiveKit's own
    // speaking detection has something to detect, so this is not a coin flip.
    await expect(ana.locator('[data-testid="voice-participant"][data-speaking="true"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(ben.locator('[data-testid="voice-participant"][data-speaking="true"]').first()).toBeVisible({ timeout: 15_000 });
    await anaCtx.close();
    await benCtx.close();
  });
});

test.describe('listening together (D155-D158)', () => {
  test('Ben joins Ana’s party; positions agree within a second; Ana pausing pauses Ben', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { audio: 'tiny' });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await ana.getByTestId('party-start').click();
    await expect(ana.getByTestId('party-toggle')).toBeVisible();
    await ana.getByTestId('party-toggle').click();
    await expect(ana.getByTestId('party-toggle')).toHaveAttribute('aria-label', 'Pause for everyone');

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await expect(ben.getByTestId('party-join')).toBeVisible({ timeout: 10_000 });
    await ben.getByTestId('party-join').click();
    await expect(ben.getByTestId('party-leave')).toBeVisible();

    // The sync loop (both sides, every 1 s) converges on the server's clock.
    await ben.waitForTimeout(2500);
    const position = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime);
    expect(Math.abs((await position(ana)) - (await position(ben)))).toBeLessThan(1);

    await ana.getByTestId('party-toggle').click();
    await expect(ben.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false', { timeout: 3000 });
    await anaCtx.close();
    await benCtx.close();
  });

  test('joining far ahead of your own place warns you first', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { audio: 'tiny' });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await ana.getByTestId('party-start').click();
    // Seek well into the book (not a real-time wait: the audio edition's chapters are aligned to
    // the reference EPUB's own measure, where a few seconds of early track time can be a tiny
    // fraction of t) — track 6 of 12 is unmistakably ahead of Ben, who has never opened this book.
    await club.members.Ana!.api.post(`/api/books/${book.id}/party/control`, { data: { action: 'seek', track: 6, position: 0 } });

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await ben.getByTestId('party-join').click();
    await answerQuestion(ben, /The party is at/, 'Join anyway');
    await expect(ben.getByTestId('party-leave')).toBeVisible();
    await anaCtx.close();
    await benCtx.close();
  });

  test('auto-pause on interruption pauses the party for everyone, and resumes after quiet @chromium-only', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { audio: 'tiny' });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await ana.getByTestId('party-start').click();
    await lowerAutoPauseThresholds(club.members.Ana!.api, book.id);
    await ana.getByTestId('party-toggle').click();

    // Ana joins voice right from the player (VoiceBar is on ListenPage too, D153/D155: talk while
    // listening together without ever leaving the page).
    await ana.getByTestId('voice-join').click();
    await expect(ana.getByTestId('voice-mute')).toBeVisible({ timeout: 15_000 });

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await ben.getByTestId('party-join').click();

    // Ana's fake mic plays a continuous tone (scripts/fixtures/make-voice-tone.mjs): LiveKit's
    // real speaking detection, through the real party, pauses it for Ben too.
    await expect(ben.getByTestId('party-paused-interruption')).toBeVisible({ timeout: 20_000 });
    await expect(ben.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false');

    // Ana mutes: her mic stops publishing, the engine's quiet countdown runs out, and it resumes.
    await ana.getByTestId('voice-mute').click();
    await expect(ben.getByTestId('party-paused-interruption')).toHaveCount(0, { timeout: 10_000 });
    await anaCtx.close();
    await benCtx.close();
  });
});
