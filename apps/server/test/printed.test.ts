import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { bodyTextWithBreaks, buildPublication } from '@bookclub/epub';
import {
  type BookDetail,
  type ClubDetail,
  type CommentView,
  CommentViewSchema,
  type Edition,
  type EpubLocator,
  type Locator,
  type PdfLocator,
  type PrintedLine,
  ProgressUpdateResultSchema,
  type SyncMap,
  TranscriptSchema,
  mToT,
  syncMapFromAlignment,
  textWords,
  tToLocator,
  tToM,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRINTED_FILE, parsePrinted, printedLines } from '../src/ingest/pdf';
import { ingestEdition, resumeIngest } from '../src/ingest/pipeline';
import { type AlignmentRecord, editionAlignment, editionById } from '../src/repos/books';
import { alignPrintedText } from '../src/services/align-worker';
import { LINE_SHARE, PDF_MARGIN_PAGES } from '../src/services/gating';
import { READ_ALONG_LIMITS, alignBook, setReadAlongLimits } from '../src/services/readalong';
import { craftM4b } from './crafted-audio';
import { ALICE_EPUB, ALICE_PDF, type Client, FIXTURES, type TestApp, bookDetail, closeApp, fileFrom, fileOf, joinClub, makeTestApp, setupOwner, uploadBook, waitUntil } from './helpers';

/*
 * A PDF lined up with the EPUB word by word, line by line (D75). Fidelity review round 12's
 * must-fix: the Alice PDF's map had one point per chapter (14), so the gate held a note from the
 * other format a page or a tenth of its chapter past it (D63) and markers were placed by
 * interpolation inside a chapter. On page 3 Ana's EPUB note on "Down, down, down…" sat a paragraph
 * higher and opened only on page 4; Cleo's 🤯 on page 11 sat ten lines below its quote and opened on
 * page 12; Cole's PDF note on page 12 ("Perhaps it doesn't understand English") showed eleven lines
 * above its quote in the EPUB and opened two pages later; switching from the PDF to listening
 * started about 40 s early. Both files are the same Gutenberg text: the PDF is set from
 * fixtures/text/alice-gutenberg-11.txt by scripts/fixtures/make-alice-pdf.mjs.
 */

const pub = buildPublication(new Uint8Array(readFileSync(ALICE_EPUB)));
const sections = pub.sections.map((s) => bodyTextWithBreaks(new TextDecoder().decode(pub.files.get(s.path))).text);
const sectionStarts = sections.map((_, i) => sections.slice(0, i).reduce((n, text) => n + text.length, 0));
/** The EPUB's whole text measure. */
const wholeText = sections.join('');
const offsetOf = (at: EpubLocator) => sectionStarts[at.section]! + at.offset;

/** Where a passage of the EPUB is (whitespace in it standing for any), searched from `after` on in its measure. */
function passage(words: string, after = 0): { start: EpubLocator; end: EpubLocator; m: number } {
  const pattern = new RegExp(words.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  for (const [section, text] of sections.entries()) {
    pattern.lastIndex = Math.max(0, after - sectionStarts[section]!);
    const found = pattern.exec(text);
    if (!found) continue;
    const end = found.index + found[0].length;
    return { start: { kind: 'epub', section, offset: found.index }, end: { kind: 'epub', section, offset: end }, m: sectionStarts[section]! + found.index };
  }
  throw new Error(`not in the EPUB: ${words}`);
}

type Pages = readonly (readonly PrintedLine[])[];

/** The PDF's printed lines, as its ingest kept them. */
function printedOf(t: TestApp, pdf: Edition): PrintedLine[][] {
  const pages = parsePrinted(readFileSync(t.ctx.storage.pubFile(pdf.id, PRINTED_FILE)!, 'utf8'));
  if (!pages) throw new Error('no printed text kept');
  return pages;
}

/** The line of a page whose band (from its top to the next line's) holds height y, to a ten-thousandth of the page (0.06 pt). */
function lineAt(pages: Pages, page: number, y: number): number {
  let k = -1;
  pages[page]!.forEach((line, i) => {
    if (line.top <= y + 1e-4) k = i;
  });
  return k;
}

/** A line's number across the whole PDF. */
const lineNumber = (pages: Pages, page: number, line: number) => pages.slice(0, page).reduce((n, p) => n + p.length, 0) + line;

/** The page and line the printed text `words` is on. */
function printedLine(pages: Pages, words: string): { page: number; line: number; top: number } {
  for (const [page, lines] of pages.entries()) {
    const line = lines.findIndex((l) => l.text.includes(words));
    if (line >= 0) return { page, line, top: lines[line]!.top };
  }
  throw new Error(`not printed: ${words}`);
}

/**
 * Where printed lines are in the EPUB, found by their own words and not by the alignment: each line
 * whose first five words occur once in a row in the story, all its words following them there.
 */
function linesInText(pages: Pages): Map<string, { first: number; last: number }> {
  const words: { norm: string; start: number; end: number }[] = [];
  sections.forEach((text, i) => {
    for (const w of textWords(text, sectionStarts[i])) if (w.start >= pub.story.start && w.end <= pub.story.end) words.push(w);
  });
  const firstFive = new Map<string, number[]>();
  for (let i = 0; i + 5 <= words.length; i++) {
    const key = words.slice(i, i + 5).map((w) => w.norm).join(' ');
    firstFive.set(key, [...(firstFive.get(key) ?? []), i]);
  }
  const out = new Map<string, { first: number; last: number }>();
  pages.forEach((lines, page) =>
    lines.forEach((line, k) => {
      const own = textWords(line.text).map((w) => w.norm);
      const hits = own.length > 5 ? firstFive.get(own.slice(0, 5).join(' ')) : undefined;
      if (!hits || hits.length !== 1 || !own.every((w, q) => words[hits[0]! + q]?.norm === w)) return;
      out.set(`${page}:${k}`, { first: words[hits[0]!]!.start, last: words[hits[0]! + own.length - 1]!.end });
    }),
  );
  return out;
}

/** How far down its page a selection on a line starts: just under the top of its type, as the reader's text layer sets it. */
const SELECTION = (0.2 * 11) / 595.28;
const pdfAt = (page: number, y: number): PdfLocator => ({ kind: 'pdf', page, y });
const lineOf = (e: Edition) => ({ geometry: e.geometry!, sync: e.sync! });

/** An edition's chapter-level map, as it is before its text is lined up (readalong.ts chapterSync). */
function chapterMapOf(book: BookDetail, edition: Edition, story: { start: number; end: number }): SyncMap {
  const pairs = edition.units.flatMap((u, unit) => {
    const chapter = edition.alignment.unitToChapter[unit] ?? null;
    return chapter === null || u.m < story.start || u.m >= story.end ? [] : [{ unit, chapter }];
  });
  return syncMapFromAlignment(book.chapters, edition.units, { method: 'manual', pairs }, story);
}

/** What an edition keeps of how it was lined up. */
const recordOf = (t: TestApp, edition: Edition): AlignmentRecord => editionAlignment(editionById(t.ctx.db, edition.id)!);

interface Club {
  readonly t: TestApp;
  readonly owner: Client;
  readonly club: ClubDetail;
  member(): Promise<Client>;
}

async function newClub(): Promise<Club> {
  const t = await makeTestApp();
  const { owner, club } = await setupOwner(t);
  let people = 0;
  return { t, owner, club, member: () => joinClub(t, club, `Reader ${++people}`) };
}

interface Alice {
  readonly book: BookDetail;
  readonly epub: Edition;
  readonly pdf: Edition;
}

async function refreshed(c: Club, bookId: string): Promise<Alice> {
  const book = await bookDetail(c.owner, bookId);
  return { book, epub: book.editions.find((e) => e.kind === 'epub')!, pdf: book.editions.find((e) => e.kind === 'pdf')! };
}

/** A book of the Alice EPUB with this PDF added to it (or the PDF first, then the EPUB). */
async function aliceWith(c: Club, pdfBytes: Uint8Array, options: { title?: string; pdfFirst?: boolean } = {}): Promise<Alice> {
  const files = [
    { kind: 'epub' as const, file: fileFrom(ALICE_EPUB, 'main', 'application/epub+zip') },
    { kind: 'pdf' as const, file: fileOf('alice.pdf', pdfBytes, 'main', 'application/pdf') },
  ];
  if (options.pdfFirst) files.reverse();
  let bookId: string | undefined;
  for (const { kind, file } of files) {
    ({ bookId } = await uploadBook(c.owner, c.club.id, kind, [file], { title: options.title ?? 'Alice', author: 'Lewis Carroll', ...(bookId ? { bookId } : {}) }));
    await c.t.settle();
  }
  return refreshed(c, bookId!);
}

async function report(c: Client, bookId: string, edition: Edition, from: Locator, to: Locator): Promise<string[]> {
  const body = { editionId: edition.id, locator: to, readSpans: [{ from, to }], at: Date.now() };
  return ProgressUpdateResultSchema.parse(await c.json(c.put(`/api/books/${bookId}/progress`, body), 200)).revealed.map((r) => r.id);
}

async function note(c: Client, bookId: string, edition: Edition, body: { locator: Locator; endLocator?: Locator; quote?: string; text?: string; reaction?: string }): Promise<CommentView> {
  return CommentViewSchema.parse(await c.json(c.post(`/api/books/${bookId}/comments`, { editionId: edition.id, ...body }), 201));
}

/** The page of the PDF on which a note opens for someone reading it page by page from `from`. */
async function opensOnPdfPage(c: Club, { book, pdf }: Alice, id: string, from: number, to: number): Promise<number | null> {
  const reader = await c.member();
  for (let page = from; page <= to; page++) if ((await report(reader, book.id, pdf, pdfAt(page, 0), pdfAt(page, 1))).includes(id)) return page;
  return null;
}

/** The EPUB page (`size` characters of a section, from its start) on which a note opens for someone reading the section page by page. */
async function opensOnEpubPage(c: Club, { book, epub }: Alice, id: string, section: number, size: number): Promise<number | null> {
  const reader = await c.member();
  for (let page = 0; page * size < sections[section]!.length; page++) {
    const from: EpubLocator = { kind: 'epub', section, offset: page * size };
    const to: EpubLocator = { kind: 'epub', section, offset: Math.min(sections[section]!.length, (page + 1) * size) };
    if ((await report(reader, book.id, epub, from, to)).includes(id)) return page;
  }
  return null;
}

/** Characters an EPUB page holds (D69, measured on War and Peace at the default font): an iPhone's, a laptop's. */
const PAGE_SIZES = { phone: 858, laptop: 2132 } as const;

/** The passages of the reviewer's three notes: Ana's on page 3 and Cleo's on page 11 (the demo's), and Cole's on page 12. */
const ANA = 'Down, down, down. Would the fall never come to an end?';
const CLEO = 'I wish I hadn’t cried so much!';
const COLE = 'Perhaps it doesn’t understand English';

describe('the Alice PDF lined up with the Alice EPUB, line by line (D75)', () => {
  let c: Club;
  /** The book as it is now. */
  let now: Alice;
  /** The same book with its PDF on its chapter map, as before D75: its text not read (the reading ran out of time). */
  let before: Alice;
  let pages: PrintedLine[][];
  let truth: Map<string, { first: number; last: number }>;

  beforeAll(async () => {
    c = await newClub();
    now = await aliceWith(c, new Uint8Array(readFileSync(ALICE_PDF)));
    before = await aliceWith(c, new Uint8Array(readFileSync(ALICE_PDF)), { title: 'Alice, by chapters' });
    await ingestEdition(c.t.ctx, before.pdf.id, { pdfHeadings: { ms: 1, heapMb: 64 } });
    await c.t.settle();
    before = await refreshed(c, before.book.id);
    pages = printedOf(c.t, now.pdf);
    truth = linesInText(pages);
  });

  afterAll(async () => {
    await closeApp(c.t);
  });

  it('ties every printed line of its story to the text, and trusts every page of it', () => {
    expect(before.pdf.alignment.method).toBe('number');
    expect(before.pdf.sync!.points).toHaveLength(14);
    expect(now.pdf.alignment).toEqual({ method: 'forced', unitToChapter: before.pdf.alignment.unitToChapter });
    const record = recordOf(c.t, now.pdf);
    expect(record.chapterMethod).toBe('number');
    expect(record.printed!.editionId).toBe(now.epub.id);
    const { stats, exact } = record.printed!;
    // Every page but the title page; every line but the page numbers and the title page's.
    expect(stats).toMatchObject({ pages: 91, printedPages: 91, trustedPages: 90 });
    expect(stats.anchoredWords / stats.printedWords).toBeGreaterThan(0.99);
    expect(stats.tiedLines).toBeGreaterThanOrEqual(stats.lines - stats.pages - 4);
    expect(now.pdf.sync!.points.length).toBeGreaterThan(2400);
    // From the first line of CHAPTER I (page 2 as printed) to the end of THE END (page 91).
    expect(exact).toHaveLength(1);
    expect(exact[0]![0]).toBeCloseTo(1 + pages[1]![0]!.top, 5);
    expect(Math.floor(exact[0]![1])).toBe(90);
  });

  it('Ana’s note on “Down, down, down…” sits on its line on page 3 and opens as page 3 is read, not on page 4', async () => {
    const ana = await c.member();
    const quote = passage(ANA);
    const printed = printedLine(pages, 'Down, down, down. Would the fall');
    expect(printed).toMatchObject({ page: 2, line: 15 }); // page 3 as printed
    const placed = async (alice: Alice) => {
      const written = await note(ana, alice.book.id, alice.epub, { locator: quote.start, endLocator: quote.end, quote: ANA, text: 'Falling for so long she has time to wonder about latitude.', reaction: '😂' });
      const at = tToLocator(lineOf(alice.pdf), written.t) as PdfLocator;
      return { at, lines: lineNumber(pages, at.page, lineAt(pages, at.page, at.y)) - lineNumber(pages, printed.page, printed.line), opens: await opensOnPdfPage(c, alice, written.id, 1, 6) };
    };
    const was = await placed(before);
    const is = await placed(now);
    // Before: on page 3, three lines higher (in the paragraph before), and open only once page 4 was read.
    expect(was).toMatchObject({ at: { page: 2 }, lines: -3, opens: 3 });
    // Now: at the top of its line, and open with its page.
    expect(is).toMatchObject({ at: { page: 2 }, lines: 0, opens: 2 });
    expect(is.at.y).toBeCloseTo(printed.top, 5);
  });

  it('Cleo’s 🤯 on “I wish I hadn’t cried so much!” sits on its line on page 11 and opens on page 11, not page 12', async () => {
    const cleo = await c.member();
    const quote = passage(CLEO);
    const printed = printedLine(pages, CLEO);
    expect(printed).toMatchObject({ page: 10, line: 12 }); // page 11 as printed
    const placed = async (alice: Alice) => {
      const written = await note(cleo, alice.book.id, alice.epub, { locator: quote.start, endLocator: quote.end, quote: CLEO, text: 'The pool of tears is literally her own tears.', reaction: '🤯' });
      const at = tToLocator(lineOf(alice.pdf), written.t) as PdfLocator;
      return { at, lines: lineNumber(pages, at.page, lineAt(pages, at.page, at.y)) - lineNumber(pages, printed.page, printed.line), opens: await opensOnPdfPage(c, alice, written.id, 7, 14) };
    };
    const was = await placed(before);
    const is = await placed(now);
    // Before: eleven lines below its quote, and open only on page 12.
    expect(was).toMatchObject({ at: { page: 10 }, lines: 11, opens: 11 });
    expect(is).toMatchObject({ at: { page: 10 }, lines: 0, opens: 10 });
  });

  it('Cole’s note on page 12 sits on “Perhaps it doesn’t understand English” in the EPUB and opens on its own page there, not two pages later', async () => {
    const cole = await c.member();
    const quote = passage(COLE);
    const printed = printedLine(pages, COLE);
    expect(printed).toMatchObject({ page: 11, line: 0 }); // the top of page 12 as printed
    // A place on a printed line is all of that line: up to where the next one starts in the EPUB.
    const nextLine = truth.get(`${printed.page}:1`)!.first;
    const placed = async (alice: Alice) => {
      const written = await note(cole, alice.book.id, alice.pdf, { locator: pdfAt(printed.page, printed.top + SELECTION), quote: COLE, text: 'A French mouse, come over with William the Conqueror!' });
      const at = tToLocator(lineOf(alice.epub), written.t) as EpubLocator;
      const opens: Record<string, number | null> = {};
      for (const [device, size] of Object.entries(PAGE_SIZES)) opens[device] = await opensOnEpubPage(c, alice, written.id, quote.start.section, size);
      return { written, chars: offsetOf(at) - quote.m, opens };
    };
    const was = await placed(before);
    const is = await placed(now);
    const pageOf = (size: number) => Math.floor(quote.start.offset / size);
    console.log('case 3', { was: { chars: was.chars, opens: was.opens }, is: { chars: is.chars, opens: is.opens }, pages: { phone: pageOf(PAGE_SIZES.phone), laptop: pageOf(PAGE_SIZES.laptop) }, offset: quote.start.offset });
    // Before: some 480 characters above its quote (eleven lines on a phone), and open pages later.
    expect(was.chars).toBeLessThan(-400);
    expect(was.opens.phone).toBeGreaterThan(pageOf(PAGE_SIZES.phone));
    // Now: on its quote (which starts the printed line; the note's place just after its top), and open on the page that holds it.
    expect(is.chars).toBeGreaterThanOrEqual(0);
    expect(is.chars).toBeLessThan(20);
    expect(is.opens).toEqual({ phone: pageOf(PAGE_SIZES.phone), laptop: pageOf(PAGE_SIZES.laptop) });
    // All of its printed line, never past it: closed to a reader stopped short of the next one, open there.
    const reader = await c.member();
    const at = (m: number): EpubLocator => ({ kind: 'epub', section: quote.start.section, offset: m - sectionStarts[quote.start.section]! });
    expect(await report(reader, now.book.id, now.epub, at(quote.m - 500), at(nextLine - 2))).not.toContain(is.written.id);
    expect(await report(reader, now.book.id, now.epub, at(nextLine - 2), at(nextLine))).toContain(is.written.id);
  });

  it('switching formats lands on the line: a word of the EPUB on its line in the PDF, the top of a page of the PDF at its first word in the EPUB', () => {
    const tea = passage('There was a table set out under a tree in front of the house');
    const printed = printedLine(pages, 'There was a table set out under a tree');
    const inPdf = tToLocator(lineOf(now.pdf), mToT(now.epub.sync!, tea.m)) as PdfLocator;
    expect(inPdf.page).toBe(printed.page);
    expect(lineAt(pages, inPdf.page, inPdf.y)).toBe(printed.line);
    // The PDF reader's place is the top of its page: the EPUB opens there at the page's first word.
    const offsets: number[] = [];
    for (let page = 1; page < pages.length; page++) {
      const first = truth.get(`${page}:0`);
      if (first) offsets.push(offsetOf(tToLocator(lineOf(now.epub), mToT(now.pdf.sync!, page)) as EpubLocator) - first.first);
    }
    expect(offsets.length).toBeGreaterThan(60);
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(-3);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(0);
  });

  it('places every word of the book on its own printed line, and every printed line on its words (the line error across the book)', () => {
    const errors = lineErrors(pages, truth, now.pdf.sync!, now.epub.sync!);
    const chapterMap = lineErrors(pages, truth, before.pdf.sync!, now.epub.sync!);
    console.log('line error', { ...errors, wordsOff: [...errors.wordsOff] }, 'chapter map', { ...chapterMap, wordsOff: [...chapterMap.wordsOff].sort((a, b) => a[0] - b[0]) });
    // Checked against the lines found in the EPUB by their own words.
    expect(errors.lines).toBeGreaterThan(2000);
    expect(errors.words).toBeGreaterThan(24_000);
    expect([...errors.wordsOff]).toEqual([[0, errors.words]]);
    // A selection at the top of a printed line opens the EPUB inside that line's words.
    expect(errors.selection.min).toBeGreaterThanOrEqual(0);
    expect(errors.selection.pastLine).toBe(0);
    // The chapter map put a word on its own line one time in twenty, up to 31 lines away.
    expect(chapterMap.wordsOff.get(0)! / chapterMap.words).toBeLessThan(0.05);
    expect(Math.max(...[...chapterMap.wordsOff.keys()].map(Math.abs))).toBeGreaterThan(20);
  });
});

/**
 * The line error against lines found in the EPUB by their own words (linesInText): each of their
 * words, placed in the PDF through the maps, lands how many lines from its own (`wordsOff`, a
 * histogram); a selection at the top of each line (SELECTION) opens the EPUB how many characters
 * after the line's first word, and on how many lines past their last word (`selection`).
 */
function lineErrors(pages: Pages, truth: ReadonlyMap<string, { first: number; last: number }>, pdfSync: SyncMap, epubSync: SyncMap) {
  const wordsOff = new Map<number, number>();
  let words = 0;
  const selection = { min: Infinity, max: -Infinity, pastLine: 0 };
  for (const [key, { first, last }] of truth) {
    const [page, line] = key.split(':').map(Number) as [number, number];
    for (const w of textWords(wholeText.slice(first, last), first)) {
      const m = tToM(pdfSync, mToT(epubSync, w.start));
      const p = Math.min(Math.floor(m), pages.length - 1);
      const at = lineAt(pages, p, m - p);
      const off = (at < 0 ? lineNumber(pages, p, 0) - 1 : lineNumber(pages, p, at)) - lineNumber(pages, page, line);
      wordsOff.set(off, (wordsOff.get(off) ?? 0) + 1);
      words++;
    }
    const opened = tToM(epubSync, mToT(pdfSync, page + pages[page]![line]!.top + SELECTION)) - first;
    selection.min = Math.min(selection.min, opened);
    selection.max = Math.max(selection.max, opened);
    if (opened > last - first) selection.pastLine++;
  }
  return { lines: truth.size, words, wordsOff, selection };
}

/* ------------------------------------------------------------------------------------------ */
/* Switching to the audiobook                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * The LibriVox recording's twelve files, made to its lengths (01.m4b to 12.m4b), and what the
 * recogniser heard in it (the demo's transcript, matched to the files by their order and lengths).
 */
const LIBRIVOX = (() => {
  const heard = TranscriptSchema.parse(JSON.parse(readFileSync(path.join(FIXTURES, 'align/librivox-alice.transcript.json'), 'utf8')));
  const files = heard.tracks.map((track, i) =>
    fileOf(`${String(i + 1).padStart(2, '0')}.m4b`, craftM4b({ chunks: Math.round(track.durationMs / 128), chapters: 1, chapterSeconds: Math.round(track.durationMs / 1000) }), 'track', 'audio/mp4'),
  );
  return { files, transcript: { ...heard, tracks: heard.tracks.map(({ durationMs, words }) => ({ durationMs, words })) } };
})();

/** The book's audiobook given its transcript, and lined up with the text. */
async function transcribe(c: Club, bookId: string): Promise<void> {
  const audio = (await bookDetail(c.owner, bookId)).editions.find((e) => e.kind === 'audio')!;
  expect((await c.owner.put(`/api/editions/${audio.id}/transcript`, LIBRIVOX.transcript)).statusCode).toBe(202);
  await c.t.settle();
}

describe('a PDF and an audiobook both lined up with the EPUB: from the PDF, listening starts at the line', () => {
  let c: Club;
  let alice: Alice;
  let audio: Edition;
  let pages: PrintedLine[][];
  let truth: Map<string, { first: number; last: number }>;

  beforeAll(async () => {
    c = await newClub();
    alice = await aliceWith(c, new Uint8Array(readFileSync(ALICE_PDF)));
    await uploadBook(c.owner, c.club.id, 'audio', LIBRIVOX.files, { title: 'Alice', author: 'Lewis Carroll', bookId: alice.book.id });
    await c.t.settle();
    await transcribe(c, alice.book.id);
    alice = await refreshed(c, alice.book.id);
    audio = alice.book.editions.find((e) => e.kind === 'audio')!;
    pages = printedOf(c.t, alice.pdf);
    truth = linesInText(pages);
  });

  afterAll(async () => {
    await closeApp(c.t);
  });

  it('lines the audiobook up sentence by sentence and the PDF line by line, both with the EPUB', () => {
    expect(audio.alignment.method).toBe('forced');
    expect(audio.readAlong!.sentences).toBeGreaterThan(1500);
    expect(alice.pdf.alignment.method).toBe('forced');
  });

  it('from the top of any page the player starts where the narrator reads its first word: within a second, where the chapter map was up to a minute early', () => {
    const chapterMap = chapterMapOf(alice.book, alice.pdf, { start: 0, end: alice.pdf.pageCount! });
    const now: number[] = [];
    const was: number[] = [];
    for (let page = 1; page < pages.length; page++) {
      const first = truth.get(`${page}:0`);
      if (!first) continue;
      const narrated = tToM(audio.sync!, mToT(alice.epub.sync!, first.first));
      now.push(tToM(audio.sync!, mToT(alice.pdf.sync!, page)) - narrated);
      was.push(tToM(audio.sync!, mToT(chapterMap, page)) - narrated);
    }
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
    console.log('switching to listening (ms, started minus narrated)', { now: { min: Math.min(...now), max: Math.max(...now) }, was: { min: Math.min(...was), median: sorted(was)[Math.floor(was.length / 2)], max: Math.max(...was), early30: was.filter((x) => x < -30_000).length, pages: was.length } });
    expect(now.length).toBeGreaterThan(60);
    // In the pause before the sentence the page starts with, at most.
    expect(Math.max(...now.map(Math.abs))).toBeLessThan(1500);
    expect(Math.min(...was)).toBeLessThan(-30_000);
  });

  it('a note heard opens for a PDF reader with the page the narrator read it on, and a PDF note for a listener once the narrator has read its line', async () => {
    const ben = await c.member();
    // Ben's note a second into the narrator's reading of "Down, down, down…" (page 3 as printed).
    const quote = passage(ANA);
    const ms = tToM(audio.sync!, mToT(alice.epub.sync!, quote.m)) + 1000;
    const heard = await note(ben, alice.book.id, audio, { locator: tToLocator(lineOf(audio), mToT(audio.sync!, ms)), text: 'The narrator falls with her.' });
    expect(await opensOnPdfPage(c, alice, heard.id, 1, 5)).toBe(2);
    // A note on the line of page 12 that starts "Perhaps it doesn't…": open once the narrator has read the line.
    const printed = printedLine(pages, COLE);
    const written = await note(ben, alice.book.id, alice.pdf, { locator: pdfAt(printed.page, printed.top + SELECTION), quote: COLE, text: 'A French mouse.' });
    const nextLine = tToM(audio.sync!, mToT(alice.epub.sync!, truth.get(`${printed.page}:1`)!.first));
    const listener = await c.member();
    const at = (m: number) => tToLocator(lineOf(audio), mToT(audio.sync!, m));
    expect(await report(listener, alice.book.id, audio, at(nextLine - 60_000), at(nextLine - 300))).not.toContain(written.id);
    expect(await report(listener, alice.book.id, audio, at(nextLine - 300), at(nextLine + 300))).toContain(written.id);
  });
});

describe('an audiobook and a PDF lined up through the EPUB, whichever of them the timeline rests on', () => {
  let c: Club;

  beforeAll(async () => {
    c = await newClub();
  });

  afterAll(async () => {
    await closeApp(c.t);
  });

  /** A listener's note a second into the narration of Ana's passage opens for a PDF reader with its page; Ben's note on page 12's first line, for a listener once the narrator has read that line. */
  async function exactBothWays(bookId: string) {
    const { book, pdf, epub } = await refreshed(c, bookId);
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const pages = printedOf(c.t, pdf);
    const truth = linesInText(pages);
    const ben = await c.member();
    const narrated = (m: number) => tToM(audio.sync!, mToT(epub.sync!, m));
    const heard = await note(ben, book.id, audio, { locator: tToLocator(lineOf(audio), mToT(audio.sync!, narrated(passage(ANA).m) + 1000)), text: 'The narrator falls with her.' });
    // A minute of margin either side would hold it to the page after.
    expect(await opensOnPdfPage(c, { book, epub, pdf }, heard.id, 1, 5)).toBe(2);
    const printed = printedLine(pages, COLE);
    const written = await note(ben, book.id, pdf, { locator: pdfAt(printed.page, printed.top + SELECTION), quote: COLE, text: 'A French mouse.' });
    const nextLine = narrated(truth.get(`${printed.page}:1`)!.first);
    const listener = await c.member();
    const at = (ms: number) => tToLocator(lineOf(audio), mToT(audio.sync!, ms));
    expect(await report(listener, book.id, audio, at(nextLine - 60_000), at(nextLine - 300))).not.toContain(written.id);
    expect(await report(listener, book.id, audio, at(nextLine - 300), at(nextLine + 300))).toContain(written.id);
  }

  it('the PDF first: the EPUB lined up line by line with it, the audiobook sentence by sentence with the EPUB', async () => {
    const alice = await aliceWith(c, new Uint8Array(readFileSync(ALICE_PDF)), { pdfFirst: true, title: 'PDF first' });
    await uploadBook(c.owner, c.club.id, 'audio', LIBRIVOX.files, { title: 'PDF first', author: 'Lewis Carroll', bookId: alice.book.id });
    await c.t.settle();
    await transcribe(c, alice.book.id);
    const { book, epub, pdf } = await refreshed(c, alice.book.id);
    expect(book.referenceEditionId).toBe(pdf.id);
    expect(recordOf(c.t, epub)).toMatchObject({ method: 'forced', printed: { editionId: pdf.id } });
    expect(book.editions.find((e) => e.kind === 'audio')!.readAlong).toMatchObject({ textEditionId: epub.id });
    await exactBothWays(book.id);
  });

  it('the audiobook first: the EPUB lined up with what was heard, the PDF line by line with the EPUB', async () => {
    const { bookId } = await uploadBook(c.owner, c.club.id, 'audio', LIBRIVOX.files, { title: 'Heard first', author: 'Lewis Carroll' });
    await c.t.settle();
    for (const [kind, file] of [
      ['epub', fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')],
      ['pdf', fileFrom(ALICE_PDF, 'main', 'application/pdf')],
    ] as const) {
      await uploadBook(c.owner, c.club.id, kind, [file], { title: 'Heard first', author: 'Lewis Carroll', bookId });
      await c.t.settle();
    }
    await transcribe(c, bookId);
    const { book, epub, pdf } = await refreshed(c, bookId);
    expect(book.referenceEditionId).toBe(book.editions.find((e) => e.kind === 'audio')!.id);
    expect(epub.alignment.method).toBe('forced');
    expect(recordOf(c.t, pdf)).toMatchObject({ method: 'forced', printed: { editionId: epub.id } });
    await exactBothWays(bookId);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* PDFs set in the test                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** The Alice text as make-alice-pdf.mjs reads it: each chapter's heading, name and paragraphs (its italic marks gone). */
function aliceChapters(): { heading: string; title: string; paragraphs: string[] }[] {
  const lines = readFileSync(path.join(FIXTURES, 'text/alice-gutenberg-11.txt'), 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const end = lines.findIndex((l) => l.startsWith('*** END OF THE PROJECT GUTENBERG EBOOK'));
  const starts = lines.flatMap((l, i) => (/^CHAPTER [IVXLC]+\.$/.test(l) ? [i] : []));
  return starts.map((start, c) => ({
    heading: lines[start]!.trim(),
    title: lines[start + 1]!.trim(),
    paragraphs: lines
      .slice(start + 2, starts[c + 1] ?? end)
      .join('\n')
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').replace(/_/g, '').trim())
      .filter((p) => p.length > 0),
  }));
}

/** Project Gutenberg's licence, which follows the story in the plain text: another text altogether. */
function gutenbergLicence(): string[] {
  const text = readFileSync(path.join(FIXTURES, 'text/alice-gutenberg-11.txt'), 'utf8').replace(/\r\n?/g, '\n');
  return text
    .slice(text.indexOf('*** END OF THE PROJECT GUTENBERG EBOOK'))
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
}

interface SetChapter {
  readonly heading?: string;
  readonly title?: string;
  readonly paragraphs: readonly string[];
}

/**
 * A PDF set much as make-alice-pdf.mjs sets the Alice PDF (A5, Times, some seventy characters a
 * line, a page number at the foot of each page) from these chapters, each on a new page or run on,
 * with an outline entry for each heading when asked.
 */
function typesetPdf(chapters: readonly SetChapter[], options: { outline: boolean; newPage: boolean }): Uint8Array {
  const [width, height, top, bottom, left, lead] = [419.53, 595.28, 56, 64, 52, 14.28];
  const winAnsi: Record<string, string> = { '‘': '\x91', '’': '\x92', '“': '\x93', '”': '\x94', '–': '\x96', '—': '\x97', '…': '\x85' };
  const esc = (s: string) => [...s].map((ch) => winAnsi[ch] ?? (ch.charCodeAt(0) > 0xff ? '?' : ch)).join('').replace(/[\\()]/g, (ch) => `\\${ch}`);
  const pages: { text: string; size: number; baseline: number }[][] = [[]];
  const marks: { title: string; page: number; y: number }[] = [];
  let y = height - top;
  const newPage = () => {
    pages.push([]);
    y = height - top;
  };
  const put = (text: string, size: number, gap = 0) => {
    if (y - size < bottom) newPage();
    pages[pages.length - 1]!.push({ text, size, baseline: y - size });
    y -= Math.max(lead, size * 1.3) + gap;
  };
  const wrap = (paragraph: string) => {
    const out: string[] = [];
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && line.length + word.length + 1 > 72) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
    return out;
  };
  chapters.forEach((chapter, i) => {
    if (options.newPage && i > 0) newPage();
    if (chapter.heading) {
      if (y - 40 < bottom) newPage();
      marks.push({ title: `${chapter.heading} ${chapter.title ?? ''}`.trim(), page: pages.length - 1, y });
      put(chapter.heading, 13);
      if (chapter.title) put(chapter.title, 17, 8);
    }
    for (const p of chapter.paragraphs) wrap(p).forEach((line, k, all) => put(line, 11, k === all.length - 1 ? 5 : 0));
  });
  const pageIds = pages.map((_, i) => 4 + 2 * i);
  const outlineId = 4 + 2 * pages.length;
  const objects = new Map<number, (string | Buffer)[]>();
  const outlined = options.outline && marks.length > 0;
  objects.set(1, [`<< /Type /Catalog /Pages 2 0 R${outlined ? ` /Outlines ${outlineId} 0 R` : ''} >>`]);
  objects.set(2, [`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`]);
  objects.set(3, ['<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>']);
  pages.forEach((runs, i) => {
    const folio = `BT /F1 9 Tf ${(width / 2 - 5).toFixed(2)} 40 Td (${i + 1}) Tj ET\n`;
    const data = deflateSync(Buffer.from(runs.map((r) => `BT /F1 ${r.size} Tf ${left} ${r.baseline.toFixed(2)} Td (${esc(r.text)}) Tj ET\n`).join('') + folio, 'latin1'));
    objects.set(pageIds[i]!, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`]);
    objects.set(pageIds[i]! + 1, [`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, data, '\nendstream']);
  });
  if (outlined) {
    const ids = marks.map((_, i) => outlineId + 1 + i);
    objects.set(outlineId, [`<< /Type /Outlines /First ${ids[0]} 0 R /Last ${ids.at(-1)} 0 R /Count ${marks.length} >>`]);
    marks.forEach((mark, i) => {
      const links = `${i > 0 ? ` /Prev ${ids[i - 1]} 0 R` : ''}${i + 1 < ids.length ? ` /Next ${ids[i + 1]} 0 R` : ''}`;
      objects.set(ids[i]!, [`<< /Title (${esc(mark.title)}) /Parent ${outlineId} 0 R${links} /Dest [${pageIds[mark.page]} 0 R /XYZ 0 ${mark.y.toFixed(2)} 0] >>`]);
    });
  }
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let size = chunks[0]!.length;
  const offsets: number[] = [];
  const last = Math.max(...objects.keys());
  for (let id = 1; id <= last; id++) {
    offsets[id] = size;
    for (const part of [`${id} 0 obj\n`, ...(objects.get(id) ?? ['null']), '\nendobj\n']) {
      const b = typeof part === 'string' ? Buffer.from(part, 'latin1') : part;
      chunks.push(b);
      size += b.length;
    }
  }
  let xref = `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= last; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}

/** How a PDF's text lines up with its book's EPUB against the PDF's map as it is (a refused alignment is kept nowhere: worked out again here). */
async function statsOf(c: Club, { book, epub, pdf }: Alice) {
  const publication = JSON.parse(readFileSync(c.t.ctx.storage.pubFile(epub.id, '.publication.json')!, 'utf8')) as { sections: { index: number; href: string; textLength: number }[]; story: { start: number; end: number } };
  return alignPrintedText({
    kind: 'print-align',
    printed: c.t.ctx.storage.pubFile(pdf.id, PRINTED_FILE)!,
    textEditionId: epub.id,
    sections: publication.sections.map((s) => ({ index: s.index, file: c.t.ctx.storage.pubFile(epub.id, s.href), textLength: s.textLength })),
    story: publication.story,
    chapters: book.chapters,
    pdfIsReference: false,
    pdfSync: pdf.sync!,
    textSync: epub.sync!,
    fallback: pdf.sync!,
    straightReach: LINE_SHARE,
  });
}

describe('a PDF that is not the book’s text keeps its chapter map; one of only part of the book is lined up once its chapters are matched by hand', () => {
  let c: Club;

  beforeAll(async () => {
    c = await newClub();
  });

  afterAll(async () => {
    await closeApp(c.t);
  });

  it('Alice read backwards, with Alice’s bookmarks: the same words, another text', async () => {
    const backwards = aliceChapters().map((ch) => ({ ...ch, paragraphs: ch.paragraphs.map((p) => p.split(' ').reverse().join(' ')) }));
    const alice = await aliceWith(c, typesetPdf(backwards, { outline: true, newPage: true }), { title: 'Backwards' });
    expect(alice.pdf.alignment.method).toBe('number');
    expect(recordOf(c.t, alice.pdf).printed).toBeUndefined();
    expect(alice.pdf.sync).toEqual(chapterMapOf(alice.book, alice.pdf, { start: 0, end: alice.pdf.pageCount! }));
    const { sync, stats } = await statsOf(c, alice);
    expect(sync).toBeNull();
    expect(stats.trustedPages).toBe(0);
    // A note from the EPUB still waits the chapter map's margin: more than its page past where it puts it.
    const quote = passage(ANA);
    const written = await note(await c.member(), alice.book.id, alice.epub, { locator: quote.start, endLocator: quote.end, quote: ANA, text: 'Down she goes.' });
    const page = Math.floor(tToM(alice.pdf.sync!, written.t));
    const reader = await c.member();
    expect(await report(reader, alice.book.id, alice.pdf, pdfAt(1, 0), pdfAt(page + PDF_MARGIN_PAGES - 1, 1))).not.toContain(written.id);
  });

  it('Project Gutenberg’s licence: another text altogether, lined up from start to end as before', async () => {
    const licence = await aliceWith(c, typesetPdf([{ paragraphs: gutenbergLicence() }], { outline: false, newPage: false }), { title: 'Licence' });
    expect(licence.pdf.alignment.method).toBe('none');
    expect(licence.pdf.sync!.points).toHaveLength(2);
    expect(recordOf(c.t, licence.pdf).printed).toBeUndefined();
    const { sync, stats } = await statsOf(c, licence);
    expect(sync).toBeNull();
    expect(stats.trustedPages).toBe(0);
    expect(stats.anchoredWords / stats.printedWords).toBeLessThan(0.05);
  });

  it('Alice to the end of chapter VI: a straight line over the whole book, refused; matched to chapters I to VI by hand, lined up line by line', async () => {
    let half = await aliceWith(c, typesetPdf(aliceChapters().slice(0, 6), { outline: true, newPage: true }), { title: 'Half' });
    // Its six chapters do not reach the book's end (D73): a straight line, which its text is far from.
    expect(half.pdf.units).toHaveLength(6);
    expect(half.pdf.alignment.method).toBe('none');
    expect(recordOf(c.t, half.pdf).printed).toBeUndefined();
    const refused = await statsOf(c, half);
    expect(refused.sync).toBeNull();
    expect(refused.stats.anchoredWords / refused.stats.printedWords).toBeGreaterThan(0.99);
    expect(refused.stats.outOfPlace).toBeGreaterThan(refused.stats.tiedLines / 2);
    // The owner matches them to chapters I to VI.
    expect((await c.owner.put(`/api/editions/${half.pdf.id}/alignment`, { unitToChapter: [3, 4, 5, 6, 7, 8] })).statusCode).toBe(200);
    await c.t.settle();
    half = await refreshed(c, half.book.id);
    expect(half.pdf.alignment).toEqual({ method: 'forced', unitToChapter: [3, 4, 5, 6, 7, 8] });
    expect(recordOf(c.t, half.pdf)).toMatchObject({ chapterMethod: 'manual', printed: { editionId: half.epub.id } });
    // Ana's note now sits on its line, and opens with its page.
    const pages = printedOf(c.t, half.pdf);
    const printed = printedLine(pages, 'Down, down, down. Would the fall');
    const quote = passage(ANA);
    const written = await note(await c.member(), half.book.id, half.epub, { locator: quote.start, endLocator: quote.end, quote: ANA, text: 'Down she goes.' });
    const at = tToLocator(lineOf(half.pdf), written.t) as PdfLocator;
    expect(at.page).toBe(printed.page);
    expect(lineAt(pages, at.page, at.y)).toBe(printed.line);
    expect(await opensOnPdfPage(c, half, written.id, 1, printed.page + 2)).toBe(printed.page);
  });
});

describe('a PDF read before the EPUB: the EPUB is lined up with the PDF, line by line', () => {
  let c: Club;
  let alice: Alice;
  let pages: PrintedLine[][];

  beforeAll(async () => {
    c = await newClub();
    alice = await aliceWith(c, new Uint8Array(readFileSync(ALICE_PDF)), { pdfFirst: true });
    pages = printedOf(c.t, alice.pdf);
  });

  afterAll(async () => {
    await closeApp(c.t);
  });

  it('the timeline rests on the PDF, and the EPUB’s map is refined from it', () => {
    expect(alice.book.referenceEditionId).toBe(alice.pdf.id);
    expect(alice.pdf.alignment.method).toBe('reference');
    expect(alice.epub.alignment.method).toBe('forced');
    expect(recordOf(c.t, alice.epub)).toMatchObject({ chapterMethod: 'number', printed: { editionId: alice.pdf.id } });
    expect(alice.epub.sync!.points.length).toBeGreaterThan(2400);
  });

  it('an EPUB note sits on its line in the PDF and opens with its page', async () => {
    const quote = passage(CLEO);
    const printed = printedLine(pages, CLEO);
    const written = await note(await c.member(), alice.book.id, alice.epub, { locator: quote.start, endLocator: quote.end, quote: CLEO, text: 'Her own tears.', reaction: '🤯' });
    const at = tToLocator(lineOf(alice.pdf), written.t) as PdfLocator;
    expect(at.page).toBe(printed.page);
    expect(lineAt(pages, at.page, at.y)).toBe(printed.line);
    expect(await opensOnPdfPage(c, alice, written.id, 7, 14)).toBe(printed.page);
  });

  it('a PDF note sits on its quote in the EPUB and opens there once its printed line is read', async () => {
    const quote = passage(COLE);
    const printed = printedLine(pages, COLE);
    const written = await note(await c.member(), alice.book.id, alice.pdf, { locator: pdfAt(printed.page, printed.top + SELECTION), quote: COLE, text: 'A French mouse.' });
    const at = tToLocator(lineOf(alice.epub), written.t) as EpubLocator;
    expect(offsetOf(at) - quote.m).toBeGreaterThanOrEqual(0);
    expect(offsetOf(at) - quote.m).toBeLessThan(20);
    const nextLine = passage(pages[printed.page]![1]!.text.split(/\s+/).slice(0, 6).join(' '), quote.m).m;
    const reader = await c.member();
    const epubAt = (m: number): EpubLocator => ({ kind: 'epub', section: quote.start.section, offset: m - sectionStarts[quote.start.section]! });
    expect(await report(reader, alice.book.id, alice.epub, epubAt(quote.m - 500), epubAt(nextLine - 2))).not.toContain(written.id);
    expect(await report(reader, alice.book.id, alice.epub, epubAt(nextLine - 2), epubAt(nextLine))).toContain(written.id);
  });
});

describe('a PDF without bookmarks whose chapters start mid-page: a straight line no more', () => {
  let c: Club;
  let alice: Alice;

  beforeAll(async () => {
    c = await newClub();
    // Chapter after chapter on the same page, each heading run into its first paragraph: no bookmarks, and no heading at the top of a page.
    const runOn = aliceChapters().map((ch) => ({ paragraphs: [`${ch.heading} ${ch.title}`, ...ch.paragraphs] }));
    alice = await aliceWith(c, typesetPdf(runOn, { outline: false, newPage: false }), { title: 'Run on' });
  });

  afterAll(async () => {
    await closeApp(c.t);
  });

  it('its chapters are found nowhere, yet its lines are lined up with the text, within the straight line’s margin of it', () => {
    expect(alice.pdf.units).toEqual([]);
    expect(alice.pdf.alignment.method).toBe('forced');
    expect(recordOf(c.t, alice.pdf).chapterMethod).toBe('none');
  });

  it('Ana’s note sits on its line and opens with its page, where it opened six per cent of the book later', async () => {
    const pages = printedOf(c.t, alice.pdf);
    const printed = printedLine(pages, 'Down, down, down. Would the fall');
    const quote = passage(ANA);
    const written = await note(await c.member(), alice.book.id, alice.epub, { locator: quote.start, endLocator: quote.end, quote: ANA, text: 'Down she goes.' });
    const at = tToLocator(lineOf(alice.pdf), written.t) as PdfLocator;
    expect(at.page).toBe(printed.page);
    expect(lineAt(pages, at.page, at.y)).toBe(printed.line);
    expect(await opensOnPdfPage(c, alice, written.id, 0, printed.page + 2)).toBe(printed.page);
  });
});

describe('when the text a PDF was lined up with goes, the PDF gets its chapter map back; when it comes again, it is lined up again', () => {
  let c: Club;

  beforeAll(async () => {
    c = await newClub();
  });

  afterAll(async () => {
    await closeApp(c.t);
  });

  it('deleting the EPUB, then adding it again', async () => {
    let alice = await aliceWith(c, new Uint8Array(readFileSync(ALICE_PDF)));
    expect(alice.pdf.alignment.method).toBe('forced');
    const writer = await c.member();
    const written = await note(writer, alice.book.id, alice.pdf, { locator: pdfAt(11, 0.1), text: 'A French mouse.' });
    expect((await c.owner.delete(`/api/editions/${alice.epub.id}`)).statusCode).toBe(204);
    await c.t.settle();
    const book = await bookDetail(c.owner, alice.book.id);
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    expect(pdf.alignment.method).toBe('number');
    expect(recordOf(c.t, pdf).printed).toBeUndefined();
    expect(pdf.sync).toEqual(chapterMapOf(book, pdf, { start: 0, end: pdf.pageCount! }));
    // What was made in it moves with its map (D47).
    // As its writer sees it: exactly where it is (a friend who has not read there is told only roughly, D80).
    const moved = (await writer.json<CommentView[]>(writer.get(`/api/books/${book.id}/comments`), 200)).find((v) => v.id === written.id)!;
    expect(moved.t).toBeCloseTo(mToT(pdf.sync!, 11.1), 12);
    await uploadBook(c.owner, c.club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll', bookId: book.id });
    await c.t.settle();
    alice = await refreshed(c, book.id);
    expect(alice.pdf.alignment.method).toBe('forced');
    expect(recordOf(c.t, alice.pdf).printed!.editionId).toBe(alice.epub.id);
  });
});

describe('a PDF whose lining up runs out of its time', () => {
  let c: Club;

  beforeAll(async () => {
    c = await newClub();
  });

  afterAll(async () => {
    await closeApp(c.t);
  });

  it('keeps its chapter map, and is tried once more a while later', async () => {
    setReadAlongLimits(c.t.ctx, { align: { ms: 1, heapMb: 64 }, alignAgainMs: 300 });
    let alice = await aliceWith(c, new Uint8Array(readFileSync(ALICE_PDF)));
    expect(alice.pdf.alignment.method).toBe('number');
    // The box was only busy: the second try has the time.
    setReadAlongLimits(c.t.ctx, { align: READ_ALONG_LIMITS.align });
    await waitUntil(async () => (await refreshed(c, alice.book.id)).pdf.alignment.method === 'forced', 10_000, 'the second try');
    await c.t.settle();
    alice = await refreshed(c, alice.book.id);
    expect(recordOf(c.t, alice.pdf).printed!.editionId).toBe(alice.epub.id);
  });
});

describe('a PDF read before its text was kept (D75)', () => {
  let c: Club;

  beforeAll(async () => {
    c = await newClub();
  });

  afterAll(async () => {
    await closeApp(c.t);
  });

  it('has its text read once at the next start, and is lined up with the EPUB', async () => {
    let alice = await aliceWith(c, new Uint8Array(readFileSync(ALICE_PDF)));
    // As it was before: no text kept, its reading saying nothing of it, its chapter map.
    rmSync(c.t.ctx.storage.pubDir(alice.pdf.id), { recursive: true, force: true });
    const meta = JSON.parse(editionById(c.t.ctx.db, alice.pdf.id)!.meta_json) as Record<string, unknown>;
    expect(meta.printed).toBe(true);
    delete meta.printed;
    c.t.ctx.db.exec('UPDATE editions SET meta_json = ? WHERE id = ?', [JSON.stringify(meta), alice.pdf.id]);
    await alignBook(c.t.ctx, alice.book.id);
    expect((await refreshed(c, alice.book.id)).pdf.alignment.method).toBe('number');
    // The next start.
    expect(resumeIngest(c.t.ctx)).toBe(0);
    await c.t.settle();
    alice = await refreshed(c, alice.book.id);
    expect(alice.pdf.alignment.method).toBe('forced');
    expect(JSON.parse(editionById(c.t.ctx.db, alice.pdf.id)!.meta_json)).toMatchObject({ printed: true });
    // And not at the starts after it.
    resumeIngest(c.t.ctx);
    expect(c.t.ctx.jobs.pending).toBe(0);
  });
});

describe('a page’s printed lines, as the reader’s text layer places them (printedLines)', () => {
  /** A run of `size`-point text at (x, baseline) on a 400 × 600 page shown upright (pdf.js's viewport: y from the top). */
  const run = (str: string, x: number, baseline: number, size = 10, width = str.length * size * 0.5) => ({ str, transform: [size, 0, 0, size, x, baseline], width, height: size });
  const upright = { transform: [1, 0, 0, -1, 0, 600], height: 600 };

  it('makes lines of the runs on a baseline, top down, in the order they stand on it, a space between runs set apart', () => {
    const lines = printedLines([run('world', 80, 500), run('Hello', 20, 500), run('Second line', 20, 486), run('of it', 90.5, 486.5), run('   ', 300, 400)], upright);
    expect(lines).toEqual([
      { text: 'Hello world', top: (600 - 500 - 10) / 600, bottom: (600 - 500 + 2.5) / 600 },
      { text: 'Second line of it', top: (600 - 486.5 - 10) / 600, bottom: (600 - 486.5 + 2.5) / 600 },
    ]);
  });

  it('leaves out runs set at an angle, and reads a page turned in its frame as it is shown', () => {
    const sideways = { str: 'A note in the margin', transform: [0, 10, -10, 0, 380, 100], width: 100, height: 10 };
    expect(printedLines([run('The text', 20, 500), sideways], upright).map((l) => l.text)).toEqual(['The text']);
    // A page shown turned a quarter (its /Rotate): what is set across the file reads level on screen,
    // and what is level in the file is on its side.
    const turned = { transform: [0, 1, 1, 0, 0, 0], height: 400 };
    const across = { str: 'Level once turned', transform: [0, 10, -10, 0, 100, 50], width: 90, height: 10 };
    expect(printedLines([across, run('On its side once turned', 20, 300)], turned).map((l) => l.text)).toEqual(['Level once turned']);
  });

  it('reads no more of a line than a line can hold', () => {
    const many = Array.from({ length: 5000 }, (_, i) => run('word', 20 + i * 25, 500));
    expect(printedLines(many, upright)[0]!.text.length).toBeLessThanOrEqual(1000);
  });

  it('keeps what it read, and refuses a kept file that is not one', () => {
    const kept = { format: 'bookclub-printed/1', pages: [[['Alice was beginning', 0.1, 0.12]], []] };
    expect(parsePrinted(JSON.stringify(kept))).toEqual([[{ text: 'Alice was beginning', top: 0.1, bottom: 0.12 }], []]);
    for (const bad of ['not json', '{}', JSON.stringify({ ...kept, format: 'other' }), JSON.stringify({ ...kept, pages: [[['x', 0.5, 0.4]]] }), JSON.stringify({ ...kept, pages: [[['x', '0.1', 0.2]]] })]) {
      expect(parsePrinted(bad)).toBeNull();
    }
  });
});
