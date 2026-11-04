import { textWords } from '../text/words';
import { type ChapterLike } from './chapters';
import { matchWords } from './forced';
import { type SyncMap, type TiePoint, mToT, syncMapFromTiePoints } from './syncmap';

/**
 * A PDF's printed text lined up with the book's text (D75): which printed word is which word of
 * the EPUB, and from that, where every printed line starts in the text. It is the forced alignment
 * of an audiobook (forced.ts, D46) with the PDF's text in the place of what a recogniser heard, and
 * the same matching: normalised words, runs of words found once on each side kept in the same
 * order on both, small edit-distance alignments between them. Nothing is read here: the server
 * reads the PDF's lines in a worker (ingest/pdf.ts) and the EPUB's sections as readers measure them.
 *
 * 1. Both sides become normalised words; a word cut by a hyphen at a line's end is whole again
 *    where the text has it whole ("conver-" "sations"; "rabbit-" "hole" stays two words).
 * 2. matchWords pairs them.
 * 3. A word counts as lined up (anchored) only inside a run of RUN_WORDS pairs or more in a row on
 *    both sides: a common word an edit-distance alignment paired between unrelated texts does not.
 * 4. Each printed line with an anchored word is tied to the text at its start, a line between two
 *    of them without any where the one before it ended; the last such line of a page also at its
 *    end, so that a page holds exactly its own words.
 * 5. printedSync: a page is trusted when at least half of its words are anchored and its lines
 *    stay where the chapter-level map puts them, give or take the stretch that map interpolates
 *    there (a line may move inside its chapter, never across the book; and no more than a few of
 *    all of them may not); the refined edition's map is tied at every line of the trusted pages,
 *    and keeps the chapter map before and after them.
 */

/** A line printed on a page: what it says, and where it stands, in fractions of the page's height from its top. */
export interface PrintedLine {
  readonly text: string;
  /** The top of its type, an em above its baseline: above where a selection on the line starts. */
  readonly top: number;
  /** The bottom of its type, below its descenders. */
  readonly bottom: number;
}

export interface PrintedInput {
  /** The text edition's sections, as readers measure them (their text measure). */
  readonly sections: readonly { readonly text: string }[];
  /** The part of the text's measure that is the story (a licence after it is not printed). */
  readonly story: { readonly start: number; readonly end: number };
  /** The PDF's pages, each its lines top down. */
  readonly pages: readonly (readonly PrintedLine[])[];
}

/** Where a printed line meets the text. */
export interface PrintedTie {
  readonly page: number;
  /** In the PDF's measure: the page plus the line's top, or, at the end of a page's words, its last line's bottom. */
  readonly m: number;
  /** In the text's measure: where the line's words start (a line without any, where the one before it ended), or where the page's end. */
  readonly x: number;
  /** The end of a page's words, not the start of a line. */
  readonly end: boolean;
}

export interface PrintedPage {
  /** Words printed on it. */
  readonly words: number;
  /** Of those, the ones lined up in a run of RUN_WORDS or more. */
  readonly anchored: number;
}

export interface PrintedStats {
  readonly textWords: number;
  readonly printedWords: number;
  /** Printed words paired with a word of the text. */
  readonly matchedWords: number;
  /** Of those, the ones inside a run of RUN_WORDS or more: what the trust and the map rest on. */
  readonly anchoredWords: number;
  /** Lines with words on them. */
  readonly lines: number;
  /** Of those, the ones tied to the text (an anchored word on them). */
  readonly tiedLines: number;
}

export interface PrintedAlignment {
  /** In reading order, increasing in both measures. */
  readonly ties: readonly PrintedTie[];
  readonly pages: readonly PrintedPage[];
  readonly stats: PrintedStats;
}

/** Pairs in a row on both sides for a word to count as lined up. */
export const RUN_WORDS = 4;
/** A page is trusted when at least this share of its words is lined up (forced.ts trusts a track at half). */
export const PAGE_MATCH_RATIO = 0.5;
/** Share of ties that may land outside the stretch the chapter map puts them in before a page (or, of all of them, the PDF) is not trusted. */
const OUT_OF_PLACE_SHARE = 0.05;
/** Fewer words lined up than this on the trusted pages is no alignment (forced.ts: twenty for a track). */
export const MIN_PRINTED_WORDS = 20;
/** Characters of a printed line read: a line of a book has a hundred; one made of a hundred thousand runs is not read whole. */
export const PRINTED_LINE_CHARS = 1000;

/** A line ending in a hyphen (a soft one too) after a letter: its last word may go on on the next line. */
const HYPHENATED = /\p{L}[-\u00AD\u2010]$/u;
const SOFT_HYPHEN = /\u00AD/g;
const STARTS_LOWER = /^\p{Ll}/u;
const HAS_LOWER = /\p{Ll}/u;

interface Printed {
  readonly norm: string;
  readonly page: number;
  readonly line: number;
  /** Where it is in its line's text (end exclusive). */
  readonly start: number;
  readonly end: number;
}

/**
 * The printed words, page by page and line by line. A word cut by a hyphen at a line's end is
 * joined with the start of the next line with lower-case letters (past a page's number at its
 * foot) when the text has that word (`vocabulary`), and stands where it starts.
 */
function printedWords(pages: readonly (readonly PrintedLine[])[], vocabulary: ReadonlySet<string>): { words: Printed[]; lines: number } {
  const out: Printed[] = [];
  let lines = 0;
  // A word cut at the end of the line before, waiting for the rest of it.
  let cut: Printed | null = null;
  pages.forEach((page, p) => {
    page.forEach((line, k) => {
      const raw = line.text.slice(0, PRINTED_LINE_CHARS);
      // A soft hyphen inside a word is no break in it.
      const text = raw.replace(SOFT_HYPHEN, '');
      const own: Printed[] = textWords(text).map((w) => ({ norm: w.norm, page: p, line: k, start: w.start, end: w.end }));
      if (own.length > 0) lines++;
      if (cut && !HAS_LOWER.test(text)) {
        // A page's number, a row of stars, a running head in capitals: not the rest of the cut word.
        out.push(...own);
        return;
      }
      const next = own[0];
      if (cut && next && STARTS_LOWER.test(text.slice(next.start)) && vocabulary.has(cut.norm + next.norm)) {
        out.push({ ...cut, norm: cut.norm + next.norm });
        own.shift();
      } else if (cut) out.push(cut);
      cut = null;
      if (own.length > 0 && HYPHENATED.test(raw.trimEnd())) cut = own.pop()!;
      out.push(...own);
    });
  });
  if (cut) out.push(cut);
  return { words: out, lines };
}

/** Line a PDF's printed lines up with the text: a tie at the start of each line whose words were found, and at the end of each page's words. */
export function alignPrinted(input: PrintedInput): PrintedAlignment {
  const { sections, story, pages } = input;
  const text: { norm: string; start: number; end: number }[] = [];
  let base = 0;
  for (const section of sections) {
    for (const w of textWords(section.text, base)) if (w.start >= story.start && w.end <= story.end) text.push(w);
    base += section.text.length;
  }
  const { words: printed, lines } = printedWords(pages, new Set(text.map((w) => w.norm)));
  const match = matchWords(
    text.map((w) => w.norm),
    printed.map((w) => w.norm),
  );
  // For each printed word, the word of the text it is.
  const toText = new Int32Array(printed.length).fill(-1);
  let matchedWords = 0;
  match.forEach((j, i) => {
    if (j < 0) return;
    toText[j] = i;
    matchedWords++;
  });
  // Lined up: inside a run of pairs in a row on both sides.
  const anchored = new Uint8Array(printed.length);
  for (let j = 0; j < printed.length; ) {
    let k = j + 1;
    if (toText[j]! >= 0) while (k < printed.length && toText[k]! === toText[k - 1]! + 1) k++;
    if (toText[j]! >= 0 && k - j >= RUN_WORDS) anchored.fill(1, j, k);
    j = k;
  }
  // Each line's words: its first and last word, and its first and last word lined up.
  const lineBase: number[] = [];
  let lineCount = 0;
  for (const page of pages) {
    lineBase.push(lineCount);
    lineCount += page.length;
  }
  const words = { first: new Int32Array(lineCount).fill(-1), last: new Int32Array(lineCount).fill(-1) };
  const lined = { first: new Int32Array(lineCount).fill(-1), last: new Int32Array(lineCount).fill(-1) };
  const perPage = pages.map(() => ({ words: 0, anchored: 0 }));
  printed.forEach((w, j) => {
    const i = lineBase[w.page]! + w.line;
    if (words.first[i]! < 0) words.first[i] = j;
    words.last[i] = j;
    perPage[w.page]!.words++;
    if (!anchored[j]) return;
    perPage[w.page]!.anchored++;
    if (lined.first[i]! < 0) lined.first[i] = j;
    lined.last[i] = j;
  });

  // A line with a word lined up starts where that word is in the text, less what comes before it
  // on the line, and ends past its last one by what follows that; a line between two such lines
  // with none (a dash alone, a caption) starts where the line before it ended; the end of a page's
  // words is where its last such line ends.
  const ties: PrintedTie[] = [];
  let tiedLines = 0;
  // Where the text the lines tied so far hold ends.
  let reached = -Infinity;
  pages.forEach((lines, p) => {
    let lastTied = -1;
    lines.forEach((_, k) => {
      if (lined.first[lineBase[p]! + k]! >= 0) lastTied = k;
    });
    let seen = false;
    for (let k = 0; k <= lastTied; k++) {
      const i = lineBase[p]! + k;
      const line = lines[k]!;
      const a = lined.first[i]!;
      if (a < 0) {
        if (seen) ties.push({ page: p, m: p + line.top, x: reached, end: false });
        continue;
      }
      const z = lined.last[i]!;
      const x = Math.max(reached, text[toText[a]!]!.start - (printed[a]!.start - printed[words.first[i]!]!.start));
      ties.push({ page: p, m: p + line.top, x, end: false });
      tiedLines++;
      seen = true;
      reached = Math.max(x, text[toText[z]!]!.end + Math.max(0, printed[words.last[i]!]!.end - printed[z]!.end));
      if (k === lastTied) ties.push({ page: p, m: p + Math.max(line.bottom, line.top), x: reached, end: true });
    }
  });
  // A page's words end no further on than where the next page's start.
  for (let i = ties.length - 2; i >= 0; i--) {
    const tie = ties[i]!;
    if (tie.end && tie.x > ties[i + 1]!.x) ties[i] = { ...tie, x: ties[i + 1]!.x };
  }
  return {
    ties,
    pages: perPage,
    stats: { textWords: text.length, printedWords: printed.length, matchedWords, anchoredWords: anchored.reduce((n, a) => n + a, 0), lines, tiedLines },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The refined edition's map                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface PrintedSyncOptions {
  /** The book's timeline rests on the PDF: then the text's map is refined, else the PDF's. */
  readonly pdfIsReference: boolean;
  readonly pdfSync: SyncMap;
  readonly textSync: SyncMap;
  /** The refined edition's chapter-level map: what the alignment must agree with, and keeps where it is not trusted. */
  readonly fallback: SyncMap;
  readonly chapters: readonly ChapterLike[];
  /**
   * How far from a chapter map that is a straight line (matched to no chapter) a line may be, as a
   * share of the book: that line's own margin (LINE_SHARE, D74).
   */
  readonly straightReach: number;
}

export interface PrintedSyncStats extends PrintedStats {
  readonly pages: number;
  /** Pages with words on them. */
  readonly printedPages: number;
  readonly trustedPages: number;
  /** Ties not where the chapter map puts their place. */
  readonly outOfPlace: number;
}

export interface PrintedSync {
  /** The refined edition's new map, or null when the alignment is trusted nowhere. */
  readonly sync: SyncMap | null;
  /** Stretches of the refined edition's measure lined up line by line: from the first tie of each run of trusted pages to its last. */
  readonly exact: [number, number][];
  readonly stats: PrintedSyncStats;
}

/** Ties keep this many decimals: a millionth of a page, a trillionth of the book. */
function round(x: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(x * scale) / scale;
}

/** The last index of a sorted list whose value is at most x (0 when none is). */
function atOrBefore(values: readonly number[], x: number): number {
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (values[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The refined edition's map from a printed alignment, and where it is exact. Each tie is placed on
 * the timeline by the edition that stays as it is (the text, or the PDF the timeline rests on). A
 * tie is out of place when that is further from where the refined edition's chapter map puts it
 * than the stretch that map interpolates there, and than the chapter it is in (as withinChapters
 * judges a sentence, forced.ts); from a straight line, than `straightReach` of the book. More than
 * a few ties out of place in all, and nothing is trusted (the PDF as one track); a page with more
 * than a few of its own is not; a tie out of place on a trusted page is dropped. Untrusted pages
 * between trusted ones follow the ties around them; before the first trusted tie and after the
 * last, the chapter map stays.
 */
export function printedSync(alignment: PrintedAlignment, options: PrintedSyncOptions): PrintedSync {
  const { pdfIsReference, pdfSync, textSync, fallback, chapters, straightReach } = options;
  const starts = [...new Set([0, ...chapters.map((c) => c.t)])].sort((a, b) => a - b);
  const chapterLength = (t: number) => {
    const i = atOrBefore(starts, t);
    return (starts[i + 1] ?? 1) - starts[i]!;
  };
  const fallbackAt = fallback.points.map((p) => p.m);
  const stretchAt = (m: number) => {
    const i = Math.min(atOrBefore(fallbackAt, m), fallback.points.length - 2);
    return fallback.points[i + 1]!.t - fallback.points[i]!.t;
  };
  const straight = fallback.points.length === 2;
  const placed = alignment.ties.map((tie) => {
    const own = pdfIsReference ? tie.x : tie.m;
    const t = pdfIsReference ? mToT(pdfSync, tie.m) : mToT(textSync, tie.x);
    const reach = straight ? straightReach : Math.max(chapterLength(t), stretchAt(own));
    return { tie, own, t, inPlace: Math.abs(t - mToT(fallback, own)) <= reach };
  });
  const pageTies = alignment.pages.map(() => ({ all: 0, out: 0 }));
  for (const p of placed) {
    pageTies[p.tie.page]!.all++;
    if (!p.inPlace) pageTies[p.tie.page]!.out++;
  }
  const trusted = alignment.pages.map((page, p) => {
    const ties = pageTies[p]!;
    return page.words > 0 && page.anchored >= page.words * PAGE_MATCH_RATIO && ties.all > ties.out && ties.out <= ties.all * OUT_OF_PLACE_SHARE;
  });
  const kept = placed.filter((p) => p.inPlace && trusted[p.tie.page]);
  const stats: PrintedSyncStats = {
    ...alignment.stats,
    pages: alignment.pages.length,
    printedPages: alignment.pages.filter((p) => p.words > 0).length,
    trustedPages: trusted.filter(Boolean).length,
    outOfPlace: placed.filter((p) => !p.inPlace).length,
  };
  const anchoredWords = alignment.pages.reduce((n, page, p) => n + (trusted[p] ? page.anchored : 0), 0);
  const head = kept[0];
  const tail = kept[kept.length - 1];
  // More than a few out of place in all: the chapter map is not of this text (a part of the book
  // spread over all of it, D73), or the text is not the book's. Neither is lined up by it.
  const misplaced = stats.outOfPlace > placed.length * OUT_OF_PLACE_SHARE;
  if (!head || !tail || kept.length < 2 || anchoredWords < MIN_PRINTED_WORDS || misplaced) return { sync: null, exact: [], stats };

  // Runs of trusted pages; a page without words between two of them is in the run.
  const exact: [number, number][] = [];
  let run: [number, number] | null = null;
  let page = head.tie.page;
  for (const p of kept) {
    let broken = false;
    for (let q = page + 1; q < p.tie.page && !broken; q++) broken = alignment.pages[q]!.words > 0 && !trusted[q];
    if (!run || broken) exact.push((run = [p.own, p.own]));
    else run[1] = p.own;
    page = p.tie.page;
  }
  const measure = (m: number) => (pdfIsReference ? m : round(m, 6));
  const points: TiePoint[] = [
    ...fallback.points.filter((p) => p.m < head.own).map((p) => ({ m: p.m, t: Math.min(p.t, head.t) })),
    ...kept.map((p) => ({ m: measure(p.own), t: round(p.t, 12) })),
    ...fallback.points.filter((p) => p.m > tail.own).map((p) => ({ m: p.m, t: Math.max(p.t, tail.t) })),
  ];
  return { sync: syncMapFromTiePoints(points), exact: exact.map(([a, b]) => [measure(a), measure(b)]), stats };
}
