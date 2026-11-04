import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import type { Locator as NativeLocator, Publication } from '@bookclub/shared';
import { browserAs, clubWithAlice, readUpTo } from '../helpers/api';

/**
 * Cal (D160-D169). The real stack runs with CAL_TEST_FAKE_MODEL=1 and CAL_EMBEDDING_PROVIDER=fake
 * for these tests (docs/DEPLOY.md): Cal's route, his real spoiler gate, real hybrid search and
 * real citation-building all run for real; only the model's own reasoning is a deterministic
 * stand-in (cal/fake-model.ts) that always searches for the asker's question, then cites the
 * first result it is handed.
 */

/** A locator a given fraction of the way through the book's reference EPUB (via its own manifest, not guessed). */
async function fractionLocator(person: { api: APIRequestContext }, editionId: string, fraction: number): Promise<NativeLocator> {
  const pub = (await (await person.api.get(`/api/editions/${editionId}/publication`)).json()) as Publication;
  const total = pub.sections.reduce((n, s) => n + s.textLength, 0);
  const target = Math.floor(total * fraction);
  let at = 0;
  for (const s of pub.sections) {
    if (at + s.textLength >= target) return { kind: 'epub', section: s.index, offset: target - at };
    at += s.textLength;
  }
  return { kind: 'epub', section: pub.sections[pub.sections.length - 1]!.index, offset: 0 };
}

async function askCal(page: Page, question: string) {
  // The panel stays open across questions in the same test; only open it if it is not already.
  const input = page.getByTestId('cal-input');
  if (!(await input.isVisible())) await page.getByTestId('cal-launcher').click();
  await input.fill(question);
  await page.getByTestId('cal-send').click();
}

test.describe('Cal', () => {
  test('answers a question about Alice and a citation opens the place', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    // Read nearly the whole book, so a search for an early, well-known term is sure to be open.
    await readUpTo(club.owner, book.id, epub.id, await fractionLocator(club.owner, epub.id, 0.95));

    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await askCal(page, 'What does the White Rabbit say?');

    const assistant = page.getByTestId('cal-message-assistant').last();
    await expect(assistant).toBeVisible({ timeout: 20_000 });
    const citation = page.getByTestId('cal-citation-link').first();
    await expect(citation).toBeVisible({ timeout: 20_000 });
    const href = await citation.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/books/${book.id}/read\\?at=`));

    await citation.click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/read\\?at=`));
  });

  test('a reader early in the book gets no citation or text past their place, by search or with the whole-series setting on', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await readUpTo(club.owner, book.id, epub.id, await fractionLocator(club.owner, epub.id, 0.1));

    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);

    // The Mock Turtle is introduced well past the first tenth of the book. The real guarantee
    // under test is that the spoiler text itself never reaches the page — not that a search
    // never returns any citation at all: with the deterministic fake model and fake embeddings
    // (no real semantic discrimination), a query can still surface some other, already-read
    // passage as a low-relevance citation, and that citation's own quote is part of the same
    // message bubble this assertion already covers.
    await askCal(page, 'Tell me about the Mock Turtle.');
    let assistant = page.getByTestId('cal-message-assistant').last();
    await expect(assistant).toBeVisible({ timeout: 20_000 });
    await expect(assistant).not.toContainText('Mock Turtle');

    // Alice is not part of a series (D162): the whole-series setting has nothing to lift for her,
    // and must not become a general spoiler bypass. Since D183 the chat has no per-question
    // checkbox at all; the scope is set only in Cal's settings (the gear), and still refused.
    const panel = page.getByRole('dialog', { name: 'Ask Cal' });
    await expect(panel.getByRole('checkbox')).toHaveCount(0);
    await panel.getByTestId('cal-settings-open').click();
    const settings = page.getByRole('dialog', { name: "Cal's settings" });
    await settings.getByRole('radio', { name: 'Whole series' }).click();
    await expect.poll(async () => (await (await club.owner.api.get('/api/cal/settings')).json()) as { wholeSeries: boolean }).toEqual({ wholeSeries: true });
    await settings.getByRole('button', { name: 'Close' }).click();
    await askCal(page, 'Tell me about the Mock Turtle, the whole story.');
    assistant = page.getByTestId('cal-message-assistant').last();
    await expect(assistant).toBeVisible({ timeout: 20_000 });
    await expect(assistant).not.toContainText('Mock Turtle');
  });

  test('settings (D173): the panel is chat-only, and a gear opens the standing whole-series setting and his shelf', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.getByTestId('cal-launcher').click();
    const panel = page.getByRole('dialog', { name: 'Ask Cal' });
    await expect(panel).toBeVisible();
    // No tabs any more: the chat input is right there, and there is nothing named "Cal's shelf" in it.
    await expect(panel.getByTestId('cal-input')).toBeVisible();
    await expect(panel.getByRole('tab')).toHaveCount(0);

    await panel.getByTestId('cal-settings-open').click();
    const settings = page.getByRole('dialog', { name: "Cal's settings" });
    await expect(settings).toBeVisible();

    // The standing setting (`/api/cal/settings`) had no UI to set it before D173; now the gear
    // reaches it, as a segmented control (an accessible radiogroup, not a lone checkbox), and it
    // is really saved on the server, not just in this render.
    const backwards = settings.getByRole('radio', { name: "Only what I've read" });
    const whole = settings.getByRole('radio', { name: 'Whole series' });
    await expect(backwards).toHaveAttribute('aria-checked', 'true');
    // The copy says the scope is standing: every question, every chat (D183), not just the next one.
    const scopeHint = settings.getByTestId('cal-scope-hint');
    await expect(scopeHint).toHaveText(/^Cal never answers past your place\. This holds for every question, in every chat/);
    // The chat's hint points here for the scope, not to anything in the chat itself (D183).
    await expect(panel.getByTestId('cal-hint')).toContainText('open his settings');
    await whole.click();
    await expect(whole).toHaveAttribute('aria-checked', 'true');
    await expect(backwards).toHaveAttribute('aria-checked', 'false');
    await expect(scopeHint).toHaveText(/^Cal may draw on every book in the series, including what happens past your place\. This holds for every question, in every chat/);
    await expect.poll(async () => (await (await club.owner.api.get('/api/cal/settings')).json()) as { wholeSeries: boolean }).toEqual({ wholeSeries: true });

    // His shelf: add a URL, see it listed; upload a text file; remove both.
    await settings.getByPlaceholder('https://…').fill('https://example.com/notes');
    await settings.getByRole('button', { name: 'Add URL' }).click();
    const urlItem = settings.locator('.cal-shelf-list li', { hasText: 'https://example.com/notes' });
    await expect(urlItem).toBeVisible();

    await settings.locator('input[type="file"]').setInputFiles({ name: 'club-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes for the club, not part of any book.') });
    const fileItem = settings.locator('.cal-shelf-list li', { hasText: 'club-notes.txt' });
    await expect(fileItem).toBeVisible();

    await urlItem.getByRole('button', { name: /^Remove /}).click();
    await fileItem.getByRole('button', { name: /^Remove /}).click();
    await expect(settings.getByText('Nothing on the shelf yet.')).toBeVisible();

    // The settings dialog closes independently of the panel behind it.
    await settings.getByRole('button', { name: 'Close' }).click();
    await expect(settings).toHaveCount(0);
    await expect(panel).toBeVisible();
  });

  test('threads (D183): a new chat keeps the earlier ones, the list switches between them, and each keeps its own history', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Bea']);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const panel = page.getByRole('dialog', { name: 'Ask Cal' });

    // The first question starts the first thread, titled by it.
    await askCal(page, 'What does the White Rabbit say?');
    await expect(panel.getByTestId('cal-message-assistant')).toHaveCount(1, { timeout: 20_000 });
    await expect(panel.getByTestId('cal-thread-current')).toHaveText('What does the White Rabbit say?');

    // "New chat" in the header: an empty chat, the earlier one kept.
    await panel.getByTestId('cal-new-chat').click();
    await expect(panel.getByTestId('cal-thread-current')).toHaveText('New chat');
    await expect(panel.getByTestId('cal-message-user')).toHaveCount(0);
    await askCal(page, 'Who is the Cheshire Cat?');
    await expect(panel.getByTestId('cal-message-assistant')).toHaveCount(1, { timeout: 20_000 });
    await expect(panel.getByTestId('cal-message-user')).toHaveText(['Who is the Cheshire Cat?']);

    // The list: both, most recent first, each with when it was last used.
    await panel.getByTestId('cal-threads-open').click();
    const rows = panel.getByTestId('cal-thread');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Who is the Cheshire Cat?');
    await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
    await expect(rows.nth(0)).toContainText('just now');
    await expect(rows.nth(1)).toContainText('What does the White Rabbit say?');

    // Opening the earlier one shows its whole history, and only its own.
    await rows.nth(1).click();
    await expect(panel.getByTestId('cal-thread-current')).toHaveText('What does the White Rabbit say?');
    await expect(panel.getByTestId('cal-message-user')).toHaveText(['What does the White Rabbit say?']);
    await expect(panel.getByTestId('cal-message-assistant')).toHaveCount(1);

    // A question there goes to that thread, which then comes first.
    await askCal(page, 'Why is he late?');
    await expect(panel.getByTestId('cal-message-assistant')).toHaveCount(2, { timeout: 20_000 });
    await expect(panel.getByTestId('cal-message-user')).toHaveText(['What does the White Rabbit say?', 'Why is he late?']);
    const listed = (await (await club.owner.api.get(`/api/clubs/${club.id}/cal/conversations`)).json()) as { title: string }[];
    expect(listed.map((t) => t.title)).toEqual(['What does the White Rabbit say?', 'Who is the Cheshire Cat?']);

    // Closing and opening the panel again carries on in the latest thread.
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);
    await page.getByTestId('cal-launcher').click();
    await expect(panel.getByTestId('cal-thread-current')).toHaveText('What does the White Rabbit say?');
    await expect(panel.getByTestId('cal-message-user')).toHaveCount(2);

    // Private: another member of the club sees none of them.
    const bea = club.members['Bea']!;
    const hers = (await (await bea.api.get(`/api/clubs/${club.id}/cal/conversations`)).json()) as unknown[];
    expect(hers).toEqual([]);

    // Deleting one, after the app's own confirmation, leaves the other.
    await panel.getByTestId('cal-threads-open').click();
    await panel.getByRole('button', { name: 'Delete “Who is the Cheshire Cat?”' }).click();
    await page.getByRole('alertdialog', { name: 'Delete this chat?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText('What does the White Rabbit say?');
  });
});
