import { type Page, expect, test } from '@playwright/test';
import { type Edition, type Locator, locatorToT } from '@bookclub/shared';
import { browserAs, clubWithAlice, placeSaved, postComment, putProgress, serverPlace } from '../helpers/api';

type Pub = { sections: { textLength: number }[]; toc: { title: string; section: number }[] };

async function ready(page: Page) {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

type Mine = { locator: Locator | null; furthest: number; readRanges: [number, number][]; at: number };

/** This person's reading of a book, as the server has it. */
async function mine(page: Page, bookId: string): Promise<Mine> {
  return ((await (await page.request.get(`/api/books/${bookId}/progress`)).json()) as { mine: Mine }).mine;
}

/** Where a place in an edition is on the book's timeline, as the server puts it. */
const tIn = (edition: Edition, l: Locator) => locatorToT({ geometry: edition.geometry!, sync: edition.sync! }, l);

/** Whether what was read holds a stretch of the timeline in one piece. */
const covers = (ranges: [number, number][], from: number, to: number) => ranges.some(([a, b]) => a <= from + 1e-6 && b >= to - 1e-6);

/** Whether a note is still closed to the person this page is signed in as. */
async function closed(page: Page, bookId: string, id: string): Promise<boolean> {
  const all = (await (await page.request.get(`/api/books/${bookId}/comments`)).json()) as { id: string; hidden: boolean }[];
  return all.find((c) => c.id === id)!.hidden;
}

/** A tap on the right of the text, as on a phone (not in the margin, where notes have their markers): the next page. */
async function tapNext(page: Page) {
  const box = (await page.locator('.epub-viewport').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
}

test.describe('going somewhere is not reading there', () => {
  test("a friend's note is a visit: your place stays where you were reading, and Back returns you there", async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const section = (title: string) => pub.toc.find((e) => e.title.startsWith(title))!.section;
    const ch3 = section('CHAPTER III.');
    const ch8 = section('CHAPTER VIII.');
    // Ana has read up to chapter VIII; Olive's note in chapter III is one she has read.
    await putProgress(club.members.Ana!, book.id, epub.id, { kind: 'epub', section: ch8, offset: 0 }, [
      { from: { kind: 'epub', section: 2, offset: 0 }, to: { kind: 'epub', section: ch8, offset: 0 } },
    ]);
    await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: ch3, offset: 200 }, text: 'The Caucus-race!' });

    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.getByRole('button', { name: 'Go to passage' }).click();
    await expect(page.getByTestId('sheet-note-text')).toHaveText('The Caucus-race!');
    // The link's place is used once and dropped from the address.
    await expect(page).not.toHaveURL(/[?&](at|comment)=/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', String(ch3));
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 8');

    // The reader saves a page 0.6 s after it settles; give a visit more than that to (not) be saved.
    await page.waitForTimeout(1500);
    await page.reload();
    await ready(page);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', String(ch8));
    const mine = (await (await page.request.get(`/api/books/${book.id}/progress`)).json()) as { mine: { locator: { section: number } } };
    expect(mine.mine.locator.section).toBe(ch8);

    // Visit again, and come back with Back.
    await page.goto(`/books/${book.id}`);
    await page.getByRole('button', { name: 'Go to passage' }).click();
    await expect(page.getByTestId('sheet-note-text')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('back-to-reading').click();
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', String(ch8));
    await expect(page.getByTestId('back-to-reading')).toHaveCount(0);
    await ctx.close();
  });

  test('a chapter from the contents is a look: the place stays (a listener’s too), friends still see you there, Back returns, and reading on moves it', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const ch4 = pub.toc.find((e) => e.title.startsWith('CHAPTER IV.'))!.section;
    const ch7 = pub.toc.find((e) => e.title.startsWith('CHAPTER VII.'))!.section;
    const ch7t = book.chapters.find((c) => c.title.startsWith('CHAPTER VII.'))!.t;
    // Ana has been listening: a second into chapter IV's track.
    const heard = { kind: 'audio' as const, track: 3, ms: 1000 };
    await putProgress(club.members.Ana!, book.id, audio.id, heard, [{ from: { kind: 'audio', track: 0, ms: 0 }, to: heard }]);
    // Olive reads too, and sees Ana on her club bar.
    const oliveCtx = await browserAs(browser, club.owner);
    const olive = await oliveCtx.newPage();
    await olive.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(olive);
    const anaOnOlive = olive.locator(`[data-testid=member-marker][data-user="${club.members.Ana!.id}"]`);

    // Ana opens the book: at the page of the moment she heard, which is reading there (the page is
    // read). Her place is still that moment, to the millisecond (D196): the page it opened at is
    // the same place in the book, as of when she heard it, and never replaces it.
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    const reader = page.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-section', String(ch4));
    const openedPage = Number(await reader.getAttribute('data-end'));
    await expect.poll(async () => (await mine(page, book.id)).furthest, { timeout: 10_000 }).toBeGreaterThanOrEqual(tIn(epub, { kind: 'epub', section: ch4, offset: openedPage }) - 1e-9);
    expect(await serverPlace(page, book.id)).toEqual(heard);
    const place = await serverPlace(page, book.id);
    await expect(anaOnOlive).toHaveAttribute('data-live', 'true', { timeout: 5000 });

    // Chapter VII from the contents, just to look: a way back, and nothing moves.
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER VII\./ }).click();
    await expect(reader).toHaveAttribute('data-section', String(ch7));
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 4');
    // More than the 0.6 s the reader takes to save a page: not saved, and friends still see her in chapter IV.
    await page.waitForTimeout(1500);
    expect(await serverPlace(page, book.id)).toEqual(place);
    expect(Number(await anaOnOlive.getAttribute('data-t'))).toBeLessThan(ch7t);

    // Back: where she was, to the character.
    await page.getByTestId('back-to-reading').click();
    await expect(reader).toHaveAttribute('data-section', String(ch4));
    await expect(page.getByTestId('back-to-reading')).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(await serverPlace(page, book.id)).toEqual(place);
    // The audiobook still goes on in chapter IV.
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '3', { timeout: 10_000 });

    // Contents again, and reading on there: now it is her place, and friends see her there. Chapter
    // VII is past where she has read, so a page turned there is not reading on yet; three are (D72).
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER VII\./ }).click();
    await expect(reader).toHaveAttribute('data-section', String(ch7));
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '2');
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 4');
    await page.getByTestId('next-page').click();
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('back-to-reading')).toHaveCount(0);
    await expect.poll(async () => ((await serverPlace(page, book.id)) as { section?: number } | null)?.section, { timeout: 10_000 }).toBe(ch7);
    await expect.poll(async () => Number(await anaOnOlive.getAttribute('data-t')), { timeout: 5000 }).toBeGreaterThanOrEqual(ch7t);
    await Promise.all([ctx.close(), oliveCtx.close()]);
  });

  test('paging on from a visit behind your place keeps it; Read from here makes it your place', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const ch3 = pub.toc.find((e) => e.title.startsWith('CHAPTER III.'))!.section;
    const ch8 = pub.toc.find((e) => e.title.startsWith('CHAPTER VIII.'))!.section;
    await putProgress(club.members.Ana!, book.id, epub.id, { kind: 'epub', section: ch8, offset: 0 }, [
      { from: { kind: 'epub', section: 2, offset: 0 }, to: { kind: 'epub', section: ch8, offset: 0 } },
    ]);
    await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: ch3, offset: 200 }, text: 'Read it again' });
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.getByRole('button', { name: 'Go to passage' }).click();
    await expect(page.getByTestId('sheet-note-text')).toHaveText('Read it again');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('marker-sheet')).toHaveCount(0);
    await ready(page);
    // Chapter III is behind her place: paging on there is finding a passage, not reading.
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 8');
    await page.waitForTimeout(1500);
    const place = async () => ((await (await page.request.get(`/api/books/${book.id}/progress`)).json()) as { mine: { locator: { section: number } } }).mine.locator.section;
    expect(await place()).toBe(ch8);
    // Unless she says so.
    await page.getByTestId('read-from-here').click();
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await expect.poll(place, { timeout: 20_000 }).toBe(ch3);
    await ctx.close();
  });

  test('flipping back to find a passage never loses your place: paging there, or reacting there, keeps it, and Back returns', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const ch2 = pub.toc.find((e) => e.title.startsWith('CHAPTER II.'))!.section;
    const ch7 = pub.toc.find((e) => e.title.startsWith('CHAPTER VII.'))!.section;
    const reading = { kind: 'epub' as const, section: ch7, offset: 600 };
    await putProgress(club.members.Ana!, book.id, epub.id, reading, [{ from: { kind: 'epub', section: 2, offset: 0 }, to: reading }]);
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    const reader = page.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-section', String(ch7));
    const place = async () => ((await (await page.request.get(`/api/books/${book.id}/progress`)).json()) as { mine: { locator: { section: number; offset: number } } }).mine.locator;
    await expect.poll(async () => (await place()).section, { timeout: 10_000 }).toBe(ch7);
    const before = await place();

    // Back to chapter II from the contents, two pages on, and a reaction there.
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER II\./ }).click();
    await expect(reader).toHaveAttribute('data-section', String(ch2));
    await page.getByTestId('next-page').click();
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 7');
    const frame = (await (await page.locator('iframe.epub-frame').elementHandle()).contentFrame())!;
    const start = Number(await reader.getAttribute('data-start'));
    await frame.evaluate((offset) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let at = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text;
        if (at + t.data.length > offset && t.data.trim().length > 20) {
          const from = Math.max(0, offset - at) + (t.data.slice(Math.max(0, offset - at)).search(/\S/) || 0);
          const r = document.createRange();
          r.setStart(t, from);
          r.setEnd(t, Math.min(t.data.length, from + 12));
          document.getSelection()!.removeAllRanges();
          document.getSelection()!.addRange(r);
          return;
        }
        at += t.data.length;
      }
    }, start);
    await page.getByTestId('react-shocked').click();
    await expect(page.getByText('😱 pinned here.')).toBeVisible();
    // Still a look: nothing moved (well past the 0.6 s the reader takes to save a page).
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 7');
    await page.waitForTimeout(1500);
    expect(await place()).toEqual(before);
    // Back: where she was reading, to the character; and a reload opens there too.
    await page.getByTestId('back-to-reading').click();
    await expect(reader).toHaveAttribute('data-section', String(ch7));
    await page.reload();
    await ready(page);
    await expect(reader).toHaveAttribute('data-section', String(ch7));
    expect(await place()).toEqual(before);
    await ctx.close();
  });

  test('a note ahead of you on the book page opens locked, and never takes you there', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: 10, offset: 300 }, text: 'Off with her head!', reaction: '😱' });
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const marker = page.getByTestId('bar-comment');
    await expect(marker).toHaveAttribute('data-hidden', 'true');
    await marker.click();
    const sheet = page.getByTestId('marker-sheet');
    await expect(sheet).toContainText('You have not read this far yet.');
    await expect(sheet).not.toContainText('Off with her head!');
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}$`));
    const comments = (await (await page.request.get(`/api/books/${book.id}/comments`)).json()) as { hidden: boolean }[];
    expect(comments[0]!.hidden).toBe(true);
    await ctx.close();
  });
});

test.describe('a peek past where you have read (D72)', () => {
  test('a peek far ahead and a page or two there keep your place, your marker and your reading; the third page there is reading on', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Fay']);
    const fay = club.members.Fay!;
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const section = (title: string) => pub.toc.find((e) => e.title.startsWith(title))!.section;
    const ch1 = section('CHAPTER I.');
    const ch10 = section('CHAPTER X.');
    const ch10t = book.chapters.find((c) => c.title.startsWith('CHAPTER X.'))!.t;
    // Fay is early in chapter I; Olive's note on the first page of chapter X is not hers to read yet.
    const reading = { kind: 'epub' as const, section: ch1, offset: 1500 };
    await putProgress(fay, book.id, epub.id, reading, [{ from: { kind: 'epub', section: ch1, offset: 0 }, to: reading }]);
    const note = await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: ch10, offset: 100 }, text: 'The Lobster Quadrille!' });
    // Olive reads too, and sees Fay on her club bar.
    const oliveCtx = await browserAs(browser, club.owner);
    const olive = await oliveCtx.newPage();
    await olive.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(olive);
    const fayOnOlive = olive.locator(`[data-testid=member-marker][data-user="${fay.id}"]`);

    const ctx = await browserAs(browser, fay);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    const reader = page.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-section', String(ch1));
    // Her page is read once it settles: what she has read, as it stands.
    await expect.poll(async () => (await mine(page, book.id)).furthest, { timeout: 10_000 }).toBeGreaterThan(tIn(epub, reading));
    const before = await mine(page, book.id);
    await expect(fayOnOlive).toHaveAttribute('data-live', 'true', { timeout: 5000 });

    // Chapter X from the contents, then a tap on the right of the page, and another.
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER X\./ }).click();
    await expect(reader).toHaveAttribute('data-section', String(ch10));
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '1');
    for (const n of ['2', '3']) {
      await tapNext(page);
      await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', n);
      await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 1');
    }
    // Well past the 0.6 s the reader takes to save a page: her place, what she has read and the
    // note are as they were, and Olive still sees her in chapter I.
    await page.waitForTimeout(1500);
    expect(await mine(page, book.id)).toEqual(before);
    expect(await closed(page, book.id, note.id)).toBe(true);
    expect(Number(await fayOnOlive.getAttribute('data-t'))).toBeLessThan(ch10t);

    // The third page: she is reading there. It is her place, the pages she turned through are read
    // (Olive's note on the first of them opens), and Olive sees her in chapter X.
    await tapNext(page);
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '4');
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await placeSaved(page, book.id);
    const start = Number(await reader.getAttribute('data-start'));
    const now = await mine(page, book.id);
    expect(covers(now.readRanges, tIn(epub, { kind: 'epub', section: ch10, offset: 0 }), tIn(epub, { kind: 'epub', section: ch10, offset: start }))).toBe(true);
    await expect.poll(() => closed(page, book.id, note.id), { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => Number(await fayOnOlive.getAttribute('data-t')), { timeout: 5000 }).toBeGreaterThanOrEqual(ch10t);
    await Promise.all([ctx.close(), oliveCtx.close()]);
  });

  test('Read from here after a peek far ahead makes it your place, with the pages turned through read', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Fay']);
    const fay = club.members.Fay!;
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const section = (title: string) => pub.toc.find((e) => e.title.startsWith(title))!.section;
    const ch1 = section('CHAPTER I.');
    const ch10 = section('CHAPTER X.');
    const reading = { kind: 'epub' as const, section: ch1, offset: 1500 };
    await putProgress(fay, book.id, epub.id, reading, [{ from: { kind: 'epub', section: ch1, offset: 0 }, to: reading }]);
    const note = await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: ch10, offset: 100 }, text: 'The Lobster Quadrille!' });
    const ctx = await browserAs(browser, fay);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    const reader = page.getByTestId('reader');
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER X\./ }).click();
    await expect(reader).toHaveAttribute('data-section', String(ch10));
    await page.getByTestId('next-page').click();
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '3');
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 1');
    expect(await closed(page, book.id, note.id)).toBe(true);
    // She says so: the page in front of her is her place, and the two before it are read too.
    await page.getByTestId('read-from-here').click();
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await placeSaved(page, book.id);
    const end = Number(await reader.getAttribute('data-end'));
    expect(covers((await mine(page, book.id)).readRanges, tIn(epub, { kind: 'epub', section: ch10, offset: 0 }), tIn(epub, { kind: 'epub', section: ch10, offset: end }))).toBe(true);
    await expect.poll(() => closed(page, book.id, note.id), { timeout: 10_000 }).toBe(false);
    await ctx.close();
  });

  test('a look behind where you have read is as before: a page turned there, ahead of your place, is reading on there', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const ana = club.members.Ana!;
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const section = (title: string) => pub.toc.find((e) => e.title.startsWith(title))!.section;
    const [ch1, ch3, ch7, ch11] = ['CHAPTER I.', 'CHAPTER III.', 'CHAPTER VII.', 'CHAPTER XI.'].map(section) as [number, number, number, number];
    // Ana has read to the end of chapter XI, and is reading chapter III again.
    const endOf11 = { kind: 'epub' as const, section: ch11, offset: pub.sections[ch11]!.textLength };
    await putProgress(ana, book.id, epub.id, { kind: 'epub', section: ch3, offset: 0 }, [{ from: { kind: 'epub', section: ch1, offset: 0 }, to: endOf11 }]);
    const ctx = await browserAs(browser, ana);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    const reader = page.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-section', String(ch3));
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER VII\./ }).click();
    await expect(reader).toHaveAttribute('data-section', String(ch7));
    await expect(page.getByTestId('back-to-reading')).toContainText('Back to Chapter 3');
    // One page on there is reading on there (D62): she has read it all before.
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '2');
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await placeSaved(page, book.id);
    expect(((await serverPlace(page, book.id)) as { section?: number } | null)?.section).toBe(ch7);
    await ctx.close();
  });

  test('in the PDF too: a peek far ahead is a look for two pages, Back returns, and the third page there is reading on', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Fay'], { pdf: true });
    const fay = club.members.Fay!;
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ch10 = Math.floor(pdf.units.find((u) => u.title.startsWith('CHAPTER X.'))!.m);
    // Fay has read the PDF's first two pages.
    await putProgress(fay, book.id, pdf.id, { kind: 'pdf', page: 1, y: 0 }, [{ from: { kind: 'pdf', page: 0, y: 0 }, to: { kind: 'pdf', page: 1, y: 1 } }]);
    const seeded = ((await (await fay.api.get(`/api/books/${book.id}/progress`)).json()) as { mine: { at: number } }).mine;
    const ctx = await browserAs(browser, fay);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    const reader = page.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-page-index', '1', { timeout: 30_000 });
    // The page in front of her is the place saved, opened there: no news once it settles (D196),
    // still her place as of when she read it.
    await page.waitForTimeout(1_500);
    expect((await mine(page, book.id)).at).toBe(seeded.at);
    const before = await mine(page, book.id);

    const toChapter10 = async () => {
      await page.getByTestId('open-toc').click();
      await page.getByRole('button', { name: /CHAPTER X\./ }).click();
      await expect(reader).toHaveAttribute('data-page-index', String(ch10));
    };
    await toChapter10();
    for (const n of [1, 2]) {
      await page.getByTestId('next-page').click();
      await expect(reader).toHaveAttribute('data-page-index', String(ch10 + n));
      await expect(page.getByTestId('back-to-reading')).toContainText('Back to page 2');
    }
    await page.waitForTimeout(1500);
    expect(await mine(page, book.id)).toEqual(before);
    // Back: to her page.
    await page.getByTestId('back-to-reading').click();
    await expect(reader).toHaveAttribute('data-page-index', '1');
    await expect(page.getByTestId('look-chip')).toHaveCount(0);

    // Chapter X again, and three pages on: she is reading there, and the pages turned through are read.
    await toChapter10();
    for (const n of [1, 2, 3]) {
      await page.getByTestId('next-page').click();
      await expect(reader).toHaveAttribute('data-page-index', String(ch10 + n));
    }
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await expect.poll(async () => ((await serverPlace(page, book.id)) as { page?: number } | null)?.page, { timeout: 20_000 }).toBe(ch10 + 3);
    const now = await mine(page, book.id);
    expect(covers(now.readRanges, tIn(pdf, { kind: 'pdf', page: ch10, y: 0 }), tIn(pdf, { kind: 'pdf', page: ch10 + 3, y: 1 }))).toBe(true);
    await ctx.close();
  });

  test('a friend\u2019s note opened during a peek far ahead keeps the look: it waits, your place stays', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Fay'], {});
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Pub;
    const ch3 = pub.toc.find((e) => e.title.startsWith('CHAPTER III.'))!.section;
    // Ana's note on the first page of chapter III; Fay has only just started.
    await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: { kind: 'epub', section: ch3, offset: 40 }, text: 'A Caucus-race!', reaction: '😂' });
    const ctx = await browserAs(browser, club.members.Fay!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    await expect.poll(async () => (await mine(page, book.id))?.at ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
    const before = await mine(page, book.id);
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER III\./ }).click();
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', String(ch3));
    // Its marker, where a finger would turn the page: opened, it is still Ana's note ahead of her.
    await page.getByTestId('margin-marker').first().click();
    await expect(page.getByTestId('marker-sheet')).toBeVisible();
    await expect(page.getByTestId('sheet-note').first()).toHaveAttribute('data-hidden', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('back-to-reading')).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await mine(page, book.id)).toEqual(before);
    // Asked, she reads there: the note opens, and it is her place now.
    await page.getByTestId('margin-marker').first().click();
    await page.getByTestId('sheet-read-here').click();
    await expect(page.getByTestId('sheet-note-text')).toHaveText('A Caucus-race!');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await ctx.close();
  });

  test('a link inside the book (its own contents) is a look too: your place stays, with a way back', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await ready(page);
    const link = page.frameLocator('iframe.epub-frame').getByRole('link', { name: 'CHAPTER V.' });
    // On the page in front of the reader, not merely laid out on a page further on.
    const onScreen = async () => {
      const [box, viewport] = await Promise.all([link.boundingBox(), page.locator('.epub-viewport').boundingBox()]);
      return !!box && !!viewport && box.x >= viewport.x && box.x + box.width <= viewport.x + viewport.width;
    };
    // The book opens at its title page; the contents table follows it.
    for (let i = 0; i < 8 && !(await onScreen()); i++) await page.getByTestId('next-page').click();
    expect(await onScreen()).toBe(true);
    await placeSaved(page, book.id);
    const place = await serverPlace(page, book.id);
    await link.click();
    await expect(page.locator('.reader-chapter')).toContainText('Advice from a Caterpillar');
    await expect(page.getByTestId('back-to-reading')).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await serverPlace(page, book.id)).toEqual(place);
    await page.getByTestId('back-to-reading').click();
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await expect(link).toBeVisible();
    await ctx.close();
  });
});
