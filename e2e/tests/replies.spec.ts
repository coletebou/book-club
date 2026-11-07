import { expect, test } from '@playwright/test';
import { type Person, browserAs, clubWithAlice, postComment, putProgress } from '../helpers/api';
import { listenFromThisPage, openFromBookPage } from '../helpers/open';

const at = (section: number, offset: number) => ({ kind: 'epub' as const, section, offset });

test.describe('conversations under notes, and being told', () => {
  test('a friend answers a note; the author is told at once, and the answer waits for those who have not got there', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben', 'Cleo']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    // Ana writes where she is reading (the reader records her reading there before she posts).
    await putProgress(club.members.Ana!, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    const note = await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: at(3, 200), text: 'Down, down, down: I love this bit' });
    await putProgress(club.members.Ben!, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);

    // Ana has the club open on her phone.
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}`);
    const bell = ana.getByTestId('bell');
    // Ben's reading got to her note already: that is one thing to tell her.
    await expect(bell).toHaveAttribute('data-unread', '1');

    // Ben, who has read that far, answers it from the book page.
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}`);
    const thread = ben.locator(`#note-${note.id}`);
    await expect(thread).toContainText('I love this bit');
    await thread.getByTestId('reply-open').click();
    await thread.getByTestId('reply-text').fill('Me too, the marmalade jar!');
    await thread.getByTestId('reply-send').click();
    await expect(thread.getByTestId('reply')).toContainText('Me too, the marmalade jar!');

    // Ana is told, live, and the notification takes her to the conversation.
    await expect(bell).toHaveAttribute('data-unread', '2', { timeout: 5000 });
    await expect(ana.getByText(/Ben replied/).first()).toBeVisible();
    await bell.click();
    await expect(bell).toHaveAttribute('data-unread', '0');
    // The panel is whole on screen, on a phone too (the bell is not at the screen's edge).
    const panel = (await ana.getByTestId('bell-panel').boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(ana.viewportSize()!.width);
    await ana.getByTestId('notification').first().click();
    await expect(ana).toHaveURL(new RegExp(`/books/${book.id}#note-${note.id}$`));
    await expect(ana.locator(`#note-${note.id}`).getByTestId('reply')).toContainText('Me too, the marmalade jar!');
    // And the book page opens at the conversation, not at its top.
    await expect(ana.locator(`#note-${note.id}`)).toBeInViewport();

    // Cleo has not got there: the note and its answer are markers, without their words.
    const cleoCtx = await browserAs(browser, club.members.Cleo!);
    const cleo = await cleoCtx.newPage();
    await cleo.goto(`/books/${book.id}`);
    await expect(cleo.locator(`#note-${note.id}`)).toHaveAttribute('data-hidden', 'true');
    await expect(cleo.getByText('marmalade')).toHaveCount(0);
    await expect(cleo.getByText('I love this bit')).toHaveCount(0);
    await Promise.all([anaCtx.close(), benCtx.close(), cleoCtx.close()]);
  });

  test('an answer reaches you in the reader and in the player too, where the evening is spent', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await putProgress(club.members.Ana!, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    const note = await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: at(3, 200), text: 'Down, down, down' });
    await putProgress(club.members.Ben!, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    const answer = async (text: string) => expect((await club.members.Ben!.api.post(`/api/comments/${note.id}/replies`, { data: { text } })).status()).toBe(201);

    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    // Live: the connection is up, and stays up as she opens the book (its one Continue, D198).
    await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
    await openFromBookPage(page, book, { label: 'Continue', kind: 'epub' });
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await answer('The marmalade jar!');
    const toasts = page.locator('.toast-region');
    await expect(toasts).toContainText(/Ben replied/, { timeout: 5000 });

    // And while she listens.
    await page.getByRole('link', { name: /^Back to / }).click();
    await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
    // Listening over the text (D197): into the book again, and Listen in its footer (D198).
    await openFromBookPage(page, book, { label: 'Continue', kind: 'epub', along: false });
    await listenFromThisPage(page);
    await expect(toasts.filter({ hasText: /Ben replied/ })).toHaveCount(0, { timeout: 15_000 });
    await answer('Orange marmalade, empty.');
    await expect(toasts).toContainText(/Ben replied/, { timeout: 5000 });
    await ctx.close();
  });

  test('a friend getting to your note tells you, without telling you anything else', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number }[] };
    const ch2 = pub.toc.find((e) => e.title.startsWith('CHAPTER II.'))!.section;
    await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: at(ch2, 10), text: 'Curiouser and curiouser!', reaction: '🤯' });
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}`);
    const bell = ana.getByTestId('bell');
    await expect(bell).toHaveAttribute('data-unread', '0');

    // Ben goes to chapter II from the contents and reads on (three pages: it is past where he has
    // read, D72): the first page, where the note is, is read.
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ben.getByTestId('open-toc').click();
    await ben.getByRole('button', { name: /CHAPTER II\./ }).click();
    await expect(ben.getByTestId('chapter-page')).toHaveAttribute('data-page', '1', { timeout: 30_000 });
    for (const n of ['2', '3', '4']) {
      await ben.getByTestId('next-page').click();
      await expect(ben.getByTestId('chapter-page')).toHaveAttribute('data-page', n);
    }
    for (const n of ['3', '2', '1']) {
      await ben.getByTestId('prev-page').click();
      await expect(ben.getByTestId('chapter-page')).toHaveAttribute('data-page', n);
    }
    await expect(ben.getByTestId('margin-marker').first()).toHaveAttribute('data-hidden', 'false', { timeout: 10_000 });

    await expect(bell).toHaveAttribute('data-unread', '1', { timeout: 10_000 });
    await bell.click();
    const item = ana.getByTestId('notification').first();
    await expect(item).toContainText('Ben got to your note');
    await expect(item).toContainText('Chapter 2');
    await Promise.all([anaCtx.close(), benCtx.close()]);
  });

  /** Alice's chapters I, II and IX (their spine sections), and the end of chapter IX. */
  async function chapters(owner: Person, publicationUrl: string) {
    const pub = (await (await owner.api.get(publicationUrl)).json()) as { sections: { textLength: number }[]; toc: { title: string; section: number }[] };
    const section = (n: string) => pub.toc.find((e) => e.title.startsWith(`CHAPTER ${n}.`))!.section;
    const ch9 = section('IX');
    return { ch1: section('I'), ch2: section('II'), endOfCh9: at(ch9, pub.sections[ch9]!.textLength) };
  }

  test('a friend far ahead answers an early note: you see who answered and from where, and the words once you have read that far', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Cleo', 'Cole']);
    const [ana, cleo, cole] = [club.members.Ana!, club.members.Cleo!, club.members.Cole!];
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const { ch1, ch2, endOfCh9 } = await chapters(club.owner, epub.publicationUrl!);
    // Ana writes in chapter I, where she is reading; Cole has read on into chapter II.
    await putProgress(ana, book.id, epub.id, at(ch1, 0), [{ from: at(ch1, 0), to: at(ch1, 900) }]);
    const note = await postComment(ana, book.id, { editionId: epub.id, locator: at(ch1, 200), text: 'Down, down, down: I love this bit' });
    await putProgress(cole, book.id, epub.id, at(ch2, 0), [{ from: at(ch1, 0), to: at(ch2, 600) }]);
    // Cleo has read to the end of chapter IX.
    await putProgress(cleo, book.id, epub.id, endOfCh9, [{ from: at(ch1, 0), to: endOfCh9 }]);

    // Ana has the club open; Cole the book's page, live.
    const anaCtx = await browserAs(browser, ana);
    const anaPage = await anaCtx.newPage();
    await anaPage.goto(`/clubs/${club.id}`);
    const bell = anaPage.getByTestId('bell');
    // Cleo and Cole got to her note: two things to tell her.
    await expect(bell).toHaveAttribute('data-unread', '2');
    const coleCtx = await browserAs(browser, cole);
    const colePage = await coleCtx.newPage();
    await colePage.goto(`/books/${book.id}`);
    const thread = colePage.locator(`#note-${note.id}`);
    await expect(thread).toContainText('I love this bit');
    await expect(colePage.getByTestId('live-dot')).toHaveClass(/is-on/);

    // Cleo answers it, from chapter IX.
    const words = 'In chapter 9 the Mock Turtle sobs about his schooling';
    expect((await cleo.api.post(`/api/comments/${note.id}/replies`, { data: { text: words } })).status()).toBe(201);

    // On Cole's screen, live: who answered and from where, never what.
    const answer = thread.getByTestId('reply');
    await expect(answer.getByTestId('reply-held')).toHaveText('Cleo replied from Chapter 9 · it opens when you get there', { timeout: 5000 });
    await expect(colePage.getByText(/sobs about his schooling/)).toHaveCount(0);
    expect(await (await colePage.request.get(`/api/books/${book.id}/comments`)).text()).not.toContain('schooling');
    // Ana, whose note it is, is told the same, in a toast and in the bell: she has not read that far either.
    await expect(anaPage.locator('.toast-region')).toContainText('Cleo replied from Chapter 9 · it opens when you get there', { timeout: 5000 });
    await expect(bell).toHaveAttribute('data-unread', '3');
    await bell.click();
    await expect(anaPage.getByTestId('notification').first()).toContainText('Cleo replied from Chapter 9 · it opens when you get there');
    await expect(anaPage.getByText(/schooling/)).toHaveCount(0);
    expect(await (await anaPage.request.get('/api/notifications')).text()).not.toContain('schooling');

    // Cole reads on to the end of chapter IX (on his phone, say): back on the page, the words are there.
    await putProgress(cole, book.id, epub.id, endOfCh9, [{ from: at(ch2, 600), to: endOfCh9 }]);
    await colePage.reload();
    await expect(answer).toContainText(words);
    await expect(answer.getByTestId('reply-held')).toHaveCount(0);
    await Promise.all([anaCtx.close(), coleCtx.close()]);
  });

  test('a note written while paging back says in the reader where it was written from, and opens once you have read that far', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Cleo', 'Cole']);
    const [cleo, cole] = [club.members.Cleo!, club.members.Cole!];
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const { ch1, ch2, endOfCh9 } = await chapters(club.owner, epub.publicationUrl!);
    // Cleo has read to the end of chapter IX, and pages back to chapter I to write.
    await putProgress(cleo, book.id, epub.id, endOfCh9, [{ from: at(ch1, 0), to: endOfCh9 }]);
    const note = await postComment(cleo, book.id, { editionId: epub.id, locator: at(ch1, 400), text: 'Keep an eye on those painted roses', reaction: '🤯' });
    await putProgress(cole, book.id, epub.id, at(ch2, 0), [{ from: at(ch1, 0), to: at(ch2, 600) }]);

    // Cole follows a link to it, behind his place: the note's sheet says who wrote it, and from where.
    const ctx = await browserAs(browser, cole);
    const page = await ctx.newPage();
    const link = `/books/${book.id}/read?edition=${epub.id}&at=${note.t.toFixed(6)}&comment=${note.id}`;
    await page.goto(link);
    const held = page.getByTestId('sheet-note').filter({ hasText: 'Cleo' });
    await expect(held).toHaveAttribute('data-hidden', 'true', { timeout: 30_000 });
    await expect(held.getByTestId('sheet-note-held')).toHaveText('Cleo wrote this from Chapter 9 · it opens when you get there');
    await expect(held).toContainText('🤯');
    await expect(page.getByTestId('sheet-note-text')).toHaveCount(0);
    await expect(page.getByText(/painted roses/)).toHaveCount(0);

    // Read that far, the same link opens it in full.
    await putProgress(cole, book.id, epub.id, endOfCh9, [{ from: at(ch2, 600), to: endOfCh9 }]);
    await page.goto(link);
    await expect(page.getByTestId('sheet-note-text')).toHaveText('Keep an eye on those painted roses', { timeout: 30_000 });
    await ctx.close();
  });
});
