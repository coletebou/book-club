import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { textWords } from '../text/words';
import { type CanonicalChapter, syncMapFromAlignment } from './align';
import { type SyncMap, linearSyncMap, mToT, tToM } from './syncmap';
import { MIN_PRINTED_WORDS, type PrintedLine, alignPrinted, printedSync } from './textalign';

/*
 * The real text of the fixtures (fixtures/text/alice-gutenberg-11.txt, which the Alice EPUB and
 * the Alice PDF are both made of), as a text edition's sections and as printed pages set from it
 * here, so that where every printed line comes from in the text is known exactly.
 */

const raw = readFileSync(new URL('../../../../fixtures/text/alice-gutenberg-11.txt', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');

interface Chapter {
  readonly heading: string;
  readonly title: string;
  readonly paragraphs: readonly string[];
}

/** The twelve chapters: heading, name and paragraphs, as scripts/fixtures/make-alice-pdf.mjs reads them. */
const CHAPTERS: readonly Chapter[] = (() => {
  const lines = raw.split('\n');
  const end = lines.findIndex((l) => l.startsWith('*** END OF THE PROJECT GUTENBERG EBOOK'));
  const starts = lines.flatMap((l, i) => (/^CHAPTER [IVXLC]+\.$/.test(l) ? [i] : []));
  return starts.map((start, c) => ({
    heading: lines[start]!.trim(),
    title: lines[start + 1]!.trim(),
    paragraphs: lines
      .slice(start + 2, starts[c + 1] ?? end)
      .join('\n')
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 0),
  }));
})();

/** The text edition, as the EPUB's text measure has it: a section per chapter, its heading and name on lines of their own, its paragraphs apart (italics are markup, not underscores). */
function sectionsOf(chapters: readonly Chapter[]): { text: string }[] {
  return chapters.map((c) => ({ text: `\n${c.heading}\n${c.title}\n\n${c.paragraphs.map((p) => p.replace(/_/g, '')).join('\n\n')}\n` }));
}

interface Printed {
  readonly pages: PrintedLine[][];
  /** For each page's lines, where the line's first word is in the text's measure (null for a line set from nothing in it). */
  readonly sources: (number | null)[][];
}

const LINES_PER_PAGE = 33;
const LINE_HEIGHT = 0.024;

/**
 * The chapters printed as make-alice-pdf.mjs prints them: each on a new page, its heading and name,
 * then its paragraphs about seventy characters a line, the italic marks gone, a page number at the
 * foot of each page. `cut` breaks a long word at a line's end with a hyphen ("conver-" "sations").
 */
function setPages(chapters: readonly Chapter[], options: { cut?: boolean } = {}): Printed {
  const sections = sectionsOf(chapters);
  const pages: PrintedLine[][] = [];
  const sources: (number | null)[][] = [];
  let page: PrintedLine[] = [];
  let source: (number | null)[] = [];
  const close = () => {
    if (page.length === 0) return;
    page.push({ text: String(pages.length + 1), top: 0.93, bottom: 0.95 });
    source.push(null);
    pages.push(page);
    sources.push(source);
    page = [];
    source = [];
  };
  const put = (text: string, from: number | null) => {
    if (page.length === LINES_PER_PAGE) close();
    const top = 0.09 + page.length * LINE_HEIGHT;
    page.push({ text, top, bottom: top + 0.8 * LINE_HEIGHT });
    source.push(from);
  };
  let base = 0;
  chapters.forEach((chapter, c) => {
    close();
    const text = sections[c]!.text;
    // Each printed word at its place in the section (words are found in it in order): where its
    // first letter or digit is, past any quotation mark or italic mark before it.
    let at = 0;
    const find = (word: string) => {
      const plain = word.replace(/_/g, '');
      const found = text.indexOf(plain, at);
      at = found + plain.length;
      // A line of no words (a row of stars between scenes) starts nowhere in particular.
      return { plain, from: textWords(plain).length > 0 ? base + found + Math.max(0, plain.search(/[\p{L}\p{N}]/u)) : null };
    };
    put(chapter.heading, find(chapter.heading).from);
    put(chapter.title, find(chapter.title).from);
    for (const paragraph of chapter.paragraphs) {
      let line = '';
      let lineFrom: number | null = null;
      for (const word of paragraph.split(' ')) {
        const { plain, from } = find(word);
        if (line && line.length + plain.length + 1 > 70) {
          if (options.cut && plain.length >= 8 && /^[a-z]+$/.test(plain)) {
            // Hyphenated: its first half ends this line, its second starts the next.
            const half = Math.floor(plain.length / 2);
            put(`${line} ${plain.slice(0, half)}-`, lineFrom);
            line = plain.slice(half);
            lineFrom = null;
            continue;
          }
          put(line, lineFrom);
          line = plain;
          lineFrom = from;
        } else {
          if (!line) lineFrom = from;
          line = line ? `${line} ${plain}` : plain;
        }
      }
      if (line) put(line, lineFrom);
    }
    base += text.length;
  });
  close();
  return { pages, sources };
}

const SECTIONS = sectionsOf(CHAPTERS);
const TOTAL = SECTIONS.reduce((n, s) => n + s.text.length, 0);
const STORY = { start: 0, end: TOTAL };
const TEXT_SYNC = linearSyncMap(0, TOTAL);
const SECTION_STARTS = SECTIONS.map((_, i) => SECTIONS.slice(0, i).reduce((n, s) => n + s.text.length, 0));
const BOOK_CHAPTERS: CanonicalChapter[] = CHAPTERS.map((c, i) => ({ title: `${c.heading} ${c.title}`, t: mToT(TEXT_SYNC, SECTION_STARTS[i]!) }));

/** The PDF's chapter-level map, from where each chapter's page starts (as its bookmarks would say). */
function chapterMap(set: Printed, chapters = BOOK_CHAPTERS.length): SyncMap {
  const units = set.pages.flatMap((lines, p) => (lines.some((l) => /^CHAPTER [IVXLC]+\.$/.test(l.text)) ? [{ title: '', m: p }] : []));
  const pairs = units.slice(0, chapters).map((_, i) => ({ unit: i, chapter: i }));
  return syncMapFromAlignment(BOOK_CHAPTERS, units, { method: 'manual', pairs }, set.pages.length);
}

/** Words the page numbers print ("21" is "twenty one"): the only printed words not in the text. */
const folioWords = (set: Printed) => set.pages.reduce((n, _, p) => n + textWords(String(p + 1)).length, 0);

const options = (set: Printed, fallback: SyncMap) => ({
  pdfIsReference: false,
  pdfSync: linearSyncMap(0, set.pages.length),
  textSync: TEXT_SYNC,
  fallback,
  chapters: BOOK_CHAPTERS,
  straightReach: 0.06,
});

describe('lining a PDF’s printed lines up with the text (D75)', () => {
  const set = setPages(CHAPTERS);

  it('ties every printed line of Alice where its first word is in the text, and the end of each page’s words', () => {
    const alignment = alignPrinted({ sections: SECTIONS, story: STORY, pages: set.pages });
    expect(alignment.stats.textWords).toBeGreaterThan(26_000);
    // Every word but the page numbers.
    expect(alignment.stats.anchoredWords).toBe(alignment.stats.printedWords - folioWords(set));
    let compared = 0;
    for (const tie of alignment.ties.filter((t) => !t.end)) {
      const line = set.pages[tie.page]!.findIndex((l) => Math.abs(tie.page + l.top - tie.m) < 1e-9);
      const from = set.sources[tie.page]![line];
      if (from === null || from === undefined) continue;
      expect(tie.x).toBe(from);
      compared++;
    }
    // Every line with words but the page numbers is tied there, and each page's words end once.
    expect(compared).toBe(set.sources.flat().filter((from) => from !== null).length);
    expect(alignment.ties.filter((tie) => tie.end)).toHaveLength(set.pages.length);
  });

  it('makes the PDF’s map from them: every line where its words are, every page trusted, the pages holding exactly their own words', () => {
    const result = printedSync(alignPrinted({ sections: SECTIONS, story: STORY, pages: set.pages }), options(set, chapterMap(set)));
    expect(result.stats).toMatchObject({ pages: set.pages.length, trustedPages: set.pages.length, outOfPlace: 0 });
    expect(result.exact).toHaveLength(1);
    const sync = result.sync!;
    set.pages.forEach((lines, p) =>
      lines.forEach((line, k) => {
        const from = set.sources[p]![k];
        if (from === null || from === undefined) return;
        expect(mToT(sync, p + line.top)).toBeCloseTo(mToT(TEXT_SYNC, from), 10);
        // And the other way: a word's place is on its own line.
        const m = tToM(sync, mToT(TEXT_SYNC, from + 1));
        expect(Math.floor(m)).toBe(p);
        expect(m - p).toBeGreaterThanOrEqual(line.top);
        expect(m - p).toBeLessThan(lines[k + 1]?.top ?? 1);
      }),
    );
  });

  it('joins a word cut by a hyphen at a line’s end where the text has it whole', () => {
    const cut = setPages(CHAPTERS, { cut: true });
    const hyphenated = cut.pages.flat().filter((l) => /\p{L}-$/u.test(l.text)).length;
    expect(hyphenated).toBeGreaterThan(50);
    const alignment = alignPrinted({ sections: SECTIONS, story: STORY, pages: cut.pages });
    // Each cut word counts once, whole, and is lined up.
    expect(alignment.stats.printedWords).toBe(alignment.stats.textWords + folioWords(cut));
    expect(alignment.stats.anchoredWords).toBe(alignment.stats.textWords);
    const result = printedSync(alignment, options(cut, chapterMap(cut)));
    expect(result.stats.trustedPages).toBe(cut.pages.length);
  });

  it('keeps two words a hyphen joins in the text two, cut at a line’s end ("rabbit-" "hole")', () => {
    const pages: PrintedLine[][] = [
      [
        { text: 'The rabbit-hole went straight on like a tunnel for some way, and then dipped suddenly down, so suddenly that Alice had not a', top: 0.1, bottom: 0.12 },
        { text: 'moment to think about stopping herself before she found herself falling down a very deep well, rabbit-', top: 0.124, bottom: 0.144 },
        { text: 'hole after rabbit-hole, Either the well was very deep, or she fell very slowly', top: 0.148, bottom: 0.168 },
      ],
    ];
    const words = alignPrinted({ sections: [{ text: 'The rabbit-hole went straight on like a tunnel for some way, and then dipped suddenly down, so suddenly that Alice had not a moment to think about stopping herself before she found herself falling down a very deep well, rabbit-hole after rabbit-hole, Either the well was very deep, or she fell very slowly' }], story: { start: 0, end: 10_000 }, pages });
    expect(words.stats).toMatchObject({ printedWords: words.stats.textWords, anchoredWords: words.stats.textWords });
  });

  it('follows the pages around one that is not the book’s (an advertisement), and does not trust it', () => {
    const advert = 'Ask your bookseller for the new illustrated edition of the complete works in twelve handsome volumes bound in cloth';
    const pages = set.pages.map((lines) => [...lines]);
    pages.splice(20, 0, Array.from({ length: 20 }, (_, k) => ({ text: advert, top: 0.09 + k * LINE_HEIGHT, bottom: 0.11 + k * LINE_HEIGHT })));
    const withAdvert = { pages, sources: [...set.sources.slice(0, 20), pages[20]!.map(() => null), ...set.sources.slice(20)] };
    const result = printedSync(alignPrinted({ sections: SECTIONS, story: STORY, pages }), options(withAdvert, linearSyncMap(0, pages.length)));
    expect(result.stats.trustedPages).toBe(pages.length - 1);
    // Exact before it and after it, not on it.
    expect(result.exact).toHaveLength(2);
    expect(result.exact[0]![1]).toBeLessThan(20);
    expect(result.exact[1]![0]).toBeGreaterThan(21);
    // On it, the map goes from the end of the page before to the start of the page after.
    const sync = result.sync!;
    expect(mToT(sync, 20.5)).toBeGreaterThanOrEqual(mToT(sync, 19.99));
    expect(mToT(sync, 20.5)).toBeLessThanOrEqual(mToT(sync, 21 + pages[21]![0]!.top));
  });

  it('ties a line with no word on it (a dash alone) where the line before it ended', () => {
    const pages: PrintedLine[][] = [
      [
        { text: 'even Stigand, the patriotic archbishop of Canterbury, found it advisable', top: 0.1, bottom: 0.12 },
        { text: '—’”', top: 0.124, bottom: 0.144 },
        { text: '“Found what?” said the Duck. “Found it,” the Mouse replied rather crossly', top: 0.148, bottom: 0.168 },
      ],
    ];
    const text = 'even Stigand, the patriotic archbishop of Canterbury, found it advisable—’”\n\n“Found what?” said the Duck. “Found it,” the Mouse replied rather crossly';
    const { ties } = alignPrinted({ sections: [{ text }], story: { start: 0, end: text.length }, pages });
    expect(ties.map((tie) => [tie.m, tie.x, tie.end])).toEqual([
      [0.1, 0, false],
      [0.124, text.indexOf('—'), false],
      [0.148, text.indexOf('Found what'), false],
      [0.168, text.length, true],
    ]);
  });
});

describe('a printed text that is not the book’s, or not where its chapter map puts it, is refused (D75)', () => {
  it('Alice read backwards: the same words, never four in a row', () => {
    const backwards = CHAPTERS.map((c) => ({ ...c, paragraphs: c.paragraphs.map((p) => p.split(' ').reverse().join(' ')) }));
    const set = setPages(backwards);
    const alignment = alignPrinted({ sections: SECTIONS, story: STORY, pages: set.pages });
    // An edit-distance alignment pairs many common words; hardly any in a run of four.
    expect(alignment.stats.matchedWords / alignment.stats.printedWords).toBeGreaterThan(0.1);
    expect(alignment.stats.anchoredWords / alignment.stats.printedWords).toBeLessThan(0.05);
    const result = printedSync(alignment, options(set, chapterMap(set)));
    expect(result).toMatchObject({ sync: null, exact: [], stats: { trustedPages: 0 } });
  });

  it('half of Alice on a straight line over the whole book (a match D73 refuses): out of place, refused', () => {
    const half = setPages(CHAPTERS.slice(0, 6));
    const alignment = alignPrinted({ sections: SECTIONS, story: STORY, pages: half.pages });
    expect(alignment.stats.anchoredWords).toBe(alignment.stats.printedWords - folioWords(half));
    const result = printedSync(alignment, options(half, linearSyncMap(0, half.pages.length)));
    expect(result.sync).toBeNull();
    expect(result.stats.outOfPlace).toBeGreaterThan(alignment.ties.length / 2);
  });

  it('half of Alice matched to its six chapters: lined up', () => {
    const half = setPages(CHAPTERS.slice(0, 6));
    const result = printedSync(alignPrinted({ sections: SECTIONS, story: STORY, pages: half.pages }), options(half, chapterMap(half, 6)));
    expect(result.stats).toMatchObject({ trustedPages: half.pages.length, outOfPlace: 0 });
    expect(result.sync!.points.length).toBeGreaterThan(1000);
  });

  it('Alice on a straight line (no bookmarks, no headings found): within the line’s own margin, lined up', () => {
    const set = setPages(CHAPTERS);
    const result = printedSync(alignPrinted({ sections: SECTIONS, story: STORY, pages: set.pages }), options(set, linearSyncMap(0, set.pages.length)));
    expect(result.stats.trustedPages).toBe(set.pages.length);
    expect(result.sync).not.toBeNull();
  });

  it('a page or two of it: too few words to go by', () => {
    const set = setPages(CHAPTERS);
    const few = { pages: [set.pages[1]!.slice(0, 1)], sources: [set.sources[1]!.slice(0, 1)] };
    const alignment = alignPrinted({ sections: SECTIONS, story: STORY, pages: few.pages });
    expect(alignment.stats.anchoredWords).toBeLessThan(MIN_PRINTED_WORDS);
    expect(printedSync(alignment, options(few, linearSyncMap(0, 1))).sync).toBeNull();
  });
});

describe('the text lined up with a PDF the timeline rests on (D75)', () => {
  it('refines the text’s map instead: each printed line where the PDF has it', () => {
    const set = setPages(CHAPTERS);
    const pdfSync = linearSyncMap(0, set.pages.length);
    // The text's chapter map against the PDF's chapters: each section starts its chapter's page.
    const pageOfChapter = set.pages.flatMap((lines, p) => (lines.some((l) => /^CHAPTER [IVXLC]+\.$/.test(l.text)) ? [p] : []));
    const pdfChapters = pageOfChapter.map((p, i) => ({ title: BOOK_CHAPTERS[i]!.title, t: mToT(pdfSync, p) }));
    const units = SECTION_STARTS.map((m) => ({ title: '', m }));
    const fallback = syncMapFromAlignment(pdfChapters, units, { method: 'manual', pairs: units.map((_, i) => ({ unit: i, chapter: i })) }, TOTAL);
    const result = printedSync(alignPrinted({ sections: SECTIONS, story: STORY, pages: set.pages }), {
      pdfIsReference: true,
      pdfSync,
      textSync: fallback,
      fallback,
      chapters: pdfChapters,
      straightReach: 0.06,
    });
    expect(result.stats.trustedPages).toBe(set.pages.length);
    // In the text's own measure, from its first printed line to its last.
    expect(result.exact).toHaveLength(1);
    expect(result.exact[0]![0]).toBe(set.sources[0]![0]);
    const sync = result.sync!;
    set.pages.forEach((lines, p) =>
      lines.forEach((line, k) => {
        const from = set.sources[p]![k];
        if (from === null || from === undefined) return;
        expect(mToT(sync, from)).toBeCloseTo(mToT(pdfSync, p + line.top), 10);
      }),
    );
  });
});

describe('the words compared', () => {
  it('are the text’s normalised words: digits and the Roman numerals of headings spelled out, as forced alignment has them', () => {
    expect(textWords('CHAPTER IV. 1865').map((w) => w.norm)).toEqual(['chapter', 'four', 'eighteen', 'sixty', 'five']);
    const pages: PrintedLine[][] = [[{ text: 'CHAPTER IV. The Rabbit Sends in a Little Bill, in 1865', top: 0.1, bottom: 0.12 }]];
    const text = '\nCHAPTER 4.\nThe Rabbit Sends in a Little Bill, in eighteen sixty-five\n';
    const { stats } = alignPrinted({ sections: [{ text }], story: { start: 0, end: text.length }, pages });
    expect(stats).toMatchObject({ printedWords: 13, matchedWords: 13, anchoredWords: 13 });
  });
});
