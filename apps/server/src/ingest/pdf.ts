import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type CanonicalChapter, PRINTED_LINE_CHARS, type PrintedLine, frontMatterCount, looksBlank, normalizeTitle, numberedAs, romanToInt, tidyLabel } from '@bookclub/shared';

/** An entry of a PDF's outline, or a chapter heading found in its text: its title and the page (and position) it starts. */
export interface PdfOutlineEntry {
  title: string;
  page: number;
  y: number;
  depth: number;
}

export interface PdfInfo {
  readonly pageCount: number;
  readonly title: string;
  readonly author: string;
  /** Outline entries flattened in reading order, with the page (and position) they point at. */
  readonly outline: PdfOutlineEntry[];
  /** JPEG of the first page, for a cover, when it could be rendered. */
  readonly coverJpeg: Uint8Array | null;
}

import type * as CanvasModule from '@napi-rs/canvas';
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfJs = typeof PdfJsModule;
let pdfjsPromise: Promise<PdfJs> | null = null;

async function pdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(import.meta.url);
    const worker = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href;
    return lib;
  })();
  return pdfjsPromise;
}

/** file:// URL of a resource folder shipped with pdfjs-dist (fonts, wasm decoders, ICC profiles). */
function pdfjsDir(name: string): string {
  const require = createRequire(import.meta.url);
  return pathToFileURL(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), name) + path.sep).href;
}

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

/**
 * Open a PDF with pdf.js, from its own resources only (no system fonts, no network): the standard
 * fonts, the CJK character maps, the decoders of scanned pages (JPEG 2000, JBIG2) and the colour
 * profiles. The browser's pdf.js is given the same (apps/web/src/lib/pdf.ts).
 */
/** Open a PDF file with pdf.js, from its own bundled resources (no system fonts, no network); used for club editions and for Cal's shelf (shelf-extract.ts) alike. */
export async function openPdf(file: string) {
  const lib = await pdfjs();
  const data = new Uint8Array(await readFile(file));
  return lib.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: pdfjsDir('standard_fonts'),
    cMapUrl: pdfjsDir('cmaps'),
    cMapPacked: true,
    wasmUrl: pdfjsDir('wasm'),
    iccUrl: pdfjsDir('iccs'),
    verbosity: 0,
  });
}

/** Read page count, document info and outline; render page one as a cover. */
export async function inspectPdf(file: string, options: { renderCover?: boolean } = {}): Promise<PdfInfo> {
  const task = await openPdf(file);
  const doc = await task.promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const xmpTitle: unknown = meta?.metadata?.get('dc:title');
    const xmpCreator: unknown = meta?.metadata?.get('dc:creator');
    const text = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');
    const title = tidyLabel(text(info.Title) || text(xmpTitle));
    const author = tidyLabel(text(info.Author) || text(xmpCreator));

    const outline: PdfInfo['outline'] = [];
    const nodes = ((await doc.getOutline().catch(() => null)) ?? []) as OutlineNode[];
    const visit = async (items: OutlineNode[], depth: number) => {
      for (const item of items) {
        try {
          const dest: unknown = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
          if (Array.isArray(dest) && dest[0]) {
            const ref = dest[0] as { num: number; gen: number } | number;
            const pageIndex = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
            let y = 0;
            const top: unknown = dest[3];
            if (dest[1] && (dest[1] as { name?: string }).name === 'XYZ' && typeof top === 'number') {
              const page = await doc.getPage(pageIndex + 1);
              const [, , , pageTop] = page.view;
              y = Math.min(1, Math.max(0, 1 - top / (pageTop ?? 1)));
            }
            outline.push({ title: tidyLabel(item.title), page: pageIndex, y, depth });
          }
        } catch {
          // An outline entry with a broken destination is skipped.
        }
        if (item.items?.length) await visit(item.items, depth + 1);
      }
    };
    await visit(nodes, 0);
    outline.sort((a, b) => a.page + a.y - (b.page + b.y));

    let coverJpeg: Uint8Array | null = null;
    if (options.renderCover !== false && doc.numPages > 0) coverJpeg = await renderFirstPage(doc).catch(() => null);
    return { pageCount: doc.numPages, title, author, outline, coverJpeg };
  } finally {
    await task.destroy();
  }
}

async function renderFirstPage(doc: Awaited<ReturnType<PdfJs['getDocument']>['promise']>): Promise<Uint8Array | null> {
  let canvasLib: typeof CanvasModule;
  try {
    // Named through a variable, so that the worker bundled from the sources (aligner.ts), which
    // reads PDFs' headings and never draws them, leaves the native canvas out.
    const name = '@napi-rs/canvas';
    canvasLib = (await import(name)) as typeof CanvasModule;
  } catch {
    return null;
  }
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = 900 / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = canvasLib.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  // @napi-rs/canvas implements the subset of the DOM canvas API pdf.js draws with.
  await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
  // A first page of one shade (a blank flyleaf, pictures that could not be decoded) is no cover:
  // the book gets a made one (D103).
  if (looksBlank(context.getImageData(0, 0, canvas.width, canvas.height).data)) return null;
  return new Uint8Array(await canvas.encode('jpeg', 85));
}

/* ------------------------------------------------------------------------------------------ */
/* Chapter headings of a PDF without bookmarks (D74)                                          */
/* ------------------------------------------------------------------------------------------ */

/** A line at the top of a page: what it says, and the size it is set in. */
export interface HeadLine {
  readonly text: string;
  readonly size: number;
}

/** The top of a page as a chapter's heading is read there: its first lines, top down, and the size of its body text. */
export interface PageHead {
  readonly lines: readonly HeadLine[];
  readonly body: number;
}

/**
 * Lines read at the top of each page: a running head, the page's number, a chapter's number and its
 * name, and what may stand above them set apart from the text (a half-title, a cutting pasted in).
 */
export const HEAD_LINES = 10;
/** Characters kept of each of them. */
const HEAD_LINE_CHARS = 200;
/** Pages read at most: the worker's time and memory are the real bound (pipeline.ts). */
export const MAX_HEADING_PAGES = 10_000;

/** A run of text on a page, as pdf.js reads it. */
interface TextRun {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

/** The size most of these runs' characters are set in (the middle one, by characters). */
function sizeOfMost(runs: readonly { readonly size: number; readonly chars: number }[]): number {
  const sorted = [...runs].sort((a, b) => a.size - b.size);
  const half = sorted.reduce((n, r) => n + r.chars, 0) / 2;
  let seen = 0;
  for (const r of sorted) {
    seen += r.chars;
    if (seen >= half) return r.size;
  }
  return sorted.at(-1)?.size ?? 0;
}

/**
 * The first lines of a page from its text runs, top down: runs sharing a baseline make a line, in
 * the order they stand on it, a space between runs set apart; with the size most of its text is
 * set in. A line's size is that of most of its characters, not its largest run's: an OCR's runs are
 * its words, each sized to its own box (a "We" of 9 points in a line of 5.5), and a drop capital
 * does not make a line of text a heading.
 */
export function pageHead(runs: readonly TextRun[]): PageHead {
  const sizeOf = (r: TextRun) => Math.round(Math.max(Math.abs(r.height), Math.hypot(r.transform[2] ?? 0, r.transform[3] ?? 0)) * 2) / 2;
  const chars = new Map<number, number>();
  const placed: { run: TextRun; y: number; size: number }[] = [];
  for (const run of runs) {
    if (run.str.trim().length === 0) continue;
    const size = sizeOf(run);
    chars.set(size, (chars.get(size) ?? 0) + run.str.length);
    placed.push({ run, y: run.transform[5] ?? 0, size });
  }
  let body = 0;
  let most = -1;
  for (const [size, n] of chars) {
    if (n > most) [body, most] = [size, n];
  }
  // Top down; a run within a few tenths of its size of the line above is on that line.
  placed.sort((a, b) => b.y - a.y);
  const lines: { y: number; tallest: number; runs: { run: TextRun; size: number; chars: number }[] }[] = [];
  for (const { run, y, size } of placed) {
    const line = lines[lines.length - 1];
    const sized = { run, size, chars: run.str.trim().length };
    if (line && line.y - y <= 0.4 * Math.max(size, line.tallest, 1)) {
      line.runs.push(sized);
      line.tallest = Math.max(line.tallest, size);
    } else if (lines.length < HEAD_LINES) lines.push({ y, tallest: size, runs: [sized] });
    else break;
  }
  return {
    body,
    lines: lines.map((line) => {
      const ordered = line.runs.map((r) => r.run).sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0));
      let text = '';
      let end = -Infinity;
      // Only the start of a line is kept: a line of a hundred thousand runs is not joined whole.
      for (const run of ordered) {
        if (text.length > HEAD_LINE_CHARS) break;
        const x = run.transform[4] ?? 0;
        if (text && !/\s/.test(text.at(-1)!) && !/^\s/.test(run.str) && x - end > 0.15 * line.tallest) text += ' ';
        text += run.str;
        end = x + run.width;
      }
      return { text: tidyLabel(text).slice(0, HEAD_LINE_CHARS), size: sizeOfMost(line.runs) };
    }),
  };
}

/** How a page is shown: pdf.js's viewport at scale 1, its rotation applied (its transform, and its height). */
export interface PageFrame {
  readonly transform: readonly number[];
  readonly height: number;
}

/**
 * Hand each page's text runs (at most `maxPages` pages) and the frame it is shown in to `use`, one
 * page at a time. A page that cannot be read is handed over with no runs. Run in a worker: a page's
 * text may be made to take seconds.
 */
async function eachPage(file: string, maxPages: number, use: (runs: TextRun[], frame: PageFrame | null) => void): Promise<void> {
  const task = await openPdf(file);
  try {
    const doc = await task.promise;
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      let runs: TextRun[] = [];
      let frame: PageFrame | null = null;
      try {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        runs = content.items.flatMap((item) => ('str' in item ? [item] : []));
        frame = { transform: viewport.transform, height: viewport.height };
        page.cleanup();
      } catch {
        // A page that cannot be read says nothing; the pages after it still may.
      }
      use(runs, frame);
    }
  } finally {
    await task.destroy();
  }
}

/** Read the top of each page of a PDF (at most `maxPages` of them). Run in a worker: a page's text may be made to take seconds. */
export async function readPageHeads(file: string, maxPages = MAX_HEADING_PAGES): Promise<PageHead[]> {
  const heads: PageHead[] = [];
  await eachPage(file, maxPages, (runs) => heads.push(runs.length > 0 ? pageHead(runs) : { lines: [], body: 0 }));
  return heads;
}

/* ------------------------------------------------------------------------------------------ */
/* The printed text of a PDF, line by line (D75)                                              */
/* ------------------------------------------------------------------------------------------ */

/** Two transforms applied one after the other: `b`, then `a` (pdf.js Util.transform). */
function compose(a: readonly number[], b: readonly number[]): number[] {
  const [a0 = 1, a1 = 0, a2 = 0, a3 = 1, a4 = 0, a5 = 0] = a;
  const [b0 = 1, b1 = 0, b2 = 0, b3 = 1, b4 = 0, b5 = 0] = b;
  return [a0 * b0 + a2 * b1, a1 * b0 + a3 * b1, a0 * b2 + a2 * b3, a1 * b2 + a3 * b3, a0 * b4 + a2 * b5 + a4, a1 * b4 + a3 * b5 + a5];
}

/** Where a line's type ends below its baseline, in ems: below the descenders of a book face (Times: 0.217). */
const DESCENT = 0.25;

/**
 * The lines printed on a page, top down, measured as the reader's text layer places them (pdf.js
 * TextLayer): runs set level on the page as it is shown that share a baseline (within a few tenths
 * of their size) make a line, in the order they stand on it, a space between runs set apart. Its
 * top is an em above its baseline, above where a selection on it starts; its bottom is below its
 * descenders; both in fractions of the page's height from its top. Runs set at an angle (a margin
 * note turned on its side) are left out.
 */
export function printedLines(runs: readonly TextRun[], frame: PageFrame): PrintedLine[] {
  const placed: { str: string; x: number; y: number; size: number; width: number }[] = [];
  for (const run of runs) {
    if (run.str.trim().length === 0) continue;
    const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = compose(frame.transform, run.transform);
    const size = Math.hypot(c, d);
    if (!(a > 0) || Math.abs(b) > 0.01 * a || !(size > 0) || !Number.isFinite(x + y)) continue;
    placed.push({ str: run.str, x, y, size, width: run.width });
  }
  placed.sort((p, q) => p.y - q.y || p.x - q.x);
  const lines: { y: number; size: number; runs: typeof placed }[] = [];
  for (const run of placed) {
    const line = lines[lines.length - 1];
    if (line && run.y - line.y <= 0.4 * Math.max(run.size, line.size)) {
      line.runs.push(run);
      line.size = Math.max(line.size, run.size);
    } else lines.push({ y: run.y, size: run.size, runs: [run] });
  }
  const height = frame.height > 0 ? frame.height : 1;
  let above = 0;
  return lines.map((line) => {
    const ordered = [...line.runs].sort((p, q) => p.x - q.x);
    let text = '';
    let end = -Infinity;
    // A line of a hundred thousand runs is not joined whole.
    for (const run of ordered) {
      if (text.length >= PRINTED_LINE_CHARS) break;
      if (text && !/\s$/.test(text) && !/^\s/.test(run.str) && run.x - end > 0.15 * line.size) text += ' ';
      text += run.str;
      end = run.x + run.width;
    }
    const top = Math.min(1, Math.max(above, (line.y - line.size) / height));
    above = top;
    return { text: text.slice(0, PRINTED_LINE_CHARS), top, bottom: Math.min(1, Math.max(top, (line.y + DESCENT * line.size) / height)) };
  });
}

/** What a PDF's pages say, as the server keeps it beside the edition (PRINTED_FILE): each page's lines as [text, top, bottom]. */
export interface PrintedText {
  readonly format: 'bookclub-printed/1';
  readonly pages: readonly (readonly (readonly [string, number, number])[])[];
}

/** The file beside a PDF edition (in its folder of the publications) that keeps its printed text. */
export const PRINTED_FILE = '.printed.json';

/** Characters of printed text kept at most: ten War and Peaces. A PDF that prints more is not lined up with its text. */
export const MAX_PRINTED_CHARS = 32 * 1024 * 1024;

/** A PDF's text as it was read once: the top of each page (for chapter headings) and its printed lines (null when there are too many). */
export interface PdfText {
  readonly heads: PageHead[];
  readonly printed: PrintedText | null;
  readonly lines: number;
}

/** Read every page of a PDF once (at most `maxPages` of them): its top, and its lines. Run in a worker. */
export async function readPdfText(file: string, maxPages = MAX_HEADING_PAGES): Promise<PdfText> {
  const heads: PageHead[] = [];
  const pages: (readonly [string, number, number])[][] = [];
  let chars = 0;
  let lines = 0;
  await eachPage(file, maxPages, (runs, frame) => {
    heads.push(runs.length > 0 ? pageHead(runs) : { lines: [], body: 0 });
    const printed = frame && chars <= MAX_PRINTED_CHARS ? printedLines(runs, frame) : [];
    for (const line of printed) chars += line.text.length;
    lines += printed.length;
    // To a millionth of the page: a hundredth of a point.
    pages.push(printed.map((line) => [line.text, Math.round(line.top * 1e6) / 1e6, Math.round(line.bottom * 1e6) / 1e6] as const));
  });
  return { heads, printed: chars <= MAX_PRINTED_CHARS ? { format: 'bookclub-printed/1', pages } : null, lines };
}

/** A PDF's printed text as it was kept, checked: its pages' lines, or null when the file is not one. */
export function parsePrinted(json: string): PrintedLine[][] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  const pages = (doc as Partial<PrintedText> | null)?.pages;
  if ((doc as Partial<PrintedText> | null)?.format !== 'bookclub-printed/1' || !Array.isArray(pages)) return null;
  const out: PrintedLine[][] = [];
  for (const page of pages as unknown[]) {
    if (!Array.isArray(page)) return null;
    const lines: PrintedLine[] = [];
    for (const line of page as unknown[]) {
      if (!Array.isArray(line)) return null;
      const [text, top, bottom] = line as unknown[];
      if (typeof text !== 'string' || typeof top !== 'number' || typeof bottom !== 'number' || !(top >= 0 && top <= bottom && bottom <= 1)) return null;
      lines.push({ text: text.slice(0, PRINTED_LINE_CHARS), top, bottom });
    }
    out.push(lines);
  }
  return out;
}

/** Words that say a chapter's number follows ("CHAPTER VII.", "Chap. 7", "Kapitel 7"), as normalizeTitle writes them. */
const CHAPTER_WORDS = new Set(['chapter', 'chapters', 'chapt', 'chap', 'ch', 'kapitel', 'chapitre', 'capitulo']);
/** Lines before a heading may be no longer than this (a running head, the page's number): words. */
const SHORT_LINE = 8;
/** Words a heading's line, set larger than the text, may hold besides what it is matched by ("continued"). */
const SPARE_WORDS = 3;
/** A heading set this much larger than the page's body text is surely one. */
const HEADING_SIZE = 1.1;
/** A numeral alone set this much larger is a chapter's number, not the page's. */
const NUMERAL_SIZE = 1.3;
/**
 * A line set this much larger or smaller than the body text stands apart from it (a half-title, a
 * cutting pasted in): a heading may stand under it, and one an OCR misread is looked for in it. It
 * is wider than HEADING_SIZE: an OCR's sizes are its words' boxes, and a line of its text may
 * measure a fifth over the page's body.
 */
const SET_APART = { larger: 1.25, smaller: 0.85 } as const;
/** Words a heading prints in full or shortened, read as one ("DOCTOR LANYON'S NARRATIVE", "Dr. Lanyon's Narrative"). */
const SAME_WORDS: Readonly<Record<string, string>> = { doctor: 'dr', mister: 'mr', mistress: 'mrs', saint: 'st' };
/**
 * A page's number as a running head prints it before or after its title, as an OCR reads it: up
 * to four digits, some perhaps read as letters ("1l4", "8O").
 */
const FOLIO = /^(?=.*\d)[\dlio]{1,4}$/;

const wordsOf = (text: string) =>
  normalizeTitle(text)
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => SAME_WORDS[w] ?? w);
const startsWith = (words: readonly string[], prefix: readonly string[]) => prefix.length > 0 && prefix.every((w, i) => words[i] === w);
const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && startsWith(a, b);

/** Letters an OCR may misread in a word this long, and the word still be read as it ("FOB" for "FOR", "LANTON'8" for "LANYON'S"). */
const slipsIn = (length: number) => (length >= 8 ? 3 : length >= 5 ? 2 : length >= 3 ? 1 : 0);

/** The letters to change, add or drop to make one word the other, or `max + 1` once it is surely more than `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const d = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      row.push(d);
      least = Math.min(least, d);
    }
    if (least > max) return max + 1;
    previous = row;
  }
  return previous[b.length]!;
}

/** Words already compared (alike): a book's running heads and titles bring the same pairs again and again. */
const compared = new Map<string, boolean>();
/** Pairs remembered at most: a book's worth (a crafted PDF cannot make it grow without end). */
const MAX_COMPARED = 200_000;

/** Whether an OCR's word may be this word, misread. */
function alike(read: string, word: string): boolean {
  if (read === word) return true;
  const slips = slipsIn(Math.min(read.length, word.length));
  if (slips === 0 || Math.abs(read.length - word.length) > slips) return false;
  const key = `${read}\u0000${word}`;
  let same = compared.get(key);
  if (same === undefined) {
    same = editDistance(read, word, slips) <= slips;
    if (compared.size >= MAX_COMPARED) compared.clear();
    compared.set(key, same);
  }
  return same;
}

/**
 * Whether an OCR's words are a title's, misread: each word alike (alike), at most one in four of
 * the title's words missing, added or unlike, and one word of four letters or more read exactly
 * ("SEARCH FOB MR. HYDE," is "SEARCH FOR MR. HYDE"; "REMARKABLE INCIDENT OF DOCTOR LANYON" is
 * "INCIDENT OF DR. LANYON"). A title of one word, or of fewer than eight letters, is only ever read
 * as it is spelled.
 */
function misreadAs(read: readonly string[], title: readonly string[]): boolean {
  const letters = (words: readonly string[]) => words.reduce((n, w) => n + w.length, 0);
  const own = letters(title);
  // (A line of twice the title's letters, or half, is surely not it: most lines are let go here.)
  if (title.length < 2 || own < 8 || Math.abs(letters(read) - own) > own) return false;
  if (!read.some((w) => w.length >= 4 && title.includes(w))) return false;
  // Words apart: a word of the title missing or unlike, or one added to it.
  let previous = Array.from({ length: title.length + 1 }, (_, j) => j);
  for (let i = 1; i <= read.length; i++) {
    const row = [i];
    for (let j = 1; j <= title.length; j++) row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (alike(read[i - 1]!, title[j - 1]!) ? 0 : 1)));
    previous = row;
  }
  return previous[title.length]! <= Math.floor(title.length / 4);
}

/** What a chapter's heading may say: all its title, its number, and its name without the number; and its title as the book has it. */
interface Sought {
  readonly index: number;
  readonly title: string;
  readonly words: readonly string[];
  readonly n: number | null;
  readonly name: readonly string[];
}

function sought(chapter: CanonicalChapter, index: number): Sought {
  const words = wordsOf(chapter.title);
  const numbering = numberedAs(chapter.title);
  // "VII. A Mad Tea-Party": a Roman numeral and its full stop number the chapter too.
  const roman = /^\s*([ivxlcdm]+)\.\s/i.exec(chapter.title);
  const n = numbering?.counts === 'chapter' ? numbering.n : roman ? romanToInt(roman[1]!) : null;
  // Its name is what follows its number: "CHAPTER VII. A Mad Tea-Party", "Chapter Seven: …", "07 - The Tea Party".
  const first = words[0] ?? '';
  const name = n === null ? [] : CHAPTER_WORDS.has(first) ? words.slice(2) : Number.parseInt(first, 10) === n || romanToInt(first) === n ? words.slice(1) : [];
  return { index, title: tidyLabel(chapter.title), words, n, name };
}

/** The book's story chapters as their headings are looked for: in order, by number and by their first words. */
interface Wanted {
  readonly story: readonly Sought[];
  readonly byNumber: ReadonlyMap<number, readonly Sought[]>;
  readonly byStart: ReadonlyMap<string, readonly Sought[]>;
}

/** A page's line taken for the heading of a chapter: which chapter, what it says, and how sure. */
interface Found {
  readonly chapter: number;
  readonly title: string;
  readonly strong: boolean;
}

/** What a line at the top of a page is: the headings it may be, and whether it is a running head naming a chapter. */
interface LineRead {
  readonly found: readonly Found[];
  readonly running: boolean;
}

/** Whether a line is set apart from the page's text, larger or smaller. */
const setApart = (head: PageHead, line: HeadLine) => head.body > 0 && (line.size >= SET_APART.larger * head.body || line.size <= SET_APART.smaller * head.body);

/** The chapter number a line says it is ("CHAPTER VII.", "Chap. 7"), or null. */
function chapterNumberOf(text: string, words: readonly string[]): number | null {
  const numbering = numberedAs(text);
  return numbering && numbering.counts === 'chapter' && CHAPTER_WORDS.has(words[0] ?? '') ? numbering.n : null;
}

/**
 * Whether these words of a page's first line, with a page's number before or after them, are a
 * running head: a chapter's title (as printed, or as an OCR misread it), its name, or its word and
 * number ("STORY OF THE DOOR. 7", "INCID1SNT AT THE WINDOW. 63", "CHAPTER VII. 87"). A heading
 * carries no page number, and a number that is the chapter's own ("07 The Tea Party") is no page's.
 */
function namesWithFolio(rest: readonly string[], folio: string, wanted: Wanted): boolean {
  const n = /^\d+$/.test(folio) ? Number.parseInt(folio, 10) : null;
  const byNumber = chapterNumberOf(rest.join(' '), rest);
  if (byNumber !== null && (wanted.byNumber.get(byNumber)?.length ?? 0) > 0) return true;
  return wanted.story.some(
    (c) =>
      c.n !== n &&
      ((startsWith(rest, c.words) && rest.length - c.words.length <= SPARE_WORDS) || (c.name.length >= 2 && sameWords(rest, c.name)) || misreadAs(rest, c.words)),
  );
}

/**
 * The chapters a line at the top of a page is the heading of (with the line after it, when the
 * heading runs on to it): its chapter word and number ("CHAPTER VII.", "Chapter 7", with at most a
 * few more words, or the chapter's name), the chapter's whole title (with a few words more only when
 * it is set larger than the text), or, set larger than the body, its name alone ("A MAD
 * TEA-PARTY"); as the page's first line, set larger still, its number alone ("VII": lower down, a
 * letter that large is a drop capital). Set well apart from the text, a whole title an OCR misread
 * (misreadAs). A page's first line naming a chapter with a page's number is a running head, and no
 * chapter's heading (namesWithFolio). A heading found by the chapter's whole title is called by
 * the book's own title for it, its words and punctuation as the book prints them, not as an OCR
 * misread them; one found by its number or its name, by what it says, without an OCR's trailing comma.
 */
function readLine(head: PageHead, i: number, wanted: Wanted, open: boolean): LineRead {
  const line = head.lines[i]!;
  const next = head.lines[i + 1];
  const words = wordsOf(line.text);
  const both = next ? [...words, ...wordsOf(next.text)] : words;
  const large = head.body > 0 && line.size >= HEADING_SIZE * head.body;
  const found: Found[] = [];
  const add = (chapter: Sought, title: string) => {
    if (!found.some((f) => f.chapter === chapter.index)) found.push({ chapter: chapter.index, title: title.replace(/\s*[,;]$/, ''), strong: large });
  };
  const exactly = wanted.story.filter((c) => sameWords(words, c.words));
  if (i === 0 && exactly.length === 0 && words.length >= 2) {
    const folio = FOLIO.test(words.at(-1)!) ? 'last' : FOLIO.test(words[0]!) ? 'first' : null;
    if (folio === 'last' && namesWithFolio(words.slice(0, -1), words.at(-1)!, wanted)) return { found: [], running: true };
    if (folio === 'first' && namesWithFolio(words.slice(1), words[0]!, wanted)) return { found: [], running: true };
  }
  for (const chapter of exactly) add(chapter, chapter.title);
  // The number on its line, the name perhaps on the next.
  const lone = words.length === 1 && i === 0 && head.body > 0 && line.size >= NUMERAL_SIZE * head.body ? words[0]! : null;
  const n = chapterNumberOf(line.text, words) ?? (lone !== null ? (romanToInt(lone) ?? (/^\d{1,4}$/.test(lone) ? Number.parseInt(lone, 10) : null)) : null);
  if (n !== null && words.length - 2 <= SHORT_LINE) {
    for (const chapter of wanted.byNumber.get(n) ?? []) {
      const named = next && words.length <= 2 && (startsWith(wordsOf(next.text), chapter.name) || (next.size >= HEADING_SIZE * head.body && wordsOf(next.text).length <= SHORT_LINE));
      add(chapter, named ? `${line.text} ${next.text}` : line.text);
    }
  }
  // The whole title, on this line or running on to the next; the name alone, set as a heading.
  for (const chapter of wanted.byStart.get(words.slice(0, 2).join(' ')) ?? wanted.byStart.get(words[0] ?? '') ?? []) {
    const own = chapter.words;
    if (own.length === 1 ? words.length === 1 && words[0] === own[0] : startsWith(words, own) && words.length - own.length <= (large ? SPARE_WORDS : 0)) add(chapter, chapter.title);
    else if (own.length > words.length && startsWith(both, own) && both.length - own.length <= (large ? SPARE_WORDS : 0)) add(chapter, chapter.title);
    else if (large && chapter.name.length >= 2 && startsWith(words, chapter.name) && words.length - chapter.name.length <= SPARE_WORDS) add(chapter, line.text);
  }
  // Above the text and set well apart from it, a whole title an OCR misread, alone or running on.
  if (open && found.length === 0 && head.body > 0 && line.size >= SET_APART.larger * head.body) {
    for (const chapter of wanted.story) if (misreadAs(words, chapter.words) || (next && misreadAs(both, chapter.words))) add(chapter, chapter.title);
  }
  return { found, running: false };
}

/**
 * Where a PDF without bookmarks starts the book's chapters, from the text at the top of its pages
 * (D74): for each page, the chapter whose heading its first lines are (readLine), above the page's
 * text: after at most lines short enough to be a running head or the page's number, running heads,
 * and lines set apart from the text (a half-title, a cutting pasted over the page's top). A page
 * whose top names two chapters is a contents or a list: none. Of all the pages found, the most
 * chapters in the book's order are kept, a page set as a heading counting for two (a running head
 * repeats a chapter's name on page after page; a contents page escaping the rule above lists it in
 * body type), each at its earliest page. Front matter is not looked for: a PDF lined up by these
 * is lined up as one whose bookmarks name only the story's chapters. Fewer than two found are none.
 */
export function findChapterHeadings(heads: readonly PageHead[], chapters: readonly CanonicalChapter[]): PdfOutlineEntry[] {
  const story = chapters.slice(frontMatterCount(chapters)).map((c, i, all) => sought(c, chapters.length - all.length + i));
  const byNumber = new Map<number, Sought[]>();
  const byStart = new Map<string, Sought[]>();
  const index = <K>(map: Map<K, Sought[]>, key: K, chapter: Sought) => {
    const list = map.get(key);
    if (!list) map.set(key, [chapter]);
    else if (!list.includes(chapter)) list.push(chapter);
  };
  for (const chapter of story) {
    if (chapter.n !== null) index(byNumber, chapter.n, chapter);
    for (const words of [chapter.words, chapter.name]) {
      if (words.length >= 2) index(byStart, words.slice(0, 2).join(' '), chapter);
      else if (words.length === 1) index(byStart, words[0]!, chapter);
    }
  }
  const wanted: Wanted = { story, byNumber, byStart };
  // Each page: the chapter it starts, if its top is the heading of exactly one.
  const candidates: { page: number; chapter: number; weight: number; title: string }[] = [];
  heads.forEach((head, page) => {
    const named = new Set<number>();
    let best: Found | null = null;
    // Still above the page's text.
    let open = true;
    for (let i = 0; i < head.lines.length; i++) {
      const { found, running } = readLine(head, i, wanted, open);
      for (const f of found) {
        named.add(f.chapter);
        if (open && (!best || (f.strong && !best.strong))) best = f;
      }
      const line = head.lines[i]!;
      open &&= running || wordsOf(line.text).length <= SHORT_LINE || setApart(head, line);
    }
    if (best && named.size === 1) candidates.push({ page, chapter: best.chapter, weight: best.strong ? 2 : 1, title: best.title });
  });
  // The heaviest chain of pages and chapters both increasing (each chapter at its earliest page on a tie).
  const size = chapters.length;
  const tree = new Array<number>(size + 1).fill(-1);
  const score: number[] = [];
  const before: number[] = [];
  const better = (a: number, b: number) => b < 0 || score[a]! > score[b]!;
  candidates.forEach((c, j) => {
    let prev = -1;
    for (let k = c.chapter; k > 0; k -= k & -k) if (tree[k]! >= 0 && better(tree[k]!, prev)) prev = tree[k]!;
    score.push(c.weight + (prev >= 0 ? score[prev]! : 0));
    before.push(prev);
    for (let k = c.chapter + 1; k <= size; k += k & -k) if (better(j, tree[k]!)) tree[k] = j;
  });
  let last = -1;
  for (let j = 0; j < candidates.length; j++) if (better(j, last)) last = j;
  const chain: PdfOutlineEntry[] = [];
  for (let j = last; j >= 0; j = before[j]!) chain.push({ title: candidates[j]!.title, page: candidates[j]!.page, y: 0, depth: 0 });
  return chain.length >= 2 ? chain.reverse() : [];
}

/**
 * A PDF's text, read in a worker (align-worker.ts) within its limits: its printed lines as they are
 * kept (PrintedText as JSON, null when it prints too much), and, given the book's chapters (a PDF
 * without bookmarks), the pages their headings top (D74).
 */
export async function pdfText(file: string, chapters: readonly CanonicalChapter[]): Promise<{ headings: PdfOutlineEntry[]; printed: string | null; lines: number }> {
  const { heads, printed, lines } = await readPdfText(file);
  return { headings: chapters.length > 0 ? findChapterHeadings(heads, chapters) : [], printed: printed && JSON.stringify(printed), lines };
}
