import { expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, postComment, putProgress } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

test.describe('notes belong to their authors; the owner moderates', () => {
  test('a member cannot delete a friend’s note, the owner can', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const note = await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: { kind: 'epub', section: 2, offset: 10 }, text: 'Ana was here' });
    // Ben has read it, but it is not his to delete.
    await putProgress(club.members.Ben!, book.id, epub.id, { kind: 'epub', section: 2, offset: 0 }, [{ from: { kind: 'epub', section: 2, offset: 0 }, to: { kind: 'epub', section: 2, offset: 500 } }]);
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}`);
    const benNote = ben.getByTestId('note').filter({ hasText: 'Ana was here' });
    await expect(benNote).toBeVisible();
    await expect(benNote.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    expect((await club.members.Ben!.api.delete(`/api/comments/${note.id}`)).status()).toBe(403);

    const ownerCtx = await browserAs(browser, club.owner);
    const owner = await ownerCtx.newPage();
    await owner.goto(`/books/${book.id}`);
    // The owner has not read it either: hidden, but moderation still works through the API.
    expect((await club.owner.api.delete(`/api/comments/${note.id}`)).status()).toBe(204);
    await ben.reload();
    await expect(ben.getByText('Ana was here')).toHaveCount(0);
    await benCtx.close();
    await ownerCtx.close();
  });

  test('the owner removes a friend’s note only after saying yes, told whose it is', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: { kind: 'epub', section: 2, offset: 10 }, text: 'Ana was here' });
    await putProgress(club.owner, book.id, epub.id, { kind: 'epub', section: 2, offset: 0 }, [{ from: { kind: 'epub', section: 2, offset: 0 }, to: { kind: 'epub', section: 2, offset: 500 } }]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const note = page.getByTestId('note').filter({ hasText: 'Ana was here' });
    await expect(note).toHaveAttribute('data-hidden', 'false');
    // A stray tap: asked, in the app's own dialog, and the note stays (no delete is sent; the one below is the only one).
    const deletes: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'DELETE' && r.url().includes('/api/comments/')) deletes.push(r.url());
    });
    await note.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Delete Ana’s note?' })).toHaveAccessibleDescription('It goes for everyone in the club.');
    await answerQuestion(page, 'Delete Ana’s note?', 'Keep');
    await expect(note).toBeVisible();
    // Yes: gone, for Ana too.
    await note.getByRole('button', { name: 'Delete' }).click();
    await answerQuestion(page, 'Delete Ana’s note?', 'Delete');
    await expect(page.getByText('Ana was here')).toHaveCount(0);
    expect(deletes).toHaveLength(1);
    expect((await (await club.members.Ana!.api.get(`/api/books/${book.id}/comments`)).json()) as unknown[]).toHaveLength(0);
    await ctx.close();
  });

  test('a reaction straight from a selected passage, without words', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?at=0.2`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    const frame = (await (await page.locator('iframe.epub-frame').elementHandle()).contentFrame())!;
    const start = Number(await page.getByTestId('reader').getAttribute('data-start'));
    await frame.evaluate((offset) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let at = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text;
        if (at + t.data.length > offset && t.data.trim().length > 20) {
          const from = Math.max(0, offset - at) + (t.data.slice(Math.max(0, offset - at)).search(/\S/) || 0);
          const r = document.createRange();
          r.setStart(t, from);
          r.setEnd(t, Math.min(t.data.length, from + 25));
          document.getSelection()!.removeAllRanges();
          document.getSelection()!.addRange(r);
          return;
        }
        at += t.data.length;
      }
    }, start);
    await page.getByTestId('react-mind-blown').click();
    await expect(page.getByText('🤯 pinned here.')).toBeVisible();
    await expect(page.getByTestId('margin-marker')).toHaveText(/🤯/);
    const comments = (await (await page.request.get(`/api/books/${book.id}/comments`)).json()) as { reaction: string; text: string | null; quote: string | null }[];
    expect(comments[0]).toMatchObject({ reaction: '🤯', text: null });
    expect(comments[0]!.quote!.length).toBeGreaterThan(5);
    await ctx.close();
  });
});
