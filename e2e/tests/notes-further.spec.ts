import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { type CommentView, type Edition, type EpubLocator, locatorToT, tToLocator } from '@bookclub/shared';
import { browserAs, clubWithAlice, placeSaved, postComment, putProgress } from '../helpers/api';

/*
 * Fidelity review round 13: a note written from further on is held, and its writer is told so
 * before posting and may say it is only about this passage (S2); a note made in another format that
 * opens a little after its place says so, rather than that it is ahead of you, and is told as it
 * opens (M2).
 */

type Pub = { sections: { textLength: number }[]; toc: { title: string; section: number }[] };

const at = (section: number, offset: number): EpubLocator => ({ kind: 'epub', section, offset });
const timeline = (edition: Edition) => ({ geometry: edition.geometry!, sync: edition.sync! });

async function ready(page: Page) {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

/** The page of the EPUB in front of the reader: its section and where it starts and ends there. */
async function onScreen(page: Page): Promise<{ section: number; start: number; end: number }> {
  const reader = page.getByTestId('reader');
  const [section, start, end] = await Promise.all(['data-section', 'data-start', 'data-end'].map(async (name) => Number(await reader.getAttribute(name))));
  return { section: section!, start: start!, end: end! };
}

/** A person's notes as the server gives them to them. */
async function notesFor(page: Page, bookId: string): Promise<CommentView[]> {
  return (await (await page.request.get(`/api/books/${bookId}/comments`)).json()) as CommentView[];
}

/** No serious or critical WCAG 2.1 A/AA violation on the page as it is now, as tests/a11y.spec.ts asks of every page. */
async function expectAccessible(page: Page, label: string) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity || a.playState === 'finished'));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`),
    `${label} has serious or critical accessibility violations`,
  ).toEqual([]);
}

test.describe('a note from further on, and one made in another format', () => {
  test('a friend who has read the whole book welcomes a new one on an early page: only about this passage, it is read there; posted plainly, it waits, and its writer is told so', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Hana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const ch1 = pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section;
    const last = pub.sections.length - 1;
    // Olive, the organiser, has finished the book.
    await putProgress(club.owner, book.id, epub.id, at(last, pub.sections[last]!.textLength), [{ from: at(0, 0), to: at(last, pub.sections[last]!.textLength) }]);

    // She goes back to chapter I from the contents, and leaves two notes on its first page.
    const oliveCtx = await browserAs(browser, club.owner);
    const olive = await oliveCtx.newPage();
    await olive.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(olive);
    await olive.getByTestId('open-toc').click();
    await olive.getByRole('button', { name: /CHAPTER I\./ }).click();
    await expect(olive.getByTestId('reader')).toHaveAttribute('data-section', String(ch1));
    await ready(olive);
    const write = async (text: string, how: 'note-submit' | 'note-submit-about-here') => {
      await olive.getByTestId('add-note').click();
      // The note form tells her the truth: she has read to the end and Hana has not, so Hana reads
      // her words once she has read that far, unless Olive says they are only about this passage.
      await expect(olive.getByTestId('note-from-further')).toContainText('You have read on to Chapter 12. Hana has not read as far as you: your note waits until they have, unless it is only about this passage.');
      await expect(olive.getByText(/Friends who have not read this far see only/)).toHaveCount(0);
      await olive.getByTestId('note-text').fill(text);
      if (how === 'note-submit-about-here') await expectAccessible(olive, 'the note form, written from further on');
      await olive.getByTestId(how).click();
      await expect(olive.getByTestId('note-text')).toHaveCount(0);
    };
    await write('Welcome to the club, Hana!', 'note-submit-about-here');
    await write('Wait until you meet the Queen of Hearts!', 'note-submit');

    // The one she posted plainly carries the horizon it waits on; "about this passage" waits on
    // nothing (Cole did not want the writer told this on the book page, fidelity feedback).
    await olive.goto(`/books/${book.id}`);
    const mine = await notesFor(olive, book.id);
    const welcome = mine.find((c) => !c.hidden && c.text === 'Welcome to the club, Hana!')!;
    const queenOfHearts = mine.find((c) => !c.hidden && c.text === 'Wait until you meet the Queen of Hearts!')!;
    expect(queenOfHearts.horizon).toBe('Chapter 12');
    expect(welcome.horizon).toBeFalsy();
    const place = welcome.locator as EpubLocator;
    expect(place.section).toBe(ch1);

    // Hana is just starting: she reads the page the notes are on.
    await putProgress(club.members.Hana!, book.id, epub.id, place, [{ from: at(ch1, 0), to: at(ch1, place.offset + 100) }]);
    const hanaCtx = await browserAs(browser, club.members.Hana!);
    const hana = await hanaCtx.newPage();
    await hana.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(hana);
    await expect(hana.getByTestId('reader')).toHaveAttribute('data-section', String(ch1));
    const marker = hana.getByTestId('margin-marker');
    await expect(marker).toHaveCount(1);
    await marker.click();
    const sheet = hana.getByTestId('marker-sheet');
    // The welcome, only about this passage, is hers to read; the other waits, and says for what.
    await expect(sheet.getByTestId('sheet-note-text')).toHaveText('Welcome to the club, Hana!');
    await expect(sheet.getByTestId('sheet-note-held')).toHaveText('Olive wrote this from Chapter 12 · it opens when you get there');
    await expect(sheet).not.toContainText('Queen of Hearts');
    await hana.keyboard.press('Escape');
    // Writing where she is reading, nothing of hers waits: the form says what it always said.
    await hana.getByTestId('add-note').click();
    await expect(hana.getByText(/Friends who have not read this far see only a marker, never your words\./)).toBeVisible();
    await expect(hana.getByTestId('note-from-further')).toHaveCount(0);
    await expect(hana.getByTestId('note-submit-about-here')).toHaveCount(0);
    await hana.keyboard.press('Escape');

    // The book page says the same, and nothing of the held note's words reaches her.
    await hana.goto(`/books/${book.id}`);
    await expect(hana.getByTestId('note').filter({ hasText: 'Welcome to the club, Hana!' })).toHaveAttribute('data-hidden', 'false');
    const held = hana.locator('[data-testid=note][data-hidden=true]');
    await expect(held).toHaveCount(1);
    await expect(held).toContainText('Olive wrote this from Chapter 12: it opens when you get there.');
    expect(JSON.stringify(await notesFor(hana, book.id))).not.toContain('Queen of Hearts');
    await Promise.all([oliveCtx.close(), hanaCtx.close()]);
  });

  test('a listener’s note on the very page a reader is on says it opens a little further on, not that it is ahead, and opens as she reads on', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ben', 'Hana'], { audio: 'librivox' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const ch2 = pub.toc.find((e) => e.title.startsWith('CHAPTER II.'))!.section;
    // Hana reads the EPUB, and is in the middle of chapter II.
    await putProgress(club.members.Hana!, book.id, epub.id, at(ch2, 3000), [{ from: at(ch2 - 1, 0), to: at(ch2, 3000) }]);
    const ctx = await browserAs(browser, club.members.Hana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    const here = await onScreen(page);
    expect(here.section).toBe(ch2);

    // Ben, listening, sighs with a word at the moment the narrator reads the last line of her page.
    const words = at(here.section, here.end - 40);
    const heard = tToLocator(timeline(audio), locatorToT(timeline(epub), words));
    expect(heard.kind).toBe('audio');
    const note = await postComment(club.members.Ben!, book.id, { editionId: audio.id, locator: heard, text: 'Poor Alice, a pool of tears', reaction: '😢' });

    // On her page, its marker: closed, though she has read its place.
    await page.reload();
    await ready(page);
    expect(await onScreen(page)).toEqual(here);
    const marker = page.getByTestId('margin-marker').filter({ hasText: '😢' });
    await expect(marker).toHaveAttribute('data-hidden', 'true');
    await marker.click();
    const sheet = page.getByTestId('marker-sheet');
    await expect(sheet.getByTestId('sheet-note-near')).toHaveText('Ben wrote this while listening, about here · it opens a little further on, once you are surely past it');
    await expect(sheet).not.toContainText('You have not read this far yet.');
    await expect(sheet.getByTestId('sheet-note-text')).toHaveCount(0);
    expect(JSON.stringify(await notesFor(page, book.id))).not.toContain('pool of tears');
    await expectAccessible(page, 'the note sheet, with a note that opens a little further on');
    await page.keyboard.press('Escape');

    // She reads on: a page or two later it opens, and she is told, the page with it behind her.
    const told = page.locator('.toast-region').getByText('Ben’s note in Chapter 2 is open now: you are surely past it.').waitFor({ timeout: 60_000 });
    let turned = 0;
    for (; turned < 6; turned++) {
      if (!(await notesFor(page, book.id)).find((c) => c.id === note.id)!.hidden) break;
      await page.getByTestId('next-page').click();
      await expect.poll(async () => (await onScreen(page)).start).not.toBe(here.start);
      await placeSaved(page, book.id);
    }
    expect(turned).toBeGreaterThan(0);
    expect((await notesFor(page, book.id)).find((c) => c.id === note.id)).toMatchObject({ hidden: false, text: 'Poor Alice, a pool of tears' });
    await told;
    // On the bar, it takes her back to its passage, open.
    const onBar = page.getByTestId('bar-comment').filter({ hasText: '😢' });
    await expect(onBar).toHaveAttribute('data-hidden', 'false');
    await onBar.click();
    await expect(page.getByTestId('sheet-note-text')).toHaveText('Poor Alice, a pool of tears');
    await ctx.close();
  });

  test('a reader’s note that opens once a listener is past it is told as it opens, with how far back it is', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const ch3 = pub.toc.find((e) => e.title.startsWith('CHAPTER III.'))!.section;
    // Ana's note near the start of chapter III, in the EPUB. These tracks are a few seconds each, so
    // a note made in another format opens only once all of its chapter is heard (D63).
    const note = await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: at(ch3, 300), text: 'Curiouser and curiouser!', reaction: '🤯' });
    const heard = tToLocator(timeline(audio), note.t);
    expect(heard).toMatchObject({ kind: 'audio', track: 2 });
    expect(heard.kind === 'audio' ? heard.ms : Infinity).toBeLessThan(1000);

    // Olive listens from chapter II on: chapter III is heard from its first moment to its last.
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen`);
    await page.getByTestId('toggle-tracks').click();
    await page.locator('.track-item').nth(1).click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    // The chapter heard to its end, the note opens behind the listener: told, and how far back.
    const cue = page.getByTestId('note-cue');
    await expect(cue).toContainText(/🤯 Ana left a note \d+ s back/, { timeout: 45_000 });
    await expect(cue).not.toContainText('left a note here');
    await cue.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByTestId('sheet-note-text')).toHaveText('Curiouser and curiouser!');
    await ctx.close();
  });

  test('in the PDF and in the player too, a note written from further on says it waits, and may be only about its passage', async ({ browser }) => {
    // Hana has not started: a note from further on waits for her (with no friend behind, nothing is asked).
    const { club, book } = await clubWithAlice(['Hana'], { pdf: true, audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const last = pub.sections.length - 1;
    // Olive has read the whole book, in the EPUB.
    await putProgress(club.owner, book.id, epub.id, at(last, pub.sections[last]!.textLength), [{ from: at(0, 0), to: at(last, pub.sections[last]!.textLength) }]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const write = async (text: string, how: 'note-submit' | 'note-submit-about-here') => {
      await page.getByTestId('add-note').click();
      await expect(page.getByTestId('note-from-further')).toContainText('You have read on to Chapter 12. Hana has not read as far as you: your note waits until they have');
      await page.getByTestId('note-text').fill(text);
      await page.getByTestId(how).click();
      await expect(page.getByTestId('note-text')).toHaveCount(0);
    };

    // Back at chapter I in the PDF, from its contents: only about this passage.
    const ch1 = Math.floor(pdf.units.find((u) => u.title.startsWith('CHAPTER I.'))!.m);
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', String(pdf.pageCount), { timeout: 30_000 });
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER I\./ }).click();
    await expect(page.getByTestId('reader')).toHaveAttribute('data-page-index', String(ch1));
    await write('The PDF has the pictures', 'note-submit-about-here');

    // Back at chapter I in the player, from its track list: one of each.
    await page.goto(`/books/${book.id}/listen`);
    await page.getByTestId('toggle-tracks').click();
    await page.locator('.track-item').first().click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '0');
    await write('What a voice for the White Rabbit', 'note-submit-about-here');
    await write('Down the rabbit hole again', 'note-submit');

    // The ones only about their passage wait for nothing; the other for Chapter 12, as she is told.
    const mine = await notesFor(page, book.id);
    for (const [kind, text] of [['pdf', 'The PDF has the pictures'], ['audio', 'What a voice for the White Rabbit']] as const) {
      const note = mine.find((c) => c.kind === kind && !c.hidden && c.text === text);
      expect(note, text).toBeDefined();
      expect(note).not.toHaveProperty('horizon');
    }
    expect(mine.find((c) => !c.hidden && c.text === 'Down the rabbit hole again')).toMatchObject({ kind: 'audio', horizon: 'Chapter 12' });
    await ctx.close();
  });
});
