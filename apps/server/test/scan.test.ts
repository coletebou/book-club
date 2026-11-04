import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { looksBlank } from '@bookclub/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pictureLooksBlank } from '../src/ingest/blank';
import { type PageHead, findChapterHeadings, inspectPdf, pageHead, readPageHeads } from '../src/ingest/pdf';
import { ALICE_PDF, FIXTURES, type Client, type TestApp, bookDetail, closeApp, fileFrom, fileOf, makePdf, makeTestApp, setupOwner, uploadBook } from './helpers';

/*
 * Scanned books (fidelity review round 17, FR149): the Internet Archive's PDF of the 1886 Jekyll and
 * Hyde, each page a JPEG 2000 picture and a JBIG2 mask under the OCR's text. Its contents were the
 * OCR's running heads ("STORY OF THE DOOR. 7", chapter 1 placed six pages late), its misread
 * punctuation ("DR, JEKYLL WAS QUITE AT EASE,") and 6 of its 10 chapters; and a browser that could
 * not draw its pages gave it a white cover.
 */

/** The 1886 scan's pages 0, 7, 8, 14, 21, 60 and 111, as archive.org made them (scripts/fixtures/make-scan-sample.mjs). */
const SCAN_SAMPLE = path.join(FIXTURES, 'books/jekyll-1886-scan-sample.pdf');

/** The Gutenberg Jekyll and Hyde's (#43) contents as a book's chapters, at their places in its story. */
const JEKYLL_CHAPTERS = (
  [
    ['The Strange Case Of Dr. Jekyll And Mr. Hyde', 0.00006],
    ['Contents', 0.00062],
    ['STORY OF THE DOOR', 0.00272],
    ['SEARCH FOR MR. HYDE', 0.09451],
    ['DR. JEKYLL WAS QUITE AT EASE', 0.21011],
    ['THE CAREW MURDER CASE', 0.24092],
    ['INCIDENT OF THE LETTER', 0.30683],
    ['INCIDENT OF DR. LANYON', 0.3714],
    ['INCIDENT AT THE WINDOW', 0.42914],
    ['THE LAST NIGHT', 0.45066],
    ['DR. LANYON’S NARRATIVE', 0.62104],
    ['HENRY JEKYLL’S FULL STATEMENT OF THE CASE', 0.72919],
  ] as const
).map(([title, t]) => ({ title, t }));

/** The top of each of the scan's 153 pages as the server reads it (fixtures/make-jekyll-heads.ts). */
const JEKYLL_SCAN: PageHead[] = (JSON.parse(readFileSync(new URL('./fixtures/jekyll-1886-heads.json', import.meta.url), 'utf8')) as { pages: [number, [string, number][]][] }).pages.map(
  ([body, lines]) => ({ body, lines: lines.map(([text, size]) => ({ text, size })) }),
);

/** A page whose top has these lines, then the OCR's text in 5.5-point type. */
const page = (...lines: [string, number][]): PageHead => {
  const text: [string, number][] = [
    ['the theatre, had not crossed the doors of one', 5.5],
    ['for twenty years. But he had an approved', 5.5],
  ];
  return { body: 5.5, lines: [...lines, ...text].map(([t, size]) => ({ text: t, size })) };
};
const found = (heads: readonly PageHead[]) => findChapterHeadings(heads, JEKYLL_CHAPTERS).map((f) => [f.page, f.title]);

describe('the chapters of a scanned book, from its OCR (findChapterHeadings)', () => {
  it('finds all ten of the 1886 Jekyll and Hyde’s, each on its first page, called as the book calls them', () => {
    expect(JEKYLL_SCAN).toHaveLength(153);
    expect(found(JEKYLL_SCAN)).toEqual([
      [8, 'STORY OF THE DOOR'],
      [21, 'SEARCH FOR MR. HYDE'],
      [37, 'DR. JEKYLL WAS QUITE AT EASE'],
      [42, 'THE CAREW MURDER CASE'],
      [51, 'INCIDENT OF THE LETTER'],
      [60, 'INCIDENT OF DR. LANYON'],
      [68, 'INCIDENT AT THE WINDOW'],
      [72, 'THE LAST NIGHT'],
      [96, 'DR. LANYON’S NARRATIVE'],
      [111, 'HENRY JEKYLL’S FULL STATEMENT OF THE CASE'],
    ]);
  });

  it('takes no running head for a heading: a chapter’s title with the page’s number before or after it, as printed or misread', () => {
    // The pages of chapter 1 after its first: recto heads with their page numbers, verso heads with the book's title.
    expect(JEKYLL_SCAN[14]!.lines[0]).toEqual({ text: 'STORY OF THE DOOR. 7', size: 6 });
    const running = [8, 10, 12, 14, 16, 18, 20].map((k) => JEKYLL_SCAN[k]!);
    expect(findChapterHeadings([...running.slice(1), JEKYLL_SCAN[21]!], JEKYLL_CHAPTERS)).toEqual([]);
    // As the first line of a page, set larger than the text or not: a running head, never a heading.
    for (const head of ['STORY OF THE DOOR. 7', '9 STORY OF THE DOOR.', 'STOBY OF THE DOOR. 5', 'INCID1SNT AT THE WINDOW. 63', 'THE LAST NIGHT. 1l4']) {
      for (const size of [6.5, 9]) expect(found([page([head, size]), page(['SEARCH FOR MR. HYDE.', 9]), page(['THE LAST NIGHT.', 9])]).map(([p]) => p), `${head} at ${size}`).toEqual([1, 2]);
    }
    // A running head above the heading leaves the heading as it is.
    expect(found([page(['STORY OF THE DOOR. 1', 6.5], ['STORY OF THE DOOR.', 9]), page(['2 DR. JEKYLL AND MR. HYDE.', 7], ['SEARCH FOR MR. HYDE.', 9])])).toEqual([
      [0, 'STORY OF THE DOOR'],
      [1, 'SEARCH FOR MR. HYDE'],
    ]);
  });

  it('reads a heading the OCR misread, set apart from the text, alone or running on to the next line', () => {
    const heads = [
      page(['14 DB. JEKYLL Am) MB. HTDE.', 7], ['SEARCH FOB MR. HYDE,', 9]),
      page(['BBICAKKABLE INOIDSNT OF DB. LANTON. 68', 6.5], ['REMARKABLE INCIDENT OF DOCTOR', 9.5], ['LANYON,', 8.5]),
      page(['DR LANTON’S narrative. 89', 8], ['DOCTOR LANTON’8 NARRATIVE.', 9]),
      page(['104 DB. JBETLL AND MR HYDE.', 8], ['JIENRY JEKYLUS FULL STATEMENT', 9], ['OF TUE CASE,', 9]),
    ];
    expect(found(heads)).toEqual([
      [0, 'SEARCH FOR MR. HYDE'],
      [1, 'INCIDENT OF DR. LANYON'],
      [2, 'DR. LANYON’S NARRATIVE'],
      [3, 'HENRY JEKYLL’S FULL STATEMENT OF THE CASE'],
    ]);
    // Read exactly, its words are the book's, without the OCR's comma: "DR, JEKYLL WAS QUITE AT EASE,".
    expect(found([page(['80 DB. JBKTLL AND MR HYDB.', 8], ['DR, JEKYLL WAS QUITE AT EASE,', 9.5]), page(['THE CAREW MURDER CASE,', 9.5])])).toEqual([
      [0, 'DR. JEKYLL WAS QUITE AT EASE'],
      [1, 'THE CAREW MURDER CASE'],
    ]);
  });

  it('reads no misreading in the text’s own type, nor one too far from the title, nor a title of one word', () => {
    // In the text's size, a misread title is a line of text.
    expect(found([page(['SEARCH FOB MR. HYDE,', 5.5]), page(['DOCTOR LANTON’8 NARRATIVE.', 6])])).toEqual([]);
    // Two words in four wrong, no word of four letters read right, or another title: not the title.
    expect(found([page(['SEARCH FOB MB. HTDB,', 9]), page(['8T0BY OF THE DOOB', 9]), page(['THE CABMAN’S STORY', 9])])).toEqual([]);
    // Misread no further than that, they are ("HTDE" for "HYDE", "MUBDEB" for "MURDER").
    expect(found([page(['SEARCH FOB MB. HTDE,', 9]), page(['THE CABEW MUBDEB CASE', 9])])).toEqual([
      [0, 'SEARCH FOR MR. HYDE'],
      [1, 'THE CAREW MURDER CASE'],
    ]);
    const oneWord = [{ title: 'Prologue', t: 0.001 }, { title: 'Epilogue', t: 0.9 }];
    expect(findChapterHeadings([page(['PROLOGUB', 9]), page(['EPILOGUB', 9])], oneWord)).toEqual([]);
    expect(findChapterHeadings([page(['PROLOGUE', 9]), page(['EPILOGUE', 9])], oneWord).map((f) => f.page)).toEqual([0, 1]);
  });

  it('looks past a cutting pasted over the top of the page and a half-title, but not past the text', () => {
    // The story's first page: a newspaper's cutting about how to say "Jekyll" pasted over its top.
    expect(found([JEKYLL_SCAN[8]!, JEKYLL_SCAN[21]!])).toEqual([
      [0, 'STORY OF THE DOOR'],
      [1, 'SEARCH FOR MR. HYDE'],
    ]);
    // Under a line of the text, a title is not a heading; under a running head, short lines or lines set apart, it is.
    const under = (...above: [string, number][]) => page(...above, ['STORY OF THE DOOR.', 9]);
    const next = page(['SEARCH FOR MR. HYDE.', 9]);
    expect(found([under(['to say quaintly: I let my brother go to the devil in his own way', 5.5]), next])).toEqual([]);
    expect(found([under(['STRANGE CASE', 10], ['or', 5.5], ['DR. JEKYLL AND MR. HYDE.', 8]), next]).map(([p]) => p)).toEqual([0, 1]);
    expect(found([under(['The correct pronunciation is Jee-kill, not Jeck-ill, in Dr. Jekyll', 4]), next]).map(([p]) => p)).toEqual([0, 1]);
  });

  it('reads a line’s size as most of its words are set: an OCR’s word boxes, a drop capital', () => {
    const run = (str: string, size: number, x: number, y: number) => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size });
    const head = pageHead([
      // An OCR's running head: its words' boxes of 5.5 to 6.5 points.
      run('STORY', 6, 20, 331),
      run('OF', 6, 60, 331),
      run('THE', 6.5, 80, 331),
      run('DOOR.', 5.5, 110, 331),
      run('7', 5.5, 150, 331),
      // A line of its text with one tall word in it.
      run('the', 5.5, 20, 205),
      run('question,', 5.5, 40, 205),
      run('We', 9, 80, 205),
      run('did', 6, 100, 205),
      run('best.', 5, 120, 205),
      // A drop capital beside the first line of a chapter.
      run('I', 33, 20, 190),
      run('t was the best of times, it was the worst of times', 5.5, 40, 190),
    ]);
    expect(head.body).toBe(5.5);
    expect(head.lines.map((l) => [l.text, l.size])).toEqual([
      ['STORY OF THE DOOR. 7', 6],
      ['the question, We did best.', 5.5],
      ['It was the best of times, it was the worst of times', 5.5],
    ]);
  });

  it('reads the scan’s own pages so: the cutting, a running head, a heading misread over two lines', async () => {
    const heads = await readPageHeads(SCAN_SAMPLE);
    expect(heads).toHaveLength(7);
    // The story's first page (the third of the sample): its heading under the cutting and the half-title.
    expect(heads[2]!.lines.map((l) => l.text)).toContain('STORY OF THE DOOR,');
    expect(heads[3]!.lines[0]).toMatchObject({ text: 'STORY OF THE DOOR. 7' });
    expect(heads[6]!.lines.slice(0, 3).map((l) => l.text)).toEqual(['104 DB. JBETLL AND MR HYDE.', 'JIENRY JEKYLUS FULL STATEMENT', 'OF TUE CASE,']);
    // The contents (the second page) names none; the running head none; the three chapters' first pages theirs.
    expect(findChapterHeadings(heads, JEKYLL_CHAPTERS).map((f) => [f.page, f.title])).toEqual([
      [2, 'STORY OF THE DOOR'],
      [4, 'SEARCH FOR MR. HYDE'],
      [5, 'INCIDENT OF DR. LANYON'],
      [6, 'HENRY JEKYLL’S FULL STATEMENT OF THE CASE'],
    ]);
  });
});

describe('a scanned PDF’s cover', () => {
  let t: TestApp;
  let owner: Client;
  let clubId: string;
  beforeAll(async () => {
    t = await makeTestApp();
    const made = await setupOwner(t);
    owner = made.owner;
    clubId = made.club.id;
  });
  afterAll(async () => {
    await closeApp(t);
  });

  const drawn = async (jpeg: Uint8Array) => {
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    return looksBlank(data, info.channels);
  };

  it('is its first page, drawn with its JPEG 2000 and JBIG2 pictures', async () => {
    const info = await inspectPdf(SCAN_SAMPLE);
    expect(info).toMatchObject({ pageCount: 7, title: 'Strange case of Dr. Jekyll and Mr. Hyde', author: 'Stevenson, Robert Louis, 1850-1894', outline: [] });
    expect(info.coverJpeg).not.toBeNull();
    expect(await drawn(info.coverJpeg!)).toBe(false);
    // Blue, as the scan's cover is, not the white of a page whose pictures were left out.
    const { dominant } = await sharp(info.coverJpeg!).stats();
    expect(dominant.b).toBeGreaterThan(dominant.r + 60);
  });

  it('is none where the first page is blank: the book gets a made one', async () => {
    const blank = path.join(t.dir, 'blank.pdf');
    writeFileSync(blank, makePdf(2, { title: 'Blank' }));
    expect((await inspectPdf(blank)).coverJpeg).toBeNull();
    expect((await inspectPdf(ALICE_PDF)).coverJpeg).not.toBeNull();
  });

  /** A page of one shade, as a browser that could not decode a scan's pictures drew its first page. */
  const white = async (shade = '#ffffff') => new Uint8Array(await sharp({ create: { width: 640, height: 900, channels: 3, background: shade } }).jpeg({ quality: 85 }).toBuffer());
  const coverOf = (bookId: string) => t.ctx.db.get<{ cover_blob_id: string | null }>('SELECT cover_blob_id FROM books WHERE id = ?', [bookId])!.cover_blob_id;

  it('sent blank by the browser, it is left out: the server draws the page itself', async () => {
    const files = [fileFrom(SCAN_SAMPLE, 'main', 'application/pdf'), fileOf('cover.jpg', await white(), 'cover', 'image/jpeg')];
    const { bookId } = await uploadBook(owner, clubId, 'pdf', files, { title: 'Strange Case of Dr. Jekyll and Mr. Hyde', author: 'Robert Louis Stevenson' });
    await t.settle();
    expect((await bookDetail(owner, bookId)).hasCover).toBe(true);
    const cover = new Uint8Array(readFileSync(t.ctx.storage.blobPath(coverOf(bookId)!)));
    expect(await pictureLooksBlank(cover)).toBe(false);
    expect((await sharp(cover).stats()).dominant.b).toBeGreaterThan(150);
  });

  it('a flat colour sent with a blank PDF leaves the book a made cover; a real picture is taken', async () => {
    const blankPdf = fileOf('blank.pdf', makePdf(3, { title: 'Blank' }), 'main', 'application/pdf');
    const flat = await uploadBook(owner, clubId, 'pdf', [blankPdf, fileOf('cover.jpg', await white('#2b4c7e'), 'cover', 'image/jpeg')], { title: 'Flat', author: '' });
    await t.settle();
    expect((await bookDetail(owner, flat.bookId)).hasCover).toBe(false);
    expect((await owner.get(`/media/books/${flat.bookId}/cover`)).headers.etag).toMatch(/^"gen-/);
    // The scan's own first page, drawn: kept as it is sent.
    const page = (await inspectPdf(SCAN_SAMPLE)).coverJpeg!;
    const sent = await uploadBook(owner, clubId, 'pdf', [blankPdf, fileOf('cover.jpg', page, 'cover', 'image/jpeg')], { title: 'Sent', author: '' });
    await t.settle();
    expect((await bookDetail(owner, sent.bookId)).hasCover).toBe(true);
  });
});
