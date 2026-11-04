import { type Page, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, expectInFooter, postComment, putProgress } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

async function ready(page: Page) {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

test.describe('the moments that matter', () => {
  test('finishing a chapter shows what friends said in it', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number }[] };
    const ch2 = pub.toc.find((e) => e.title.startsWith('CHAPTER II.'))!.section;
    await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: { kind: 'epub', section: ch2, offset: 300 }, text: 'A pool of her own tears!', reaction: '😢' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER II\./ }).click();
    await ready(page);
    // Read to the end of chapter II, page by page.
    for (let i = 0; i < 60; i++) {
      if (await page.getByTestId('chapter-end').isVisible()) break;
      await page.getByTestId('next-page').click();
      await page.waitForTimeout(150);
    }
    const card = page.getByTestId('chapter-end');
    await expect(card).toContainText('End of Chapter 2');
    await expect(card).toContainText('1 note from Ana');
    // It covers the footer, never the first lines of the new chapter, and its buttons too.
    await expectInFooter(page, card);
    await card.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByTestId('sheet-note-text')).toHaveText('A pool of her own tears!');
    await ctx.close();
  });

  test('finishing the book is celebrated, with who else is done', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben', 'Cleo']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { sections: { textLength: number }[]; toc: { title: string; section: number }[] };
    const last = pub.toc.find((e) => e.title.startsWith('CHAPTER XII.'))!.section;
    await putProgress(club.members.Ana!, book.id, epub.id, { kind: 'epub', section: last, offset: pub.sections[last]!.textLength }, [
      { from: { kind: 'epub', section: 2, offset: 0 }, to: { kind: 'epub', section: last, offset: pub.sections[last]!.textLength } },
    ]);
    // Ben is in chapter 2; Cleo has not started.
    await putProgress(club.members.Ben!, book.id, epub.id, { kind: 'epub', section: 3, offset: 0 }, [{ from: { kind: 'epub', section: 2, offset: 0 }, to: { kind: 'epub', section: 3, offset: 0 } }]);
    // Olive has read the book up to a few pages from the end (a saved place: a link there would
    // be a visit, not reading).
    const near = { kind: 'epub' as const, section: last, offset: Math.max(0, pub.sections[last]!.textLength - 4000) };
    await putProgress(club.owner, book.id, epub.id, near, [{ from: { kind: 'epub', section: 2, offset: 0 }, to: near }]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    for (let i = 0; i < 30; i++) {
      if (await page.getByTestId('finished-card').isVisible()) break;
      await page.getByTestId('next-page').click();
      await page.waitForTimeout(150);
    }
    const card = page.getByTestId('finished-card');
    await expect(card).toHaveAttribute('data-finished', 'true');
    await expect(card).toContainText('Ana finished too.');
    await expect(card).toContainText('1 friend is still reading and 1 has not started: keep it quiet.');
    await page.getByRole('link', { name: 'See the discussion' }).click();
    await expect(page.getByTestId('member-progress').filter({ hasText: 'You' })).toContainText('Finished', { timeout: 10_000 });
    await ctx.close();
  });

  test('the end is a moment, not a nag: paging on into the licence and back does not bring it back, and the book reopens at the story’s end', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { sections: { textLength: number }[]; toc: { title: string; section: number }[] };
    const last = pub.toc.find((e) => e.title.startsWith('CHAPTER XII.'))!.section;
    const near = { kind: 'epub' as const, section: last, offset: Math.max(0, pub.sections[last]!.textLength - 4000) };
    await putProgress(club.members.Ana!, book.id, epub.id, near, [{ from: { kind: 'epub', section: 2, offset: 0 }, to: near }]);
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    const reader = page.getByTestId('reader');
    for (let i = 0; i < 30; i++) {
      if (await page.getByTestId('finished-card').isVisible()) break;
      await page.getByTestId('next-page').click();
      await page.waitForTimeout(150);
    }
    await expect(page.getByTestId('finished-card')).toHaveAttribute('data-finished', 'true');
    const storyEnd = { section: (await reader.getAttribute('data-section'))!, start: (await reader.getAttribute('data-start'))! };
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('finished-card')).toHaveCount(0);

    // On into the licence after the story, back to the last page, and on again: each turn forward
    // is saved and the server asked again whether that finished it, and no second card comes.
    const turn = async (testId: 'next-page' | 'prev-page') => {
      const checks = Number(await reader.getAttribute('data-end-checks'));
      const before = await reader.getAttribute('data-start');
      await page.getByTestId(testId).click();
      await expect(reader).not.toHaveAttribute('data-start', before!);
      // Forward onto a page at the story's end: saved, and the answer (finished or not) is in.
      if (testId === 'next-page') await expect(reader).toHaveAttribute('data-end-checks', String(checks + 1));
    };
    await turn('next-page');
    await expect(page.getByTestId('finished-card')).toHaveCount(0);
    await turn('next-page');
    await turn('prev-page');
    await turn('next-page');
    await expect(page.getByTestId('finished-card')).toHaveCount(0);

    // Reopened, the book is at the story's end, not in the licence.
    await page.reload();
    await ready(page);
    await expect(reader).toHaveAttribute('data-section', storyEnd.section);
    await expect(reader).toHaveAttribute('data-start', storyEnd.start);
    await expect(page.getByTestId('finished-card')).toHaveCount(0);
    await ctx.close();
  });

  test('jumping to the end and paging to the last page is not finishing the book', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER XII\./ }).click();
    await ready(page);
    for (let i = 0; i < 60; i++) {
      if (await page.getByTestId('finished-card').isVisible()) break;
      await page.getByTestId('next-page').click();
      await page.waitForTimeout(150);
    }
    const card = page.getByTestId('finished-card');
    await expect(card).toHaveAttribute('data-finished', 'false');
    await expect(page.getByRole('dialog', { name: 'You reached the end' })).toBeVisible();
    await expect(card).toContainText('does not count as finished yet');
    await page.getByRole('link', { name: 'See the discussion' }).click();
    const me = page.getByTestId('member-progress').filter({ hasText: 'You' });
    await expect(me).toContainText('Chapter 12');
    await expect(me).not.toContainText('Finished');
    await ctx.close();
  });

  test('"I have already read up to here" opens the notes before this page', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: { kind: 'epub', section: 4, offset: 50 }, text: 'Caucus race!' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}&at=0.5`);
    await ready(page);
    await page.getByTestId('open-toc').click();
    await page.getByTestId('read-up-to-here').click();
    await answerQuestion(page, 'Mark everything up to this page as read?', 'Mark as read');
    await expect(page.getByText('1 note before here is now open to you.')).toBeVisible();
    const comments = (await (await page.request.get(`/api/books/${book.id}/comments`)).json()) as { hidden: boolean; text?: string }[];
    expect(comments[0]).toMatchObject({ hidden: false, text: 'Caucus race!' });
    await ctx.close();
  });

  test('"Go to passage" from the discussion opens the book at the note', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: 8, offset: 500 }, text: 'Croquet with flamingos', reaction: '😂' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.getByRole('button', { name: 'Go to passage' }).click();
    await ready(page);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', '8');
    await expect(page.getByTestId('sheet-note-text')).toHaveText('Croquet with flamingos');
    await expect(page.getByTestId('margin-marker')).toHaveCount(1);
    await ctx.close();
  });

  test('a link inside the book (the contents table) goes to the chapter', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await ready(page);
    const frame = page.frameLocator('iframe.epub-frame');
    const link = frame.getByRole('link', { name: 'CHAPTER V.' });
    // On the page in front of the reader, not merely laid out on a page further on.
    const onScreen = async () => {
      const [box, viewport] = await Promise.all([link.boundingBox(), page.locator('.epub-viewport').boundingBox()]);
      return !!box && !!viewport && box.x >= viewport.x && box.x + box.width <= viewport.x + viewport.width;
    };
    // The book opens at its title page; the contents table follows it.
    for (let i = 0; i < 8 && !(await onScreen()); i++) await page.getByTestId('next-page').click();
    expect(await onScreen()).toBe(true);
    await link.click();
    await expect(page.locator('.reader-chapter')).toContainText('Advice from a Caterpillar');
    await ctx.close();
  });

  test('the PDF has the moment too: finishing a chapter shows what friends said in it', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const first = (title: string) => Math.floor(pdf.units.find((u) => u.title.startsWith(title))!.m);
    const ch2 = first('CHAPTER II.');
    const ch3 = first('CHAPTER III.');
    await postComment(club.members.Ana!, book.id, { editionId: pdf.id, locator: { kind: 'pdf', page: ch2 + 1, y: 0.5 }, text: 'Tears in the PDF', reaction: '😢' });
    // Olive's place: the first page of chapter II.
    await putProgress(club.owner, book.id, pdf.id, { kind: 'pdf', page: ch2, y: 0 }, []);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-page-index', String(ch2), { timeout: 30_000 });
    for (let p = ch2; p < ch3; p++) {
      await page.getByTestId('next-page').click();
      await expect(page.getByTestId('reader')).toHaveAttribute('data-page-index', String(p + 1));
    }
    const card = page.getByTestId('chapter-end');
    await expect(card).toContainText('End of Chapter 2');
    await expect(card).toContainText('1 note from Ana');
    // It covers the footer, never the first lines of the new chapter, and its buttons too.
    await expectInFooter(page, card);
    await card.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByTestId('sheet-note-text')).toHaveText('Tears in the PDF');
    await ctx.close();
  });

  test('listening: a friend’s note is announced as you pass it, and a chapter’s end shows what was said in it', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    await postComment(club.members.Ana!, book.id, { editionId: audio.id, locator: { kind: 'audio', track: 1, ms: 1500 }, text: 'Listen to this bit', reaction: '😂' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen`);
    await page.getByTestId('toggle-tracks').click();
    await page.locator('.track-item').nth(1).click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    // A chapter from the list is a look until Play (D72).
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    const cue = page.getByTestId('note-cue');
    await expect(cue).toContainText('Ana left a note here', { timeout: 10_000 });
    await cue.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByTestId('sheet-note-text')).toHaveText('Listen to this bit');
    await page.keyboard.press('Escape');
    // The track plays on to its end and the next chapter begins.
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '2', { timeout: 20_000 });
    const card = page.getByTestId('chapter-end');
    await expect(card).toContainText('End of Chapter 2');
    await expect(card).toContainText('1 note from Ana');
    await ctx.close();
  });
});
