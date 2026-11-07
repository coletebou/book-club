import { expect, test } from '@playwright/test';
import { ALICE_TINY_DIR, aliceEpub, alicePdf, audioFolder, browserAs, clubWithAlice, makeClub, placeSaved, putProgress, signUp, uploadBook } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

test.describe('the library', () => {
  test('covers load on the library page (same origin, no CORP failure as in v1)', async ({ browser }) => {
    const { club } = await clubWithAlice([]);
    await uploadBook(club.owner, club.id, 'pdf', [alicePdf()], { title: 'Alice (print edition)', author: 'Lewis Carroll' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const covers: number[] = [];
    page.on('response', (r) => {
      if (/\/media\/books\/.+\/cover/.test(r.url())) covers.push(r.status());
    });
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByTestId('book-card')).toHaveCount(2);
    for (const img of await page.getByTestId('book-cover').all()) {
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    }
    expect(covers.length).toBeGreaterThan(0);
    expect(covers.every((s) => s === 200 || s === 304)).toBe(true);
    await ctx.close();
  });

  test('each book card shows its formats and where every member is', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await putProgress(club.members.Ana!, book.id, epub.id, { kind: 'epub', section: 6, offset: 0 }, [
      { from: { kind: 'epub', section: 2, offset: 0 }, to: { kind: 'epub', section: 6, offset: 0 } },
    ]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    const card = page.getByTestId('book-card').first();
    await expect(card.locator('.kinds')).toHaveAttribute('aria-label', 'Formats: EPUB, Audio');
    const markers = card.getByTestId('member-marker');
    await expect(markers).toHaveCount(2);
    const ana = card.locator(`[data-testid=member-marker][data-user="${club.members.Ana!.id}"]`);
    expect(Number(await ana.getAttribute('data-t'))).toBeGreaterThan(0.25);
    await expect(card).toContainText('1 of 2 started');
    await ctx.close();
  });

  test('a book you are reading opens where you stopped in one tap from its card; one not started has no such button', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const place = { kind: 'epub' as const, section: 6, offset: 0 };
    await putProgress(club.members.Ana!, book.id, epub.id, place, [{ from: { kind: 'epub', section: 2, offset: 0 }, to: place }]);
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    // At the top, on the first screen, whatever the phone: the book she read last, one Continue (D198).
    const banner = page.getByTestId('continue-banner');
    await expect(banner).toBeInViewport({ ratio: 1 });
    await expect(banner).toContainText('Continue');
    await expect(page.getByTestId('card-continue')).toHaveText('Continue');
    await page.getByTestId('card-continue').click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', '6');
    await page.goto(`/clubs/${club.id}`);
    await banner.click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', '6');
    await ctx.close();
    // The owner has not started it: the card is the book's page, with nothing to continue.
    const owner = await browserAs(browser, club.owner);
    const other = await owner.newPage();
    await other.goto(`/clubs/${club.id}`);
    await expect(other.getByTestId('book-card')).toHaveCount(1);
    await expect(other.getByTestId('card-continue')).toHaveCount(0);
    await expect(other.getByTestId('continue-banner')).toHaveCount(0);
    await owner.close();
  });

  test('a book you have not started offers its first step on its card: Open, into the text at its start, or the player for an audiobook alone (fidelity review round 16, D198)', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Fern'], { audio: 'tiny' });
    const heard = await uploadBook(club.owner, club.id, 'audio', audioFolder(ALICE_TINY_DIR), { title: 'Through the Looking-Glass', author: 'Lewis Carroll' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { sections: { textLength: number }[]; story: { start: number } };
    let storySection = 0;
    for (let m = 0; m + pub.sections[storySection]!.textLength <= pub.story.start; m += pub.sections[storySection]!.textLength) storySection++;
    const ctx = await browserAs(browser, club.members.Fern!);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    const card = (id: string) => page.locator(`[data-testid=book-card][data-book="${id}"]`);
    // Nothing to continue yet, so one step in, Open (D198): into the text, where the book has one…
    await expect(card(book.id).getByTestId('card-continue')).toHaveCount(0);
    await expect(card(book.id).getByTestId('card-start')).toHaveText('Open');
    await expect(card(book.id).getByTestId('card-start')).toHaveAttribute('href', `/books/${book.id}/read`);
    // …and the player, where it is an audiobook alone.
    await expect(card(heard.id).getByTestId('card-start')).toHaveText('Open');
    await expect(card(heard.id).getByTestId('card-start')).toHaveAttribute('href', `/books/${heard.id}/listen`);
    await card(heard.id).getByTestId('card-start').click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '0');
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-ms', '0');
    await page.goto(`/clubs/${club.id}`);
    await card(book.id).getByTestId('card-start').click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/read`));
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    // At the story's start, in the EPUB, as the book page's Read opens it.
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', String(storySection));
    await expect(page.getByTestId('percent')).toHaveText('0%');
    // A page read, the card goes back to her place from then on: Continue (D198).
    await page.getByTestId('next-page').click();
    await placeSaved(page, book.id);
    await page.goto(`/clubs/${club.id}`);
    await expect(card(book.id).getByTestId('card-continue')).toHaveText('Continue');
    await expect(card(book.id).getByTestId('card-start')).toHaveCount(0);
    await ctx.close();
  });

  test('a friend reading right now shows on the card', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const watcher = await browserAs(browser, club.owner);
    const w = await watcher.newPage();
    await w.goto(`/clubs/${club.id}`);
    const reader = await browserAs(browser, club.members.Ana!);
    const r = await reader.newPage();
    await r.goto(`/books/${book.id}/read`);
    await expect(w.getByTestId('book-card').first()).toContainText('Ana reading now', { timeout: 5000 });
    await reader.close();
    await watcher.close();
  });

  test('someone in two clubs chooses between them from home', async ({ browser }) => {
    const first = await makeClub([]);
    const second = await makeClub([]);
    const both = await signUp(first.invite, 'Pat');
    await both.api.post(`/api/invites/${second.invite}/accept`);
    const ctx = await browserAs(browser, both);
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Your clubs' })).toBeVisible();
    await page.getByRole('link', { name: new RegExp(second.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/clubs/${second.id}$`));
    await ctx.close();
  });

  test('a book is edited and deleted by whoever added it', async ({ browser }) => {
    const club = await makeClub([]);
    const book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: 'Alice', author: 'Carroll' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Title').fill("Alice's Adventures in Wonderland");
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: "Alice's Adventures in Wonderland" })).toBeVisible();
    await page.getByRole('button', { name: 'Edit' }).click();
    // Removing a book is the Edit dialog's "Remove book" since books are soft-deleted (D179).
    await page.getByRole('dialog').getByRole('button', { name: 'Remove book' }).click();
    await answerQuestion(page, "Remove “Alice's Adventures in Wonderland” from the club?", 'Remove');
    await expect(page).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    await expect(page.getByTestId('book-card')).toHaveCount(0);
    expect((await club.owner.api.get(`/api/books/${book.id}`)).status()).toBe(404);
    await ctx.close();
  });
});
