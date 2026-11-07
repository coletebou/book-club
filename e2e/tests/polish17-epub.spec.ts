import { type BrowserContextOptions, type Locator, type Page, expect, test } from '@playwright/test';
import type { BookDetail, Publication, ReadAlongTrack, Transcript } from '@bookclub/shared';
import {
  ALICE_TINY_DIR,
  type Person,
  aliceEpub,
  audioFolder,
  bookFrame,
  browserAs,
  heardBetween,
  librivoxWords,
  madeFile,
  makeClub,
  png,
  postComment,
  putProgress,
  sha256Of,
  standardEbook,
  uploadBook,
} from '../helpers/api';

/**
 * Fidelity review round 17, end to end: an EPUB's own back matter after its story (FR150), a tall
 * cover shown whole (FR151), a recording's opening never lined up with the contents (FR154), the
 * chapters inside a track that holds several (FR152), and the player's words and the club bar's
 * flag (FR157).
 */

const PHONE: BrowserContextOptions = { viewport: { width: 393, height: 659 }, isMobile: true, hasTouch: true };
const COMPUTER: BrowserContextOptions = { viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false };
const SIZES = [
  ['a phone', PHONE],
  ['a computer', COMPUTER],
] as const;

async function ready(page: Page) {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

async function publicationOf(person: Person, book: BookDetail): Promise<Publication> {
  const epub = book.editions.find((e) => e.kind === 'epub')!;
  return (await (await person.api.get(epub.publicationUrl!)).json()) as Publication;
}

/** Give an audiobook this transcript and wait until it is lined up with the text. */
async function lineUp(person: Person, book: BookDetail, transcript: Transcript, done: (detail: BookDetail) => boolean = () => true): Promise<BookDetail> {
  const audio = book.editions.find((e) => e.kind === 'audio')!;
  let res = await person.api.put(`/api/editions/${audio.id}/transcript`, { data: transcript });
  for (let i = 0; res.status() === 503 && i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    res = await person.api.put(`/api/editions/${audio.id}/transcript`, { data: transcript });
  }
  expect(res.status(), await res.text()).toBe(202);
  for (let i = 0; i < 120; i++) {
    const detail = (await (await person.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    if (detail.editions.find((e) => e.id === audio.id)?.readAlong && done(detail)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the audiobook was not lined up');
}

/**
 * Whether a picture, as the page draws it, shows the whole of a tall cover made for the test: its
 * box and its file 2:3 (object-fit fills that box with nothing cut), the cover's red top band in its
 * first rows and its blue bottom band in its last, the app's dark ground beside it.
 */
async function drawnWhole(img: Locator): Promise<{ boxRatio: number; fileRatio: number; top: number[]; bottom: number[]; side: number[] }> {
  await expect(img).toHaveJSProperty('complete', true);
  return img.evaluate((el: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const g = canvas.getContext('2d')!;
    g.drawImage(el, 0, 0);
    const at = (x: number, y: number) => [...g.getImageData(Math.round(x * (canvas.width - 1)), Math.round(y * (canvas.height - 1)), 1, 1).data.slice(0, 3)];
    const box = el.getBoundingClientRect();
    return { boxRatio: box.width / box.height, fileRatio: el.naturalWidth / el.naturalHeight, top: at(0.5, 0.012), bottom: at(0.5, 0.988), side: at(0.01, 0.5) };
  });
}

function expectWholeCover(drawn: Awaited<ReturnType<typeof drawnWhole>>, where: string) {
  expect(drawn.boxRatio, where).toBeCloseTo(2 / 3, 1);
  expect(drawn.fileRatio, where).toBeCloseTo(2 / 3, 2);
  // Red along the top (the title), blue along the bottom (the author): its whole height is there.
  expect(drawn.top[0]!, where).toBeGreaterThan(150);
  expect(drawn.top[2]!, where).toBeLessThan(90);
  expect(drawn.bottom[2]!, where).toBeGreaterThan(150);
  expect(drawn.bottom[0]!, where).toBeLessThan(90);
  // Beside it the dark ground, where filling the frame would have cut it.
  expect(drawn.side.reduce((a, b) => a + b, 0), where).toBeLessThan(3 * 50);
}

test.describe('fidelity review round 17', () => {
  test('reading to the story’s last page finishes the book; the colophon and its licence come after it, listed apart (FR150)', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const book = await uploadBook(club.owner, club.id, 'epub', [madeFile('the-strange-case.epub', standardEbook(), 'application/epub+zip')], { title: 'The Strange Case', author: 'An Author' });
    // The book's chapters are its story's: no title page or imprint, no colophon or licence.
    expect(book.chapters.map((c) => c.title)).toEqual(['Story of the Door', 'Search for Mr. Hyde', 'Henry Jekyll’s Full Statement of the Case']);
    const pub = await publicationOf(club.owner, book);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const section = (title: string) => pub.toc.find((e) => e.title === title)!.section;
    const last = section('Henry Jekyll’s Full Statement of the Case');
    // Ana has read the book to a page or two before the last chapter's end.
    const near = { kind: 'epub' as const, section: last, offset: Math.max(0, pub.sections[last]!.textLength - 900) };
    await putProgress(club.members.Ana!, book.id, epub.id, near, [{ from: { kind: 'epub', section: section('Story of the Door'), offset: 0 }, to: near }]);

    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(page);
    const reader = page.getByTestId('reader');
    for (let i = 0; i < 20; i++) {
      if (await page.getByTestId('finished-card').isVisible()) break;
      await page.getByTestId('next-page').click();
      await page.waitForTimeout(200);
    }
    // On the story's last page, the last chapter's: finished, the colophon not yet reached.
    const card = page.getByTestId('finished-card');
    await expect(card).toHaveAttribute('data-finished', 'true');
    await expect(reader).toHaveAttribute('data-section', String(last));
    await expect(page.getByTestId('percent')).toHaveText('100%');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);

    // The colophon is after the story, to read: no chapter of it, no page number, no second card.
    const checks = Number(await reader.getAttribute('data-end-checks'));
    await page.getByTestId('next-page').click();
    await expect(reader).toHaveAttribute('data-section', String(section('Colophon')));
    await expect(reader).toHaveAttribute('data-end-checks', String(checks + 1));
    await expect(bookFrame(page).getByRole('heading', { name: 'Colophon' })).toBeVisible();
    await expect(page.locator('.reader-chapter')).toHaveText('After the story');
    await expect(page.getByTestId('finished-card')).toHaveCount(0);

    // The contents: the story's chapters, then the book's own matter after it, apart, none "ahead".
    await page.getByTestId('open-toc').click();
    const contents = page.getByRole('dialog', { name: 'Contents' });
    const story = contents.getByRole('list').first();
    await expect(story.getByRole('button')).toHaveText([/^Story of the Door/, /^Search for Mr\. Hyde/, /^Henry Jekyll’s Full Statement of the Case/]);
    const after = contents.getByRole('list', { name: 'After the story' });
    await expect(after.getByRole('button')).toHaveText(['Colophon', 'Uncopyright']);
    await expect(after.locator('.is-ahead')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The book page says she has finished it.
    await page.goto(`/books/${book.id}`);
    await expect(page.getByTestId('member-progress').filter({ hasText: 'You' })).toContainText('Finished', { timeout: 10_000 });
    await ctx.close();

    // A newcomer opens it at the story's first page, its first chapter's; its title page and
    // imprint are before it, unnumbered, named by what they come before.
    const fresh = await browserAs(browser, club.owner);
    const first = await fresh.newPage();
    await first.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(first);
    await expect(first.getByTestId('reader')).toHaveAttribute('data-section', String(section('Story of the Door')));
    await expect(first.getByTestId('page-number')).toHaveAttribute('data-page', '1');
    await expect(first.locator('.reader-chapter')).toHaveText('Story of the Door');
    await first.getByTestId('prev-page').click();
    await expect(first.getByTestId('reader')).toHaveAttribute('data-section', String(section('Imprint')));
    await expect(first.getByTestId('page-number')).toHaveAttribute('data-page', '');
    await expect(first.locator('.reader-chapter')).toHaveText('Before Story of the Door');
    await fresh.close();
  });

  test('a cover taller than 2:3 is drawn whole: on the shelf, the book page, the player and the lock screen (FR151)', async ({ browser }) => {
    const club = await makeClub();
    // Gutenberg's Jekyll and Hyde: 500×862, its title along its top, its author along its bottom.
    const cover = png(500, 862, (y) => (y < 60 ? [210, 20, 20] : y >= 802 ? [20, 20, 210] : [240, 235, 220]));
    let book = await uploadBook(club.owner, club.id, 'epub', [madeFile('tall.epub', standardEbook({ title: 'A Tall Cover', cover }), 'application/epub+zip')], { title: 'A Tall Cover', author: 'An Author' });
    book = await uploadBook(club.owner, club.id, 'audio', audioFolder(ALICE_TINY_DIR).slice(0, 3), { title: book.title, author: book.author, bookId: book.id });
    expect(book.hasCover).toBe(true);
    // The full player's cover too, on a device that allows the full player (Settings, D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    expectWholeCover(await drawnWhole(page.getByTestId('book-card').getByTestId('book-cover')), 'the shelf');
    await page.goto(`/books/${book.id}`);
    expectWholeCover(await drawnWhole(page.locator('img.book-hero-cover')), 'the book page');
    await page.goto(`/books/${book.id}/listen`);
    expectWholeCover(await drawnWhole(page.locator('img.listen-cover')), 'the player');
    // The lock screen's artwork: square tiles at every size it is offered (D190), each the whole
    // cover at its full height, on a blurred copy of itself.
    await expect.poll(() => page.evaluate(() => navigator.mediaSession?.metadata?.artwork.length ?? 0)).toBe(5);
    const artwork = await page.evaluate(async () => {
      const out: { ratio: number; top: number[]; bottom: number[] }[] = [];
      for (const art of navigator.mediaSession.metadata!.artwork) {
        const bitmap = await createImageBitmap(await (await fetch(art.src)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const g = canvas.getContext('2d')!;
        g.drawImage(bitmap, 0, 0);
        const at = (y: number) => [...g.getImageData(Math.round(bitmap.width / 2), Math.round(y * (bitmap.height - 1)), 1, 1).data.slice(0, 3)];
        out.push({ ratio: bitmap.width / bitmap.height, top: at(0.012), bottom: at(0.988) });
      }
      return out;
    });
    for (const art of artwork) {
      expect(art.ratio).toBe(1);
      expect(art.top[0]!).toBeGreaterThan(150);
      expect(art.bottom[2]!).toBeGreaterThan(150);
    }
    await ctx.close();
  });

  test('at 0:00 the read-along shows the story’s first sentence, never the title page or the contents (FR154)', async ({ browser }) => {
    const club = await makeClub();
    let book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    const tiny = audioFolder(ALICE_TINY_DIR);
    book = await uploadBook(club.owner, club.id, 'audio', tiny, { title: book.title, author: book.author, bookId: book.id });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    // LibriVox's way: what the recording is, the book's title and author as its title page has them,
    // and chapters by the names its contents give them, before the narrator reads chapter one. What
    // the recogniser heard of chapters I to III follows, in the first three tracks.
    const preamble = (
      'Chapter one of Alice’s Adventures in Wonderland. This is a LibriVox recording. All LibriVox recordings are in the public domain. ' +
      'Alice’s Adventures in Wonderland, by Lewis Carroll. The Millennium Fulcrum Edition 3.0. Contents. Chapter one, Down the Rabbit-Hole. ' +
      'Chapter two, The Pool of Tears. Chapter three, A Caucus-Race and a Long Tale.'
    ).split(' ');
    const heard = librivoxWords();
    const transcript: Transcript = {
      format: 'bookclub-transcript/1',
      engine: 'e2e',
      tracks: audio.tracks.map((tr, k) => {
        const opening = k === 0 ? tr.durationMs * 0.3 : 200;
        return {
          sha256: sha256Of(tiny[k]!.path),
          durationMs: tr.durationMs,
          words: [...(k === 0 ? heardBetween(preamble, 100, opening - 100) : []), ...heardBetween(k < 3 ? heard[k]! : [], opening, tr.durationMs - 200)],
        };
      }),
    };
    book = await lineUp(club.owner, book, transcript);
    const pub = await publicationOf(club.owner, book);
    const chapterOne = pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section;
    // Every sentence the first track reads is the story's: none on the title page or in the contents.
    const track = (await (await club.owner.api.get(`/api/editions/${audio.id}/readalong?track=0`)).json()) as ReadAlongTrack;
    expect(track.text[0]).toBe('CHAPTER I.');
    expect(track.sentences.every(([section]) => section >= chapterOne)).toBe(true);

    // The full player, which this device allows (Settings, D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-ms', '0');
    // At 0:00 the read-along offers the story's first sentence, the chapter's heading: the one the
    // text begins with, the narrator not at it yet (LibriVox's opening, D184).
    await expect(page.getByTestId('readalong')).toHaveAttribute('data-state', 'before');
    await expect(page.getByTestId('readalong-line')).toHaveText('CHAPTER I.');
    for (const line of await page.getByTestId('readalong').getByRole('button').allTextContents()) {
      expect(line).not.toMatch(/Wonderland|Lewis Carroll|FULCRUM|^Contents/);
    }
    // Heard at 0:00, the place is the story's first chapter: following in the book opens it there.
    await putProgress(club.owner, book.id, audio.id, { kind: 'audio', track: 0, ms: 0 }, []);
    await page.getByTestId('readalong-open').click();
    await ready(page);
    await expect(page.getByTestId('reader')).toHaveAttribute('data-section', String(chapterOne));
    await expect(page.locator('.reader-chapter')).toContainText('CHAPTER I.');
    await ctx.close();
  });

  test('a track holding several chapters lists them under it, each to its start, and the player names the one heard (FR152)', async ({ browser }) => {
    const club = await makeClub();
    let book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    // Four tracks, as LibriVox cuts some recordings: each holds three of the twelve chapters.
    const tiny = audioFolder(ALICE_TINY_DIR);
    const four = [tiny[2]!, tiny[1]!, tiny[0]!, tiny[3]!].map((f, k) => ({ ...f, name: `alice_${String(3 * k + 1).padStart(2, '0')}-${String(3 * k + 3).padStart(2, '0')}_carroll.mp3` }));
    const titles = ['Chapters 01 to 03', 'Chapters 04 to 06', 'Chapters 07 to 09', 'Chapters 10 to 12'];
    book = await uploadBook(club.owner, club.id, 'audio', four, { title: book.title, author: book.author, bookId: book.id, trackTitles: titles });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    expect(audio.tracks.map((tr) => tr.title)).toEqual(titles);
    // What was heard of chapters I to III, a third of the first track each; the others heard nothing.
    const heard = librivoxWords();
    const first = audio.tracks[0]!.durationMs;
    const transcript: Transcript = {
      format: 'bookclub-transcript/1',
      engine: 'e2e',
      tracks: audio.tracks.map((tr, k) => ({
        sha256: sha256Of(four[k]!.path),
        durationMs: tr.durationMs,
        words: k === 0 ? [0, 1, 2].flatMap((c) => heardBetween(heard[c]!, 100 + (c * (first - 200)) / 3, 100 + ((c + 1) * (first - 200)) / 3 - 30)) : [],
      })),
    };
    book = await lineUp(club.owner, book, transcript, (detail) => (detail.editions.find((e) => e.kind === 'audio')!.tracks[0]!.chapters?.length ?? 0) === 3);
    const inside = book.editions.find((e) => e.kind === 'audio')!.tracks[0]!.chapters!;

    // The full player, which this device allows (Settings, D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await page.getByTestId('toggle-tracks').click();
    await expect(page.getByTestId('track-item')).toHaveText(titles.map((t) => new RegExp(`^${t}`)));
    const chapters = page.getByTestId('track-chapter');
    await expect(chapters).toHaveText([/^CHAPTER I\. Down the Rabbit-Hole/, /^CHAPTER II\. The Pool of Tears/, /^CHAPTER III\. A Caucus-Race and a Long Tale/]);
    // The second chapter, from the list: the first track at its start, and the player names it.
    await chapters.nth(1).click();
    const listen = page.getByTestId('listen-page');
    await expect(listen).toHaveAttribute('data-track', '0');
    await expect.poll(async () => Math.abs(Number(await listen.getAttribute('data-ms')) - inside[1]!.ms)).toBeLessThan(600);
    await expect(chapters.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('listen-title')).toHaveText('CHAPTER II. The Pool of Tears');
    await expect(page.getByTestId('listen-sub')).toHaveText('Chapters 01 to 03 · Lewis Carroll');
    await expect.poll(() => page.evaluate(() => navigator.mediaSession?.metadata?.title ?? null)).toBe('CHAPTER II. The Pool of Tears');
    // The track itself, from the list: its start, its first chapter's opening.
    await page.getByTestId('track-item').first().click();
    await expect(listen).toHaveAttribute('data-ms', '0');
    await expect(page.getByTestId('listen-title')).toHaveText('CHAPTER I. Down the Rabbit-Hole');
    // A track of one chapter heard (none here) is as it was: listed alone.
    await expect(page.getByTestId('track-item').nth(1)).toContainText('Chapters 04 to 06');
    await ctx.close();
  });

  test('the player names the chapter once: the track’s tag that repeats it is not said again under it (FR157)', async ({ browser }) => {
    const club = await makeClub();
    let book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    // As LibriVox tags a recording's tracks: "01 - STORY OF THE DOOR", here Alice's.
    const names = ['Down the Rabbit-Hole', 'The Pool of Tears', 'A Caucus-Race and a Long Tale', 'The Rabbit Sends in a Little Bill', 'Advice from a Caterpillar', 'Pig and Pepper', 'A Mad Tea-Party', 'The Queen’s Croquet-Ground', 'The Mock Turtle’s Story', 'The Lobster Quadrille', 'Who Stole the Tarts?', 'Alice’s Evidence'];
    book = await uploadBook(club.owner, club.id, 'audio', audioFolder(ALICE_TINY_DIR), { title: book.title, author: book.author, bookId: book.id, trackTitles: names.map((n, i) => `${String(i + 1).padStart(2, '0')} - ${n.toUpperCase()}`) });
    // The full player, which this device allows (Settings, D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen`);
    await expect(page.getByTestId('listen-title')).toHaveText('CHAPTER I. Down the Rabbit-Hole');
    await expect(page.getByTestId('listen-sub')).toHaveText('Lewis Carroll');
    await ctx.close();
  });

  for (const [label, size] of SIZES) {
    test(`on a new book’s bar no marker or group covers the next stop’s flag, nor it them, on ${label} (FR157)`, async ({ browser }) => {
      // Four friends and you, none started: you at the start, the four beside you ("+1").
      const club = await makeClub(['Ana', 'Ben', 'Cleo', 'Dee']);
      const book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
      const epub = book.editions.find((e) => e.kind === 'epub')!;
      // The next stop at the end of chapter I, near the start of the bar; a reaction just there.
      const stop = book.chapters.find((c) => c.title.startsWith('CHAPTER II.'))!;
      expect((await club.members.Ana!.api.put(`/api/books/${book.id}/meeting`, { data: { t: stop.t } })).ok()).toBe(true);
      const pub = await publicationOf(club.owner, book);
      await postComment(club.members.Ben!, book.id, { editionId: epub.id, locator: { kind: 'epub', section: pub.toc.find((e) => e.title.startsWith('CHAPTER II.'))!.section, offset: 0 }, reaction: '😱' });
      const ctx = await browserAs(browser, club.owner, size);
      const page = await ctx.newPage();
      for (const where of [`/books/${book.id}`, `/books/${book.id}/read?edition=${epub.id}`]) {
        await page.goto(where);
        const bar = page.getByTestId('club-bar').first();
        await expect(bar.getByTestId('member-group')).toHaveCount(1);
        await expect(bar.getByText('+1')).toBeVisible();
        const flag = (await bar.getByTestId('meeting-flag').boundingBox())!;
        const targets = [bar.getByTestId('member-group'), bar.locator('button[data-testid="member-marker"]'), bar.getByTestId('bar-comment'), bar.getByTestId('bar-comment-group')];
        let seen = 0;
        for (const target of targets) {
          for (const el of await target.all()) {
            const box = await el.boundingBox();
            if (!box) continue;
            seen++;
            const overlaps = box.x < flag.x + flag.width - 0.5 && box.x + box.width > flag.x + 0.5 && box.y < flag.y + flag.height - 0.5 && box.y + box.height > flag.y + 0.5;
            expect(overlaps, `${where}: ${await el.getAttribute('aria-label')} over the flag`).toBe(false);
          }
        }
        // You, the friends' group and the reaction, all measured.
        expect(seen).toBeGreaterThanOrEqual(3);
      }
      await ctx.close();
    });
  }
});
