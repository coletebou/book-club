import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { BookDetail, EpubLocator } from '@bookclub/shared';
import { FIXTURES, audioFolder, browserAs, makeClub, postComment, putProgress, uploadBook } from '../helpers/api';

/*
 * A club's own book, as fidelity review round 13 brought one (D77): Gutenberg's illustrated A
 * Christmas Carol, whose contents list title-page lines, a preface, pictures and each stave's
 * heading apart from its subtitle, and LibriVox's recording of it, tagged as LibriVox tags it.
 */
const CAROL_EPUB = { name: 'pg46-images.epub', path: path.join(FIXTURES, 'books/carol-gutenberg-46.epub'), type: 'application/epub+zip', role: 'main' as const };
const CAROL_AUDIO = path.join(FIXTURES, 'audio/carol-tiny');
const STAVES = ['Stave 1', 'Stave 2', 'Stave 3', 'Stave 4', 'Stave 5'];

type Toc = { title: string; section: number; offset: number; chapter?: boolean }[];

async function ready(page: Page) {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

async function carolClub(names: string[], withAudio: boolean) {
  const club = await makeClub(names);
  let book = await uploadBook(club.owner, club.id, 'epub', [CAROL_EPUB], { title: 'A Christmas Carol', author: 'Charles Dickens' });
  if (withAudio) book = await uploadBook(club.owner, club.id, 'audio', audioFolder(CAROL_AUDIO), { title: book.title, author: book.author, bookId: book.id });
  const epub = book.editions.find((e) => e.kind === 'epub')!;
  const toc = ((await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: Toc }).toc;
  const at = (title: string, past = 0): EpubLocator => {
    const e = toc.find((x) => x.title === title)!;
    return { kind: 'epub', section: e.section, offset: e.offset + past };
  };
  return { club, book, epub, toc, at };
}

test.describe('a club’s own A Christmas Carol and its LibriVox recording (D77)', () => {
  test('its staves are its chapters: the stops to choose, the place a friend is, the page in the stave past its picture', async ({ browser }) => {
    const { club, book, at } = await carolClub(['Ana'], false);
    expect(book.chapters.slice(-5).map((c) => c.title)).toEqual([
      'STAVE ONE. MARLEY’S GHOST.',
      'STAVE TWO. THE FIRST OF THE THREE SPIRITS.',
      'STAVE THREE. THE SECOND OF THE THREE SPIRITS.',
      'STAVE FOUR. THE LAST OF THE SPIRITS.',
      'STAVE FIVE. THE END OF IT.',
    ]);
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    // The stops a friend can choose: each stave's end, with its title, nothing of the front matter.
    await page.goto(`/books/${book.id}`);
    await page.getByTestId('meeting-set').click();
    const dialog = page.getByRole('dialog', { name: 'The next stop' });
    const titles = ['Marley’s Ghost', 'The First of the Three Spirits', 'The Second of the Three Spirits', 'The Last of the Spirits'];
    await expect(dialog.getByTestId('meeting-stop').locator('option')).toHaveText([...STAVES.slice(0, 4).map((s, i) => `The end of ${s} · ${titles[i]}`), 'The end of the book']);
    await dialog.getByRole('button', { name: 'Close' }).click();

    // Opened at its start, she is before the story's first stave, not "There are several editions…".
    await page.goto(`/books/${book.id}/read`);
    await ready(page);
    const owner = await browserAs(browser, club.owner);
    const ownerPage = await owner.newPage();
    await ownerPage.goto(`/books/${book.id}`);
    await expect(ownerPage.locator(`[data-testid="member-progress"][data-user="${club.members.Ana!.id}"]`)).toContainText('Before Stave 1', { timeout: 10_000 });

    // Her place just past the stave's picture: there, the page in the stave runs on. (The reader
    // open at the start saves its place as it closes: that save lands first, then the new place.)
    await page.close();
    const saved = async () => JSON.stringify(((await (await club.members.Ana!.api.get(`/api/books/${book.id}/progress`)).json()) as { mine: unknown }).mine);
    let before = await saved();
    await expect.poll(async () => {
      const now = await saved();
      const still = now === before;
      before = now;
      return still;
    }, { intervals: [500], timeout: 10_000 }).toBe(true);
    const picture = at('Marley’s Ghost', 20);
    await putProgress(club.members.Ana!, book.id, book.editions.find((e) => e.kind === 'epub')!.id, picture, [{ from: at('STAVE ONE.'), to: picture }]);
    const reading = await ctx.newPage();
    await reading.goto(`/books/${book.id}/read`);
    await ready(reading);
    const reader = reading.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-section', String(picture.section));
    await expect(reading.getByTestId('chapter-page')).not.toHaveAttribute('data-page', '1');
    const inStave = Number(await reading.getByTestId('chapter-page').getAttribute('data-page'));
    const ofStave = Number(await reading.getByTestId('chapter-page').getAttribute('data-total'));
    expect(inStave).toBeGreaterThan(1);
    expect(inStave).toBeLessThan(ofStave);
    // The contents list the staves by their names, the one she is in marked: no picture, no subtitle apart.
    await reading.getByTestId('open-toc').click();
    const contents = reading.getByRole('dialog', { name: 'Contents' });
    await expect(contents.getByRole('button', { name: /^STAVE ONE\. MARLEY’S GHOST\./ })).toHaveAttribute('aria-current', 'true');
    await expect(contents.getByRole('button', { name: /^STAVE FIVE\. THE END OF IT\./ })).toBeVisible();
    await expect(contents.getByRole('button', { name: /^Marley’s Ghost/ })).toHaveCount(0);
    await expect(contents.getByRole('button', { name: /^THE END OF IT\./ })).toHaveCount(0);
    await Promise.all([ctx.close(), owner.close()]);
  });

  test('its five tracks are matched to the five staves, and a note at the very end is no friend’s spoiler', async ({ browser }) => {
    const { club, book, at } = await carolClub(['Ben', 'Iris'], true);
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    expect(audio.alignment.unitToChapter).toEqual([7, 8, 9, 10, 11]);
    expect(audio.tracks.map((t) => t.title)).toEqual([
      "01 - Stave 1: Marley's Ghost",
      '02 - Stave 2: The First of the Three Spirits',
      '03 - Stave 3: The Second of the Three Spirits',
      '04 - Stave 4: The Last of the Spirits',
      '05 - Stave 5: The End of It',
    ]);
    // Its owner is told of nothing placed by guess.
    const ownerCtx = await browserAs(browser, club.owner);
    const ownerPage = await ownerCtx.newPage();
    await ownerPage.goto(`/books/${book.id}`);
    await expect(ownerPage.locator('[data-testid="edition"][data-kind="audio"]')).toBeVisible();
    await expect(ownerPage.getByTestId('placed-between')).toHaveCount(0);
    await expect(ownerPage.getByTestId('straight-line')).toHaveCount(0);

    // Ben, listening, half a second before the end of the last track.
    const last = audio.tracks[4]!;
    const ending = await postComment(club.members.Ben!, book.id, { editionId: audio.id, locator: { kind: 'audio', track: 4, ms: last.durationMs - 500 }, text: 'Tiny Tim, who did NOT die!' });
    // Iris has read to the first page of Stave Five, and opens the book there.
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await putProgress(club.members.Iris!, book.id, epub.id, at('STAVE FIVE.', 1200), [{ from: at('STAVE ONE.'), to: at('STAVE FIVE.', 1200) }]);
    const ctx = await browserAs(browser, club.members.Iris!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const note = page.locator(`[data-testid="note"][data-comment="${ending.id}"]`);
    await expect(note).toHaveAttribute('data-hidden', 'true');
    await expect(note).not.toContainText('Tiny Tim');
    // Read to the end of the story: there it is.
    const five = at('STAVE FIVE.');
    const detail = (await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    const pub = (await (await club.owner.api.get(detail.editions.find((e) => e.kind === 'epub')!.publicationUrl!)).json()) as { sections: { textLength: number }[] };
    await putProgress(club.members.Iris!, book.id, epub.id, { kind: 'epub', section: five.section, offset: pub.sections[five.section]!.textLength }, [
      { from: at('STAVE FIVE.', 1200), to: { kind: 'epub', section: five.section, offset: pub.sections[five.section]!.textLength } },
    ]);
    await page.reload();
    await expect(note).toHaveAttribute('data-hidden', 'false', { timeout: 10_000 });
    await expect(note).toContainText('Tiny Tim, who did NOT die!');
    await Promise.all([ctx.close(), ownerCtx.close()]);
  });

  test('a match by hand that would hear four tracks in the last stave is refused, naming the track', async ({ browser }) => {
    const { club, book } = await carolClub([], true);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const row = page.locator('[data-testid="edition"][data-kind="audio"]');
    await row.getByTestId('format-menu').click();
    await row.getByRole('button', { name: 'Match to chapters' }).click();
    const dialog = page.getByRole('dialog', { name: 'Match chapters' });
    // The staves to choose from are named as the book names them.
    await expect(dialog.getByLabel('02 - Stave 2: The First of the Three Spirits').locator('option', { hasText: 'Stave 5' })).toHaveCount(1);
    await dialog.getByLabel('02 - Stave 2: The First of the Three Spirits').selectOption({ label: 'Stave 5' });
    for (const n of [3, 4, 5]) await dialog.locator('select').nth(n - 1).selectOption({ label: '(no chapter starts here)' });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('With these chapters, “02 - Stave 2: The First of the Three Spirits” would be heard over far too little of the book. Check the chapter each part starts.');
    // Nothing changed.
    const detail = (await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    expect(detail.editions.find((e) => e.kind === 'audio')!.alignment.unitToChapter).toEqual([7, 8, 9, 10, 11]);
    await ctx.close();
  });
});
