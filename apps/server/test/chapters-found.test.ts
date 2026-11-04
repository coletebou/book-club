import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';
import { bodyTextWithBreaks, buildPublication } from '@bookclub/epub';
import {
  type BookDetail,
  type ClubDetail,
  CommentViewSchema,
  type CommentView,
  type Edition,
  type Locator,
  ProgressUpdateResultSchema,
  linearSyncMap,
  prettifyTrackTitle,
  tToM,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEdition } from '../src/ingest/pipeline';
import { HEAD_LINES, type PageHead, findChapterHeadings, readPageHeads } from '../src/ingest/pdf';
import { editionAlignment, editionById } from '../src/repos/books';
import { AUDIO_MARGIN_MS, CHAPTER_SHARE, LINE_SHARE } from '../src/services/gating';
import { craftM4b, mp3With, mpegFramesOf, textFrame } from './crafted-audio';
import {
  ALICE_EPUB,
  ALICE_PDF,
  ALICE_TINY_AUDIO,
  type Client,
  type TestApp,
  type UploadFile,
  audioTracks,
  bookDetail,
  closeApp,
  fileFrom,
  fileOf,
  joinClub,
  makeTestApp,
  setupOwner,
  uploadBook,
} from './helpers';

/*
 * The book's chapters found again where 26aabf0 (D73) lost them (D74). A fresh reviewer renamed the
 * LibriVox Alice's twelve files 01.mp3 to 12.mp3, tags stripped, and added them to the Alice EPUB:
 * they were called "Track 1" to "Track 12", taken for a CD's tracks, and lined up in a straight
 * line, so a listener 20 s into the seventh was shown in chapter 6 at 48 % and Cole's note on the
 * first sentence of CHAPTER VII opened 21 minutes of listening late. The Alice PDF without its
 * bookmarks was lined up the same way, its owner told nothing, and the same note opened for a PDF
 * reader only after page 55, in chapter VIII. (Lined up by its headings, it is then lined up with
 * the text line by line, D75: printed.test.ts.)
 */

/** The LibriVox Alice's twelve chapters, as measured: 2 h 59 min in all. */
const LIBRIVOX_MS = [640_584, 735_765, 1_064_016, 1_192_960, 809_169, 775_811, 1_046_352, 799_032, 908_016, 1_368_360, 619_872, 772_440];
const pad = (k: number) => String(k).padStart(2, '0');
/** Where the EPUB's entries for CHAPTER I to XII are among its fifteen: after its title page, edition's note and contents. */
const STORY_CHAPTERS = Array.from({ length: 12 }, (_, k) => k + 3);

/** The text of the Alice EPUB's section `i`, as readers measure it. */
const pub = buildPublication(new Uint8Array(readFileSync(ALICE_EPUB)));
const sectionText = (i: number) => bodyTextWithBreaks(new TextDecoder().decode(pub.files.get(pub.sections[i]!.path))).text;
/** Where the first sentence of CHAPTER VII starts in the EPUB: "There was a table set out under a tree…". */
const teaParty = (() => {
  const entry = pub.toc.find((e) => e.title.startsWith('CHAPTER VII.'))!;
  const offset = sectionText(entry.section).indexOf('There was a table set out under a tree');
  expect(offset).toBeGreaterThan(entry.offset);
  return { kind: 'epub', section: entry.section, offset } as const;
})();

/** The Alice PDF without its bookmarks: the catalog's outline entry blanked, every other byte as it was. */
function unbookmarkedAlice(): Uint8Array {
  const bytes = Buffer.from(readFileSync(ALICE_PDF));
  const entry = Buffer.from('/Outlines 4 0 R');
  const at = bytes.indexOf(entry);
  if (at < 0 || bytes.indexOf(entry, at + 1) >= 0) throw new Error('the Alice PDF has changed: find its outline entry again');
  bytes.fill(0x20, at, at + entry.length);
  return new Uint8Array(bytes);
}

/** A line of text on a page of textPdf: in Helvetica, at `size` points, its baseline `y` points up from the bottom. */
interface PdfLine {
  readonly text: string;
  readonly size: number;
  readonly y: number;
}

/**
 * A PDF of 300×450-point pages, each with these lines of text (or this content stream as it is),
 * compressed as PDF producers do.
 */
function textPdf(pages: readonly (readonly PdfLine[] | { readonly raw: string })[]): Uint8Array {
  // WinAnsi: the apostrophe of "The Queen’s Croquet-Ground" is byte 0x92.
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/’/g, '\x92');
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let size = chunks[0]!.length;
  const offsets: number[] = [];
  const object = (id: number, ...body: (string | Buffer)[]) => {
    offsets[id] = size;
    for (const part of [`${id} 0 obj\n`, ...body, '\nendobj\n']) {
      const b = typeof part === 'string' ? Buffer.from(part, 'latin1') : part;
      chunks.push(b);
      size += b.length;
    }
  };
  const pageIds = pages.map((_, i) => 4 + 2 * i);
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, i) => {
    const content = 'raw' in page ? page.raw : page.map((l) => `BT /F1 ${l.size} Tf 20 ${l.y} Td (${esc(l.text)}) Tj ET\n`).join('');
    const data = deflateSync(Buffer.from(content, 'latin1'));
    object(pageIds[i]!, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 450] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`);
    object(pageIds[i]! + 1, `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, data, '\nendstream');
  });
  const last = pageIds.length > 0 ? pageIds.at(-1)! + 1 : 3;
  let xref = `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= last; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}

/** The Alice chapter titles as the EPUB names them. */
const ALICE_TITLES = [
  'Down the Rabbit-Hole',
  'The Pool of Tears',
  'A Caucus-Race and a Long Tale',
  'The Rabbit Sends in a Little Bill',
  'Advice from a Caterpillar',
  'Pig and Pepper',
  'A Mad Tea-Party',
  'The Queen’s Croquet-Ground',
  'The Mock Turtle’s Story',
  'The Lobster Quadrille',
  'Who Stole the Tarts?',
  'Alice’s Evidence',
];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
/** The Gutenberg Alice's fifteen entries as a book's chapters, at their places in its story (characters 906 to 146,070). */
const ALICE_CHAPTERS = (
  [
    ['Alice’s Adventures in Wonderland', 910],
    ['THE MILLENNIUM FULCRUM EDITION 3.0', 960],
    ['Contents', 996],
    ...ALICE_TITLES.map((name, k): [string, number] => [`CHAPTER ${ROMAN[k]}. ${name}`, [1448, 12_997, 23_965, 33_562, 47_445, 59_470, 73_351, 86_116, 99_832, 112_520, 123_966, 134_398][k]!]),
  ] as const
).map(([title, m]) => ({ title, t: (m - 906) / (146_070 - 906) }));

describe('a plain numbered folder, added to the Alice EPUB (D74)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let people = 0;
  const member = async () => joinClub(t, club, `Reader ${++people}`);

  /** A new book of the Alice EPUB, with these files as its audiobook (and these names, as the upload form gives them). */
  const aliceWith = async (tracks: UploadFile[], trackTitles?: string[]) => {
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId, ...(trackTitles ? { trackTitles } : {}) });
    await t.settle();
    const book = await bookDetail(owner, bookId);
    return { book, epub: book.editions.find((e) => e.kind === 'epub')!, audio: book.editions.find((e) => e.kind === 'audio')! };
  };
  /** The tiny Alice's twelve MP3s without their tags, named and tagged anew. */
  const tinyTracks = (file: (k: number) => string, tag?: (k: number) => string) =>
    audioTracks(ALICE_TINY_AUDIO).map((f, i) =>
      fileOf(file(i + 1), tag ? mp3With([textFrame('TIT2', tag(i + 1))], `${ALICE_TINY_AUDIO}/${f.name}`) : new Uint8Array(mpegFramesOf(`${ALICE_TINY_AUDIO}/${f.name}`)), 'track', 'audio/mpeg'),
    );

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
  });

  afterAll(async () => {
    await closeApp(t);
  });

  describe('the LibriVox recording as 01 to 12, tags stripped', () => {
    let book: BookDetail;
    let epub: Edition;
    let audio: Edition;
    const report = async (c: Client, edition: Edition, from: Locator, to: Locator) =>
      ProgressUpdateResultSchema.parse(await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: edition.id, locator: to, readSpans: [{ from, to }], at: Date.now() }), 200));

    beforeAll(async () => {
      // Crafted files of the recording's own lengths: no title in them, only their names.
      const files = LIBRIVOX_MS.map((ms, i) => fileOf(`${pad(i + 1)}.m4b`, craftM4b({ chunks: Math.round(ms / 128), chapters: 1, chapterSeconds: Math.round(ms / 1000) }), 'track', 'audio/mp4'));
      ({ book, epub, audio } = await aliceWith(files));
    });

    it('calls them by their numbers and lines each up with its chapter', () => {
      expect(audio.status).toBe('ready');
      expect(audio.tracks.map((tr) => tr.title)).toEqual(LIBRIVOX_MS.map((_, i) => pad(i + 1)));
      expect(audio.alignment).toEqual({ method: 'number', unitToChapter: STORY_CHAPTERS });
      expect(audio.tracks.map((tr) => book.chapters[tr.chapter!]!.title)).toEqual(ALICE_TITLES.map((name, k) => `CHAPTER ${ROMAN[k]}. ${name}`));
      expect(audio.sync!.points.length).toBeGreaterThan(2);
    });

    it('a listener 20 s into the seventh is in CHAPTER VII, not in chapter 6 at 48 %', async () => {
      const ana = await member();
      const { mine } = await report(ana, audio, { kind: 'audio', track: 6, ms: 0 }, { kind: 'audio', track: 6, ms: 20_000 });
      // Half-way through the book: the chapter, then how far through the book.
      expect(mine.label).toBe('Chapter 7 · 50%');
      expect(mine.t).toBeGreaterThan(book.chapters[STORY_CHAPTERS[6]!]!.t);
    });

    it('Cole’s note on the first sentence of CHAPTER VII opens for a listener under two minutes into the chapter, not 21 minutes later', async () => {
      const writer = await member();
      const note = CommentViewSchema.parse(await writer.json(writer.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: teaParty, text: 'Why is a raven like a writing-desk?' }), 201));
      const chapter = (n: number) => book.chapters[STORY_CHAPTERS[n - 1]!]!.t;
      // Where the map puts it, and a tenth of its chapter on: more than a minute of listening here.
      const opensAt = tToM(audio.sync!, note.t + CHAPTER_SHARE * (chapter(8) - chapter(7)));
      expect(opensAt - tToM(audio.sync!, note.t)).toBeGreaterThan(AUDIO_MARGIN_MS);
      const seventh = LIBRIVOX_MS.slice(0, 6).reduce((a, b) => a + b, 0);
      expect(opensAt - seventh).toBeLessThan(120_000);
      const at = (ms: number): Locator => ({ kind: 'audio', track: 6, ms: ms - seventh });
      const fay = await member();
      expect((await report(fay, audio, { kind: 'audio', track: 0, ms: 0 }, at(opensAt - 1000))).revealed.map((r) => r.id)).toEqual([]);
      expect((await report(fay, audio, at(opensAt - 1000), at(opensAt + 1000))).revealed.map((r) => r.id)).toContain(note.id);
    });
  });

  it('lines up files named 01.mp3, as the upload form names them, and with their names read on the server', async () => {
    for (const trackTitles of [undefined, LIBRIVOX_MS.map((_, i) => prettifyTrackTitle(undefined, `${pad(i + 1)}.mp3`))]) {
      const { audio } = await aliceWith(tinyTracks((k) => `${pad(k)}.mp3`), trackTitles);
      expect(audio.tracks.map((tr) => tr.title)).toEqual(LIBRIVOX_MS.map((_, i) => pad(i + 1)));
      expect(audio.alignment).toEqual({ method: 'number', unitToChapter: STORY_CHAPTERS });
    }
  });

  it('lines up files tagged only "01", and files named "Track 01.mp3" in order after the front matter', async () => {
    const tagged = await aliceWith(tinyTracks((k) => `alice-${k}.mp3`, (k) => pad(k)));
    expect(tagged.audio.alignment).toEqual({ method: 'number', unitToChapter: STORY_CHAPTERS });
    const tracks = await aliceWith(tinyTracks((k) => `Track ${pad(k)}.mp3`));
    expect(tracks.audio.tracks.map((tr) => tr.title)).toEqual(LIBRIVOX_MS.map((_, i) => `Track ${pad(i + 1)}`));
    expect(tracks.audio.alignment).toEqual({ method: 'count', unitToChapter: STORY_CHAPTERS });
  });

  it('a numbered folder first: the text added later is matched to it by number, and names its chapters', async () => {
    const { bookId } = await uploadBook(owner, club.id, 'audio', tinyTracks((k) => `${pad(k)}.mp3`), { title: 'Numbers First', author: 'Lewis Carroll' });
    await t.settle();
    expect((await bookDetail(owner, bookId)).chapters.map((c) => c.title)).toEqual(LIBRIVOX_MS.map((_, i) => pad(i + 1)));
    await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Numbers First', author: 'Lewis Carroll', bookId });
    await t.settle();
    const book = await bookDetail(owner, bookId);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    // The licence after the story is no chapter's.
    expect(epub.alignment).toEqual({ method: 'number', unitToChapter: [null, null, null, ...Array.from({ length: 12 }, (_, i) => i), null] });
    expect(book.chapters.map((c) => c.title)).toEqual(ALICE_TITLES.map((name, k) => `CHAPTER ${ROMAN[k]}. ${name}`));
  });
});

describe('a PDF without bookmarks, added to the Alice EPUB (D74)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let people = 0;
  const member = async () => joinClub(t, club, `Reader ${++people}`);
  let book: BookDetail;
  let epub: Edition;
  let pdf: Edition;
  /** The PDF with its bookmarks, in a book of its own. */
  let bookmarked: Edition;

  const upload = async (bytes: Uint8Array, title: string) => {
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title, author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'pdf', [fileOf('alice.pdf', bytes, 'main', 'application/pdf')], { title, author: 'Lewis Carroll', bookId });
    await t.settle();
    return bookDetail(owner, bookId);
  };
  const report = async (c: Client, edition: Edition, from: Locator, to: Locator) =>
    ProgressUpdateResultSchema.parse(await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: edition.id, locator: to, readSpans: [{ from, to }], at: Date.now() }), 200)).revealed.map((r) => r.id);
  const pdfAt = (m: number): Locator => ({ kind: 'pdf', page: Math.floor(m), y: m - Math.floor(m) });
  const note = async (c: Client, edition: Edition, locator: Locator, text: string): Promise<CommentView> =>
    CommentViewSchema.parse(await c.json(c.post(`/api/books/${book.id}/comments`, { editionId: edition.id, locator, text }), 201));

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    bookmarked = (await upload(new Uint8Array(readFileSync(ALICE_PDF)), 'Alice, bookmarked')).editions.find((e) => e.kind === 'pdf')!;
    book = await upload(unbookmarkedAlice(), 'Alice');
    epub = book.editions.find((e) => e.kind === 'epub')!;
    pdf = book.editions.find((e) => e.kind === 'pdf')!;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('is lined up by the chapter headings at the top of its pages, as it is by its bookmarks', () => {
    expect(pdf).toMatchObject({ status: 'ready', pageCount: 91 });
    expect(pdf.units).toEqual(bookmarked.units);
    expect(pdf.units.map((u) => u.m)).toEqual([1, 7, 13, 19, 27, 35, 43, 52, 60, 69, 77, 84]);
    expect(pdf.units[6]!.title).toBe('CHAPTER VII. A Mad Tea-Party');
    // Matched to the book's chapters by those numbers, then lined up with its text line by line
    // (D75), as the bookmarked one is: the same map.
    expect(pdf.alignment).toEqual({ method: 'forced', unitToChapter: STORY_CHAPTERS });
    expect(editionAlignment(editionById(t.ctx.db, pdf.id)!).chapterMethod).toBe('number');
    expect(pdf.sync).toEqual(bookmarked.sync);
  });

  it('Cole’s note on the first sentence of CHAPTER VII opens for a PDF reader with its page, not after page 55', async () => {
    const written = await note(await member(), epub, teaParty, 'Why is a raven like a writing-desk?');
    const page = tToM(pdf.sync!, written.t);
    // CHAPTER VII starts at the top of page 43 (printed 44); its first sentence under its heading.
    expect(Math.floor(page)).toBe(43);
    const c = await member();
    expect(await report(c, pdf, pdfAt(0), pdfAt(43))).toEqual([]);
    expect(await report(c, pdf, pdfAt(43), pdfAt(44))).toContain(written.id);
  });

  it('a note at the top of CHAPTER VII’s page in the PDF opens for an EPUB reader as CHAPTER VII begins, never before', async () => {
    const printed = await note(await member(), pdf, pdfAt(43.05), 'The Hatter’s riddle, in print');
    const six = pub.toc.find((e) => e.title.startsWith('CHAPTER VI.'))!;
    const seven = pub.toc.find((e) => e.title.startsWith('CHAPTER VII.'))!;
    const from: Locator = { kind: 'epub', section: six.section, offset: six.offset };
    // Above the page's first line: the page's start, where CHAPTER VI's last words end.
    const endOfSix = sectionText(six.section).trimEnd().length;
    const heading: Locator = { kind: 'epub', section: seven.section, offset: sectionText(seven.section).indexOf('CHAPTER VII.') };
    // (Notes made in the EPUB open as it is read there: only this one is looked for.)
    const c = await member();
    expect(await report(c, epub, from, { kind: 'epub', section: six.section, offset: endOfSix - 20 })).not.toContain(printed.id);
    expect(await report(c, epub, { kind: 'epub', section: six.section, offset: endOfSix - 20 }, heading)).toContain(printed.id);
  });

  it('when its headings cannot be read in time, it is a straight line: the note opens six per cent of the book past where the line puts it, never before its chapter', async () => {
    await ingestEdition(t.ctx, pdf.id, { pdfHeadings: { ms: 1, heapMb: 64 } });
    const line = (await bookDetail(owner, book.id)).editions.find((e) => e.id === pdf.id)!;
    expect(line.units).toEqual([]);
    expect(line.alignment).toEqual({ method: 'none', unitToChapter: [] });
    expect(line.sync).toEqual(linearSyncMap(0, 91));
    const written = await note(await member(), epub, teaParty, 'Twinkle, twinkle, little bat');
    // Where the line puts it is two pages past where CHAPTER VII begins (page 43): it opens 5.5 pages on from there.
    const opensAt = tToM(line.sync!, written.t + LINE_SHARE);
    expect(opensAt).toBeCloseTo(50.9, 1);
    const c = await member();
    expect(await report(c, line, pdfAt(0), pdfAt(opensAt - 0.05))).not.toContain(written.id);
    expect(await report(c, line, pdfAt(opensAt - 0.05), pdfAt(opensAt + 0.05))).toContain(written.id);
    // Read again in time, it is lined up by its headings again, and then by its lines (D75).
    await ingestEdition(t.ctx, pdf.id);
    expect((await bookDetail(owner, book.id)).editions.find((e) => e.id === pdf.id)!.alignment.method).toBe('forced');
    expect(editionAlignment(editionById(t.ctx.db, pdf.id)!).chapterMethod).toBe('number');
  });

  it('a PDF that is the book’s first format is not searched for headings: it has no chapters to look for', async () => {
    const { bookId } = await uploadBook(owner, club.id, 'pdf', [fileOf('alice.pdf', unbookmarkedAlice(), 'main', 'application/pdf')], { title: 'Printed First', author: 'Lewis Carroll' });
    await t.settle();
    const first = await bookDetail(owner, bookId);
    expect(first.editions[0]).toMatchObject({ status: 'ready', units: [], alignment: { method: 'reference' } });
    expect(first.chapters).toEqual([]);
  });

  it('one page made to keep pdf.js busy for seconds is read in a worker, the server answering all along', async () => {
    // CHAPTER I to XII one a page, and in CHAPTER I a page of 60,000 runs of text (some 40 KB).
    const heading = (k: number): PdfLine[] => [
      { text: `CHAPTER ${ROMAN[k]}.`, size: 14, y: 410 },
      { text: ALICE_TITLES[k]!, size: 16, y: 390 },
      ...Array.from({ length: 8 }, (_, i) => ({ text: `The text of the chapter goes on, line ${i + 1} of its first page.`, size: 10, y: 360 - 14 * i })),
    ];
    const busy = { raw: 'BT /F1 10 Tf 20 400 Td (So she went on, and on, and on, talking to herself.) Tj ET\n'.repeat(60_000) };
    const bytes = textPdf([heading(0), busy, ...Array.from({ length: 11 }, (_, k) => heading(k + 1))]);
    expect(bytes.byteLength).toBeLessThan(100_000);
    // Read on this thread, as a PDF's pages would be without the worker: the time it holds it.
    const file = path.join(t.dir, 'busy.pdf');
    writeFileSync(file, bytes);
    const inline = performance.now();
    const heads = await readPageHeads(file);
    const held = performance.now() - inline;
    expect(heads).toHaveLength(13);
    expect(held).toBeGreaterThan(300);
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Busy', author: 'Lewis Carroll' });
    await t.settle();
    // The longest the server's thread is kept from anything else while the PDF is read.
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    await uploadBook(owner, club.id, 'pdf', [fileOf('busy.pdf', bytes, 'main', 'application/pdf')], { title: 'Busy', author: 'Lewis Carroll', bookId });
    const asked = performance.now();
    expect((await owner.get('/healthz')).statusCode).toBe(200);
    expect(performance.now() - asked).toBeLessThan(Math.min(500, held / 2));
    await t.settle();
    delay.disable();
    expect(delay.max / 1e6).toBeLessThan(Math.min(250, held / 2));
    const found = (await bookDetail(owner, bookId)).editions.find((e) => e.kind === 'pdf')!;
    expect(found.units.map((u) => [u.title, u.m])).toEqual(ALICE_TITLES.map((name, k) => [`CHAPTER ${ROMAN[k]}. ${name}`, k === 0 ? 0 : k + 1]));
    expect(found.alignment.method).toBe('number');
  });
});

describe('chapter headings at the top of a page (findChapterHeadings, D74)', () => {
  const body = (text = 'Alice was beginning to get very tired of sitting by her sister on the bank') => ({ text, size: 11 });
  /** A page whose top has these lines (the rest body text), set in 11-point type. */
  const page = (...lines: { text: string; size: number }[]): PageHead => ({ body: 11, lines: [...lines, body(), body(), body(), body()].slice(0, HEAD_LINES) });
  const opening = (k: number, size = 13) => page({ text: `CHAPTER ${ROMAN[k - 1]}.`, size }, { text: ALICE_TITLES[k - 1]!, size: 17 });
  const plain = () => page();
  const pagesOf = (found: ReturnType<typeof findChapterHeadings>) => found.map((f) => [f.page, f.title]);

  it('finds each chapter’s heading, its number and its name on the lines below, and leaves the front matter be', () => {
    const heads = [page({ text: 'Alice’s Adventures in Wonderland', size: 30 }), opening(1), plain(), opening(2), plain()];
    expect(pagesOf(findChapterHeadings(heads, ALICE_CHAPTERS))).toEqual([
      [1, 'CHAPTER I. Down the Rabbit-Hole'],
      [3, 'CHAPTER II. The Pool of Tears'],
    ]);
  });

  it('reads a chapter’s number in other numerals, its whole title on one line, and its name alone when set as a heading', () => {
    const heads = [
      page({ text: 'Chapter 1', size: 11 }),
      plain(),
      page({ text: 'CHAPTER II. THE POOL OF TEARS', size: 11 }),
      plain(),
      page({ text: 'A Caucus-Race and a Long Tale', size: 16 }),
      // The name alone in body type is the text, not a heading.
      page({ text: 'The Rabbit Sends in a Little Bill', size: 11 }),
      // A numeral alone, set large.
      page({ text: 'V', size: 24 }, { text: 'Advice from a Caterpillar', size: 11 }),
    ];
    expect(findChapterHeadings(heads, ALICE_CHAPTERS).map((f) => f.page)).toEqual([0, 2, 4, 6]);
  });

  it('takes a large letter lower down for a drop capital, not for a chapter’s number', () => {
    // CHAPTER V opens with a large I ("It was..."): still CHAPTER V's page, not a page naming two chapters.
    const dropped = page({ text: 'CHAPTER V.', size: 13 }, { text: 'Advice from a Caterpillar', size: 17 }, { text: 'I', size: 33 });
    expect(findChapterHeadings([opening(4), dropped], ALICE_CHAPTERS).map((f) => [f.page, f.title])).toEqual([
      [0, 'CHAPTER IV. The Rabbit Sends in a Little Bill'],
      [1, 'CHAPTER V. Advice from a Caterpillar'],
    ]);
  });

  it('looks past a page number or a running head above the heading, but not past a line of text', () => {
    const heads = [
      page({ text: '12', size: 9 }, { text: 'CHAPTER I.', size: 13 }),
      page({ text: 'ALICE’S ADVENTURES IN WONDERLAND', size: 9 }, { text: 'CHAPTER II.', size: 13 }),
      page(body('and the poor little thing sat down and cried, as the chapter before had said: and then'), { text: 'CHAPTER III.', size: 13 }),
      opening(4),
    ];
    expect(findChapterHeadings(heads, ALICE_CHAPTERS).map((f) => f.page)).toEqual([0, 1, 3]);
  });

  it('takes no contents page, nor a line of text that starts with a chapter’s number', () => {
    const contents = page({ text: 'Contents', size: 16 }, { text: 'CHAPTER I. Down the Rabbit-Hole 2', size: 11 }, { text: 'CHAPTER II. The Pool of Tears 8', size: 11 });
    const prose = page(body('Chapter 7 tells how the Hatter and the March Hare kept Alice at their table all afternoon'));
    expect(findChapterHeadings([contents, prose, opening(1), opening(2), opening(8)], ALICE_CHAPTERS).map((f) => f.page)).toEqual([2, 3, 4]);
  });

  it('keeps a chapter at its heading, not at the running heads repeating its name on the pages after', () => {
    const runningHead = (k: number) => page({ text: `CHAPTER ${ROMAN[k - 1]}. ${ALICE_TITLES[k - 1]!.toUpperCase()}`, size: 9 });
    const heads = [opening(1), runningHead(1), runningHead(1), opening(2), runningHead(2), opening(3)];
    expect(findChapterHeadings(heads, ALICE_CHAPTERS).map((f) => f.page)).toEqual([0, 3, 5]);
  });

  it('keeps the chapters in the book’s order, the most of them, and needs two', () => {
    // CHAPTER IX's heading strayed before CHAPTER II (a quotation set as a heading): left out.
    const heads = [opening(1), opening(9), opening(2), opening(3), opening(4)];
    expect(findChapterHeadings(heads, ALICE_CHAPTERS).map((f) => f.page)).toEqual([0, 2, 3, 4]);
    expect(findChapterHeadings([plain(), opening(5), plain()], ALICE_CHAPTERS)).toEqual([]);
    expect(findChapterHeadings([opening(1), opening(2)], [])).toEqual([]);
  });
});
