import { describe, expect, it } from 'vitest';
import { intToRoman, prettifyTrackTitle, titleSimilarity } from '../text/titles';
import {
  FRONT_MATTER_MAX,
  MAX_EDITION_UNITS,
  MAX_TITLE_MATCH_CELLS,
  MIN_MATCHED_SPAN,
  alignUnitsToChapters,
  chaptersInOrder,
  frontMatterCount,
  manualAlignment,
  plausiblePace,
  plausibleSpan,
  syncMapFromAlignment,
} from './align';
import { mToT } from './syncmap';

const aliceChapters = [
  'CHAPTER I. Down the Rabbit-Hole',
  'CHAPTER II. The Pool of Tears',
  'CHAPTER III. A Caucus-Race and a Long Tale',
  'CHAPTER IV. The Rabbit Sends in a Little Bill',
  'CHAPTER V. Advice from a Caterpillar',
  'CHAPTER VI. Pig and Pepper',
  'CHAPTER VII. A Mad Tea-Party',
  'CHAPTER VIII. The Queen’s Croquet-Ground',
  'CHAPTER IX. The Mock Turtle’s Story',
  'CHAPTER X. The Lobster Quadrille',
  'CHAPTER XI. Who Stole the Tarts?',
  'CHAPTER XII. Alice’s Evidence',
].map((title, i) => ({ title, t: i / 12 }));

const librivoxTracks = Array.from({ length: 12 }, (_, i) => ({
  title: `wonderland_ch_${String(i + 1).padStart(2, '0')}`,
  m: i * 600_000,
}));

describe('alignUnitsToChapters', () => {
  it('pairs LibriVox tracks with EPUB chapters by count', () => {
    const a = alignUnitsToChapters(aliceChapters, librivoxTracks);
    expect(a.method).toBe('count');
    expect(a.pairs).toHaveLength(12);
    expect(a.pairs[11]).toEqual({ unit: 11, chapter: 11 });
  });

  it('matches by chapter number when an intro track shifts the count', () => {
    const tracks = [{ title: '00 - Introduction', m: 0 }, ...librivoxTracks.map((u) => ({ ...u, m: u.m + 60_000 }))];
    const a = alignUnitsToChapters(aliceChapters, tracks);
    expect(a.method).toBe('number');
    expect(a.pairs[0]).toEqual({ unit: 1, chapter: 0 });
    expect(a.pairs).toHaveLength(12);
  });

  it('falls back to titles when there are no numbers', () => {
    const chapters = [
      { title: 'Prologue: The Long Night', t: 0 },
      { title: 'The Village at Dawn', t: 0.3 },
      { title: 'A Letter from the North', t: 0.7 },
    ];
    const units = [
      { title: 'Opening credits', m: 0 },
      { title: 'Narrator’s note', m: 50 },
      { title: 'The village at dawn', m: 100 },
      { title: 'A letter from the north', m: 200 },
    ];
    const a = alignUnitsToChapters(chapters, units);
    expect(a.method).toBe('title');
    expect(a.pairs).toEqual([
      { unit: 2, chapter: 1 },
      { unit: 3, chapter: 2 },
    ]);
  });

  it('refuses count pairing when the chapter numbers disagree', () => {
    const units = librivoxTracks.map((u, i) => ({ ...u, title: `Chapter ${12 - i}` }));
    const a = alignUnitsToChapters(aliceChapters, units);
    expect(a.method).not.toBe('count');
  });

  it('refuses a match that would put half an audiobook into its last chapter (24 parts, 12 chapters)', () => {
    const parts = Array.from({ length: 24 }, (_, i) => ({ title: String(i + 1).padStart(2, '0'), m: i * 600_000 }));
    const end = 24 * 600_000;
    // Without the extent, the numbers alone look like chapters 1 to 12.
    expect(alignUnitsToChapters(aliceChapters, parts).method).toBe('number');
    const a = alignUnitsToChapters(aliceChapters, parts, end);
    expect(a.method).toBe('none');
    // So the parts spread evenly: half-way through the audio is half-way through the book.
    expect(mToT(syncMapFromAlignment(aliceChapters, parts, a, end), end / 2)).toBeCloseTo(0.5, 6);
  });

  it('matches tracks that each hold two chapters by the first of them', () => {
    const tracks = Array.from({ length: 6 }, (_, i) => ({ title: `Chapters ${2 * i + 1}-${2 * i + 2}`, m: i * 1_200_000 }));
    const a = alignUnitsToChapters(aliceChapters, tracks, 6 * 1_200_000);
    expect(a.method).toBe('number');
    expect(a.pairs).toEqual([0, 1, 2, 3, 4, 5].map((i) => ({ unit: i, chapter: 2 * i })));
  });

  it('keeps an honest match whose chapters differ in length', () => {
    const lengths = [5, 7, 6, 9, 8, 6, 10, 9, 8, 7, 9, 11];
    const total = lengths.reduce((a, b) => a + b, 0);
    let at = 0;
    const chapters = lengths.map((len, i) => {
      const c = { title: aliceChapters[i]!.title, t: at / total };
      at += len;
      return c;
    });
    let m = 0;
    // Narration a little faster in some chapters than others (±30 %).
    const tracks = lengths.map((len, i) => {
      const u = { title: `wonderland_ch_${String(i + 1).padStart(2, '0')}`, m };
      m += len * 60_000 * (i % 3 === 0 ? 1.3 : i % 3 === 1 ? 0.7 : 1);
      return u;
    });
    expect(alignUnitsToChapters(chapters, tracks, m).method).toBe('count');
  });

  it('returns no pairs when nothing matches', () => {
    expect(alignUnitsToChapters([], librivoxTracks).method).toBe('none');
    expect(alignUnitsToChapters(aliceChapters, [{ title: 'Side A', m: 0 }]).method).toBe('none');
  });

  it('refuses chapters squeezed into a moment, though each stretch between them is too short to judge on the book’s side', () => {
    // A ten-hour audiobook defined the book: its eleven chapter marks fall in its first 33 seconds.
    const hours10 = 10 * 3600_000;
    const squeezed = Array.from({ length: 11 }, (_, i) => ({ title: `Chapter ${i + 1}`, t: (i * 3000) / hours10 }));
    // The text has eleven chapters of equal length.
    const text = Array.from({ length: 11 }, (_, i) => ({ title: `Chapter ${i + 1}`, m: i * 1000 }));
    const byCount = { method: 'count' as const, pairs: text.map((_, i) => ({ unit: i, chapter: i })) };
    expect(plausiblePace(squeezed, text, byCount, 11_000)).toBe(false);
    const a = alignUnitsToChapters(squeezed, text, 11_000);
    expect(a.method).toBe('none');
    // So half-way through the text is half-way through the book, not 15 seconds into the audiobook.
    expect(mToT(syncMapFromAlignment(squeezed, text, a, 11_000), 5500)).toBeCloseTo(0.5, 9);
    expect(mToT(syncMapFromAlignment(squeezed, text, byCount, 11_000), 5500)).toBeLessThan(0.001);
  });

  it('refuses many short stretches squeezed together, each too short to judge on either side', () => {
    // A hundred chapters in the book's first 0.1 %, then one for all the rest; a hundred and one even units.
    const chapters = [...Array.from({ length: 100 }, (_, i) => ({ title: `Section ${i + 1}`, t: i / 100_000 })), { title: 'Section 101', t: 0.001 }];
    const units = Array.from({ length: 101 }, (_, i) => ({ title: `Section ${i + 1}`, m: i * 100 }));
    expect(alignUnitsToChapters(chapters, units, 10_100).method).toBe('none');
  });

  it('keeps a book of one chapter, or of two with a short first one, aligned', () => {
    const one = alignUnitsToChapters([{ title: 'The Whole Story', t: 0 }], [{ title: 'The Whole Story', m: 0 }], 3600_000);
    expect(one).toEqual({ method: 'count', pairs: [{ unit: 0, chapter: 0 }] });
    // A one-page foreword (1 % of the text, a minute of an hour's reading), then the story: too
    // short on both sides to be judged, it leaves one stretch, a straight line, which is kept.
    const two = alignUnitsToChapters(
      [
        { title: 'Foreword', t: 0 },
        { title: 'The Story', t: 0.01 },
      ],
      [
        { title: 'Foreword', m: 0 },
        { title: 'The Story', m: 54_000 },
      ],
      3600_000,
    );
    expect(two.method).toBe('count');
    // Two chapters of about the same length, as ever.
    const halves = alignUnitsToChapters(
      [
        { title: 'Part 1', t: 0 },
        { title: 'Part 2', t: 0.5 },
      ],
      [
        { title: 'Part 1', m: 0 },
        { title: 'Part 2', m: 1_700_000 },
      ],
      3600_000,
    );
    expect(halves.method).toBe('count');
  });

  it('leaves be an intro before the first matched chapter, a fifth of the audiobook though it is', () => {
    // An intro track of a fifth of the audiobook, then three chapters read evenly.
    const chapters = [
      { title: 'Chapter 1', t: 0 },
      { title: 'Chapter 2', t: 1 / 3 },
      { title: 'Chapter 3', t: 2 / 3 },
    ];
    const tracks = [
      { title: 'Introduction', m: 0 },
      { title: 'Chapter 1', m: 2000 },
      { title: 'Chapter 2', m: 4667 },
      { title: 'Chapter 3', m: 7333 },
    ];
    expect(alignUnitsToChapters(chapters, tracks, 10_000)).toMatchObject({ method: 'number', pairs: [{ unit: 1 }, { unit: 2 }, { unit: 3 }] });
  });

  it('matches thousands of units by number in time that grows with their count, not its square', () => {
    const chapters = Array.from({ length: MAX_EDITION_UNITS }, (_, i) => ({ title: `Chapter ${i + 1}`, t: i / MAX_EDITION_UNITS }));
    // Fifty times the units an edition keeps, none numbered as a chapter is: each used to look through all of them.
    const units = Array.from({ length: 50 * MAX_EDITION_UNITS }, (_, i) => ({ title: 'Track 9999', m: i }));
    let started = performance.now();
    expect(alignUnitsToChapters(chapters, units, units.length).method).toBe('none');
    expect(performance.now() - started).toBeLessThan(2000);
    // And numbered ones still pair, all of them.
    const numbered = chapters.map((c, i) => ({ title: c.title, m: i * 100 }));
    started = performance.now();
    const a = alignUnitsToChapters(chapters, [{ title: 'Introduction', m: 0 }, ...numbered.map((u) => ({ ...u, m: u.m + 50 }))], MAX_EDITION_UNITS * 100 + 50);
    expect(a.method).toBe('number');
    expect(a.pairs).toHaveLength(MAX_EDITION_UNITS);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it(`matches by title only up to ${MAX_TITLE_MATCH_CELLS} unit and chapter pairs`, () => {
    // Titles without numbers, in which only the titles can tell the units' chapters.
    const word = (i: number) => `${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}x`;
    const chapters = Array.from({ length: 200 }, (_, i) => ({ title: `The Tale of ${word(i)}`, t: i / 200 }));
    const units = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `The Tale of ${word(i)}`, m: i * 100 }));
    // One unit fewer than the chapters (so not paired by count): within the bound, matched by title.
    expect(199 * 200).toBeLessThanOrEqual(MAX_TITLE_MATCH_CELLS);
    expect(alignUnitsToChapters(chapters, units(199), 199 * 100)).toMatchObject({ method: 'title' });
    // One more than the chapters: past it, not tried.
    expect(201 * 200).toBeGreaterThan(MAX_TITLE_MATCH_CELLS);
    expect(alignUnitsToChapters(chapters, units(201), 201 * 100).method).toBe('none');
  });
});

/**
 * The Gutenberg Alice (fixtures/books/alice-gutenberg-11.epub) as a book's reference: the entries
 * of its contents inside its story (characters 906 to 146,070), title page and contents included,
 * at the character each starts at.
 */
const STORY = { start: 906, end: 146_070 };
const realAlice = (
  [
    ['Alice’s Adventures in Wonderland', 910],
    ['THE MILLENNIUM FULCRUM EDITION 3.0', 960],
    ['Contents', 996],
    ...aliceChapters.map((c, i): [string, number] => [c.title, [1448, 12_997, 23_965, 33_562, 47_445, 59_470, 73_351, 86_116, 99_832, 112_520, 123_966, 134_398][i]!]),
  ] as const
).map(([title, m]) => ({ title, t: (m - STORY.start) / (STORY.end - STORY.start) }));
/** CHAPTER I and on: entries 3 to 14. */
const chapterAt = (k: number) => k + 2;
const startsOf = (durations: readonly number[]) => durations.map((_, k) => durations.slice(0, k).reduce((a, b) => a + b, 0));
/** The LibriVox recording's twelve tracks, one a chapter, as measured: 2 h 59 min in all. */
const LIBRIVOX_MS = [640_584, 735_765, 1_064_016, 1_192_960, 809_169, 775_811, 1_046_352, 799_032, 908_016, 1_368_360, 619_872, 772_440];
const LIBRIVOX_TOTAL = LIBRIVOX_MS.reduce((a, b) => a + b, 0);
/** That recording joined and cut into `n` parts of the same length, titled by their numbers. */
const cut = (n: number, title: (k: number) => string = (k) => String(k).padStart(2, '0')) =>
  Array.from({ length: n }, (_, i) => ({ title: title(i + 1), m: Math.round((i * LIBRIVOX_TOTAL) / n) }));

describe('a recording cut into numbered parts (D73)', () => {
  it('still lines the LibriVox Alice and the tiny fixture up by chapter, track k at CHAPTER k, to the end of the book', () => {
    const tiny = [4075, 5068, 6060, 3056, 4075, 5068, 6060, 3056, 4075, 5068, 6060, 3056];
    for (const durations of [LIBRIVOX_MS, tiny]) {
      const total = durations.reduce((a, b) => a + b, 0);
      const tracks = startsOf(durations).map((m, k) => ({ title: `Chapter ${k + 1}`, m }));
      const a = alignUnitsToChapters(realAlice, tracks, total);
      expect(a).toEqual({ method: 'number', pairs: tracks.map((_, k) => ({ unit: k, chapter: chapterAt(k + 1) })) });
      expect(plausibleSpan(realAlice, tracks, a)).toBe(true);
      expect(mToT(syncMapFromAlignment(realAlice, tracks, a, total), total)).toBe(1);
    }
  });

  it('never takes a part, a track, a disc or a volume for the chapter of its number', () => {
    for (const word of ['Part', 'Track', 'Disc', 'Volume']) {
      const parts = cut(8, (k) => `Alice - ${word} ${k}`);
      expect(alignUnitsToChapters(realAlice, parts, LIBRIVOX_TOTAL).method, word).toBe('none');
      // Not even before the extent is known: these numbers are not chapters'.
      expect(alignUnitsToChapters(realAlice, parts).method, word).toBe('none');
    }
    // A recording's part does start the book's part of the same number.
    const book = [
      { title: 'PART ONE', t: 0 },
      { title: 'PART TWO', t: 0.4 },
      { title: 'PART THREE', t: 0.7 },
    ];
    const recording = [
      { title: 'Opening credits', m: 0 },
      { title: 'Part 1', m: 60_000 },
      { title: 'Part 2', m: 4_000_000 },
      { title: 'Part 3', m: 7_000_000 },
    ];
    expect(alignUnitsToChapters(book, recording, 10_000_000)).toEqual({ method: 'number', pairs: [1, 2, 3].map((unit) => ({ unit, chapter: unit - 1 })) });
  });

  it('refuses eight parts numbered like chapters, though each is about as long as its chapter: the recording would end at chapter IX', () => {
    const parts = cut(8);
    // By their numbers, and part by part by their pace, they are chapters I to VIII.
    const byNumber = alignUnitsToChapters(realAlice, parts);
    expect(byNumber).toEqual({ method: 'number', pairs: parts.map((_, k) => ({ unit: k, chapter: chapterAt(k + 1) })) });
    expect(plausiblePace(realAlice, parts, byNumber, LIBRIVOX_TOTAL)).toBe(true);
    expect(mToT(syncMapFromAlignment(realAlice, parts, byNumber, LIBRIVOX_TOTAL), LIBRIVOX_TOTAL)).toBeCloseTo(0.6815, 4);
    // But all of the recording would sit on the chapters they match, 0.68 of the book.
    expect(plausibleSpan(realAlice, parts, byNumber)).toBe(false);
    const a = alignUnitsToChapters(realAlice, parts, LIBRIVOX_TOTAL);
    expect(a).toEqual({ method: 'none', pairs: [] });
    // So it is a straight line: ten minutes into the eighth part (the trial: chapter XII has begun)
    // is 93 % of the way through the book, not chapter VIII at 63 %.
    const trial = parts[7]!.m + 600_000;
    const t = mToT(syncMapFromAlignment(realAlice, parts, a, LIBRIVOX_TOTAL), trial);
    expect(t).toBeCloseTo(trial / LIBRIVOX_TOTAL, 12);
    expect(t).toBeGreaterThan(realAlice[chapterAt(12)]!.t);
  });

  it('refuses the recording in two halves, chapters I to VI and VII to XII: three hours on 15 % of the book', () => {
    const half = LIBRIVOX_MS.slice(0, 6).reduce((a, b) => a + b, 0);
    for (const names of [['Part 1', 'Part 2'], ['1', '2']]) {
      const halves = names.map((title, k) => ({ title, m: k * half }));
      expect(alignUnitsToChapters(realAlice, halves, LIBRIVOX_TOTAL).method, names[0]).toBe('none');
    }
    const bare = [
      { title: '1', m: 0 },
      { title: '2', m: half },
    ];
    const byNumber = alignUnitsToChapters(realAlice, bare);
    expect(byNumber.pairs).toEqual([1, 2].map((k, unit) => ({ unit, chapter: chapterAt(k) })));
    expect(plausiblePace(realAlice, bare, byNumber, LIBRIVOX_TOTAL)).toBe(true);
    expect(plausibleSpan(realAlice, bare, byNumber)).toBe(false);
  });

  it('refuses parts whose numbers run on past the chapters they matched (thirteen parts of twelve chapters)', () => {
    const parts = cut(13);
    const byNumber = alignUnitsToChapters(realAlice, parts);
    expect(byNumber.pairs).toHaveLength(12);
    // Its pace and span would pass: the thirteenth part would be heard inside chapter XII, the rest a part too far on.
    expect(plausiblePace(realAlice, parts, byNumber, LIBRIVOX_TOTAL)).toBe(true);
    expect(plausibleSpan(realAlice, parts, byNumber)).toBe(true);
    expect(alignUnitsToChapters(realAlice, parts, LIBRIVOX_TOTAL).method).toBe('none');
    // Nine and ten parts stop short of nine tenths of the book; eleven do not, and stay matched.
    expect([9, 10, 11].map((n) => alignUnitsToChapters(realAlice, cut(n), LIBRIVOX_TOTAL).method)).toEqual(['none', 'none', 'number']);
  });

  it(`leaves room for an ending the recording has no file for, down to ${MIN_MATCHED_SPAN} of the book, and does not judge what comes before its first chapter`, () => {
    // Twelve chapters read one a track, and an afterword that is not read.
    const book = (afterword: number, preface = 0) => [
      ...(preface > 0 ? [{ title: 'Preface', t: 0 }] : []),
      ...Array.from({ length: 12 }, (_, i) => ({ title: `Chapter ${i + 1}`, t: preface + (i * (afterword - preface)) / 12 })),
      { title: 'Afterword', t: afterword },
    ];
    const tracks = Array.from({ length: 12 }, (_, i) => ({ title: `Chapter ${i + 1}`, m: i * 600_000 }));
    expect(alignUnitsToChapters(book(0.95), tracks, 7_200_000).method).toBe('number');
    expect(alignUnitsToChapters(book(0.9), tracks, 7_200_000).method).toBe('number');
    expect(alignUnitsToChapters(book(0.85), tracks, 7_200_000).method).toBe('none');
    // A preface the recording skips: the match runs from chapter 1 at 0.2 to the afterword at 0.95.
    expect(alignUnitsToChapters(book(0.95, 0.2), tracks, 7_200_000).method).toBe('number');
  });

  it('holds a file of two chapters to the end of the second', () => {
    const tracks = Array.from({ length: 6 }, (_, i) => ({ title: `Chapters ${2 * i + 1}-${2 * i + 2}`, m: i * 1_200_000 }));
    const a = alignUnitsToChapters(aliceChapters, tracks, 6 * 1_200_000);
    expect(a.method).toBe('number');
    // The last file holds chapters XI and XII: half-way through it chapter XII begins, and its end is the book's.
    const map = syncMapFromAlignment(aliceChapters, tracks, a, 6 * 1_200_000);
    expect(mToT(map, 5.5 * 1_200_000)).toBeCloseTo(11 / 12, 12);
    expect(plausibleSpan(aliceChapters, tracks, a)).toBe(true);
  });

  it('refuses twelve parts of the recording called parts, now that twelve units match the story’s twelve chapters in order', () => {
    // Twelve is as many as the chapters after the front matter (D74), but a part is not a chapter.
    expect(alignUnitsToChapters(realAlice, cut(12, (k) => `Alice - Part ${k}`), LIBRIVOX_TOTAL).method).toBe('none');
    expect(alignUnitsToChapters(realAlice, cut(12, (k) => `Disc ${k}`), LIBRIVOX_TOTAL).method).toBe('none');
    // Nor in a book that has nothing but its chapters.
    expect(alignUnitsToChapters(aliceChapters, librivoxTracks.map((u, i) => ({ ...u, title: `Part ${i + 1}` })), 12 * 600_000).method).toBe('none');
  });

  it('pairs files numbered "01" in order with a book’s own divisions, its books or its parts', () => {
    // Paradise Lost: a title page, then BOOK I to BOOK XII; a recording of twelve files, one a book.
    for (const word of ['BOOK', 'PART']) {
      const book = [{ title: 'Paradise Lost', t: 0 }, ...Array.from({ length: 12 }, (_, i) => ({ title: `${word} ${intToRoman(i + 1).toUpperCase()}`, t: 0.002 + (i * 0.998) / 12 }))];
      const files = Array.from({ length: 12 }, (_, i) => ({ title: String(i + 1).padStart(2, '0'), m: i * 3_000_000 }));
      expect(frontMatterCount(book), word).toBe(1);
      expect(alignUnitsToChapters(book, files, 36_000_000), word).toEqual({ method: 'count', pairs: files.map((_, i) => ({ unit: i, chapter: i + 1 })) });
    }
  });
});

/** The LibriVox Alice's twelve chapters, as files named or tagged one of the usual ways: [tag, file name] of chapter k. */
const NAMINGS: Record<string, (k: number, name: string) => [string | undefined, string]> = {
  '01.mp3': (k) => [undefined, `${String(k).padStart(2, '0')}.mp3`],
  '1.mp3': (k) => [undefined, `${k}.mp3`],
  'Track 01.mp3': (k) => [undefined, `Track ${String(k).padStart(2, '0')}.mp3`],
  '"01" tag only': (k) => [String(k).padStart(2, '0'), `alice_in_wonderland_${k}.mp3`],
  'alice_01_carroll_64kb.mp3': (k) => [undefined, `alice_${String(k).padStart(2, '0')}_carroll_64kb.mp3`],
  '"Chapter 01"': (k) => [`Chapter ${String(k).padStart(2, '0')}`, `track${k}.mp3`],
  '01 - Down the Rabbit-Hole.mp3': (k, name) => [undefined, `${String(k).padStart(2, '0')} - ${name}.mp3`],
  '"CHAPTER I"': (k) => [`CHAPTER ${intToRoman(k).toUpperCase()}`, `${k}.mp3`],
  'tagged title only': (k, name) => [name, `audio${k}.mp3`],
};

describe('a folder of chapter files, named the usual ways, against the book’s chapters with its front matter (D74)', () => {
  /** "CHAPTER VII. A Mad Tea-Party" → "A Mad Tea-Party". */
  const nameOf = (k: number) => aliceChapters[k - 1]!.title.replace(/^CHAPTER [IVXL]+\.\s*/, '');
  const tracksNamed = (naming: (k: number, name: string) => [string | undefined, string]) =>
    startsOf(LIBRIVOX_MS).map((m, i) => ({ title: prettifyTrackTitle(...naming(i + 1, nameOf(i + 1))), m }));

  it('finds the title page, the edition’s note and the contents before CHAPTER I, and nothing in a book without them', () => {
    expect(realAlice.slice(0, 4).map((c) => c.title)).toEqual(['Alice’s Adventures in Wonderland', 'THE MILLENNIUM FULCRUM EDITION 3.0', 'Contents', 'CHAPTER I. Down the Rabbit-Hole']);
    expect(frontMatterCount(realAlice)).toBe(3);
    expect(frontMatterCount(aliceChapters)).toBe(0);
    // Chapters known by their numbers alone (an audiobook first): "01" is chapter 1.
    expect(frontMatterCount(aliceChapters.map((c, i) => ({ ...c, title: String(i + 1).padStart(2, '0') })))).toBe(0);
  });

  for (const [naming, files] of Object.entries(NAMINGS)) {
    it(`lines up twelve files named like ${naming} with CHAPTER I to XII`, () => {
      const tracks = tracksNamed(files);
      const a = alignUnitsToChapters(realAlice, tracks, LIBRIVOX_TOTAL);
      expect(a.pairs).toEqual(tracks.map((_, k) => ({ unit: k, chapter: chapterAt(k + 1) })));
      // Twenty seconds into the seventh file is CHAPTER VII, not chapter VI at 48 % (a straight line).
      const map = syncMapFromAlignment(realAlice, tracks, a, LIBRIVOX_TOTAL);
      const t = mToT(map, tracks[6]!.m + 20_000);
      expect(t).toBeGreaterThan(realAlice[chapterAt(7)]!.t);
      expect(t).toBeLessThan(realAlice[chapterAt(7)]!.t + 0.002);
    });
  }

  it('pairs them by number, by title or, files called tracks, in order after the front matter', () => {
    const methods = Object.fromEntries(Object.entries(NAMINGS).map(([naming, files]) => [naming, alignUnitsToChapters(realAlice, tracksNamed(files), LIBRIVOX_TOTAL).method]));
    expect(methods).toEqual({
      '01.mp3': 'number',
      '1.mp3': 'number',
      'Track 01.mp3': 'count',
      '"01" tag only': 'number',
      'alice_01_carroll_64kb.mp3': 'number',
      '"Chapter 01"': 'number',
      '01 - Down the Rabbit-Hole.mp3': 'title',
      '"CHAPTER I"': 'number',
      'tagged title only': 'title',
    });
  });

  it('pairs an intro file, or a missing last chapter, by the numbers the files are named by', () => {
    const tracks = tracksNamed(NAMINGS['01.mp3']!);
    // "00.mp3", an introduction of a minute, before the twelve.
    const withIntro = [{ title: prettifyTrackTitle(undefined, '00.mp3'), m: 0 }, ...tracks.map((u) => ({ ...u, m: u.m + 60_000 }))];
    expect(alignUnitsToChapters(realAlice, withIntro, LIBRIVOX_TOTAL + 60_000).pairs).toEqual(tracks.map((_, k) => ({ unit: k + 1, chapter: chapterAt(k + 1) })));
    // Chapter XII's file left out: eleven files on chapters I to XI, which reach 0.92 of the book.
    const eleven = tracks.slice(0, 11);
    expect(alignUnitsToChapters(realAlice, eleven, LIBRIVOX_TOTAL - LIBRIVOX_MS[11]!).pairs).toHaveLength(11);
  });

  it('still refuses numbered parts of the whole recording: eight or two of them, as files of numbers or of parts', () => {
    for (const n of [8, 2]) {
      expect(alignUnitsToChapters(realAlice, cut(n, (k) => prettifyTrackTitle(undefined, `${String(k).padStart(2, '0')}.mp3`)), LIBRIVOX_TOTAL).method, `${n} numbers`).toBe('none');
      expect(alignUnitsToChapters(realAlice, cut(n, (k) => `Alice - Part ${k}`), LIBRIVOX_TOTAL).method, `${n} parts`).toBe('none');
    }
  });

  it('does not pair in order past what may be front matter: a book’s chapters from its first numbered one, its first tenth at most', () => {
    // Thirteen files called tracks, a minute's introduction and the twelve chapters: the
    // introduction starts at the contents, and each chapter's file at its chapter.
    const durations = [60_000, ...LIBRIVOX_MS];
    const thirteen = startsOf(durations).map((m, k) => ({ title: `Track ${String(k + 1).padStart(2, '0')}`, m }));
    const a = alignUnitsToChapters(realAlice, thirteen, LIBRIVOX_TOTAL + 60_000);
    expect(a).toEqual({ method: 'count', pairs: thirteen.map((_, k) => ({ unit: k, chapter: k + 2 })) });
    expect(realAlice[2]!.title).toBe('Contents');
    // Eleven for fifteen: four left out, one of them CHAPTER I, which is story.
    expect(alignUnitsToChapters(realAlice, cut(11, (k) => `Track ${k}`), LIBRIVOX_TOTAL).method).toBe('none');
    // A book whose first numbered chapter starts past its first tenth has no front matter before it but its short pages.
    const late = [
      { title: 'Title Page', t: 0 },
      { title: 'Introduction', t: 0.005 },
      ...Array.from({ length: 6 }, (_, i) => ({ title: `Chapter ${i + 1}`, t: FRONT_MATTER_MAX + 0.05 + (i * (0.95 - FRONT_MATTER_MAX)) / 6 })),
    ];
    expect(frontMatterCount(late)).toBe(1);
  });
});

describe('a recording that counts its own files, against chapters numbered and named (FR164)', () => {
  // The Time Machine (Gutenberg #35): its title page and contents, sixteen chapters a Roman numeral
  // and a name each, and its epilogue, where its contents put them; and the LibriVox recording's
  // thirteen files, tagged by the recording's own count ("02 - Chapter II" holds the book's III).
  const story = { start: 815, end: 181_133 };
  const titles = ['The Time Machine', 'CONTENTS', 'I. Introduction', 'II. The Machine', 'III. The Time Traveller Returns', 'IV. Time Travelling', 'V. In the Golden Age', 'VI. The Sunset of Mankind', 'VII. A Sudden Shock', 'VIII. Explanation', 'IX. The Morlocks', 'X. When Night Came', 'XI. The Palace of Green Porcelain', 'XII. In the Darkness', 'XIII. The Trap of the White Sphinx', 'XIV. The Further Vision', 'XV. The Time Traveller’s Return', 'XVI. After the Story', 'Epilogue'];
  const at = [821, 877, 1375, 11283, 18863, 30013, 41705, 51058, 63675, 76201, 99622, 111453, 125242, 138958, 152972, 158960, 169397, 172073, 179589];
  const chapters = titles.map((title, i) => ({ title, t: (at[i]! - story.start) / (story.end - story.start) }));
  const durations = [1_290_580, 839_837, 926_929, 1_670_792, 2_579_148, 866_952, 1_100_173, 1_097_535, 1_049_025, 463_856, 803_736, 800_522, 159_922];
  const total = durations.reduce((a, b) => a + b, 0);
  const tags = ['01 - Chapter I', '02 - Chapter II', '03 - Chapter III', '04 - Chapter 4', '05 - Chapter 5', '06 - Chapter 6', '07 - Chapter 7', '08 - Chapter 8', '09 - Chapter 09', '10 - Chapter 10', '11 - Chapter 11', '12 - Chapter 12', '13 - Epilogue'];
  const units = (named: (tag: string, i: number) => string) => tags.map((tag, i) => ({ title: named(tag, i), m: durations.slice(0, i).reduce((a, b) => a + b, 0) }));

  it('matches none of its files to the chapters, as the tags or as the upload form tidies them: their numbers are not the book’s', () => {
    for (const [how, named] of [
      ['as tagged', (tag: string) => tag],
      ['tidied', (tag: string, i: number) => prettifyTrackTitle(tag, `timemachine_${String(i + 1).padStart(2, '0')}_wells_64kb.mp3`)],
      ['numbered only', (tag: string) => tag.replace(/^\d+ - /, '')],
    ] as const) {
      expect(alignUnitsToChapters(chapters, units(named), total), how).toEqual({ method: 'none', pairs: [] });
    }
    // A numeral the two titles share is half of "Chapter II" and of "II. The Machine": a title match
    // would take it (the check that this can fail).
    expect(titleSimilarity('Chapter II', 'II. The Machine')).toBeGreaterThanOrEqual(0.5);
  });

  it('still matches names, numbered or not', () => {
    // Its files named after the chapters, each heard as long as its chapter is, the epilogue inside the last.
    const named = titles.slice(2, 18).map((title, i) => ({ title: `${String(i + 1).padStart(2, '0')} - ${title.replace(/^[IVX]+\. /, '')}`, m: Math.round((chapters[i + 2]!.t - chapters[2]!.t) * total) }));
    expect(alignUnitsToChapters(chapters, named, total).method).toBe('title');
  });
});

describe('frontMatterCount and chaptersInOrder (D74)', () => {
  it('in a book none of whose chapters is numbered, counts the short ones it opens with', () => {
    const titled = [
      { title: 'Title Page', t: 0 },
      { title: 'Contents', t: 0.001 },
      { title: 'Down the Rabbit-Hole', t: 0.004 },
      { title: 'The Pool of Tears', t: 0.35 },
      { title: 'A Caucus-Race', t: 0.7 },
    ];
    expect(frontMatterCount(titled)).toBe(2);
    // A one-page foreword and the story: the foreword.
    expect(frontMatterCount([{ title: 'Foreword', t: 0 }, { title: 'The Story', t: 0.01 }])).toBe(1);
    // Chapters about as long as each other: none.
    expect(frontMatterCount(['A', 'B', 'C'].map((title, i) => ({ title, t: i / 3 })))).toBe(0);
  });

  it('takes a year for no chapter’s number, and an audiobook’s opening credits for front matter', () => {
    const book = [
      { title: 'Cover', t: 0 },
      { title: 'Copyright 2015', t: 0.001 },
      { title: 'Dedication', t: 0.003 },
      ...Array.from({ length: 10 }, (_, i) => ({ title: `Chapter ${i + 1}`, t: 0.004 + i * 0.0996 })),
    ];
    expect(frontMatterCount(book)).toBe(3);
    const heard = [{ title: 'Opening Credits', t: 0 }, ...Array.from({ length: 12 }, (_, i) => ({ title: `Chapter ${i + 1}`, t: 0.003 + (i * 0.997) / 12 }))];
    expect(frontMatterCount(heard)).toBe(1);
  });

  it('offers the owner the units in order, from where the counts allow', () => {
    expect(chaptersInOrder(realAlice, 12)).toEqual(Array.from({ length: 12 }, (_, k) => chapterAt(k + 1)));
    expect(chaptersInOrder(realAlice, 13)).toEqual(Array.from({ length: 13 }, (_, k) => k + 2));
    expect(chaptersInOrder(realAlice, 15)).toEqual(Array.from({ length: 15 }, (_, k) => k));
    for (const n of [0, 8, 11, 16]) expect(chaptersInOrder(realAlice, n), String(n)).toBeNull();
  });
});

describe('syncMapFromAlignment', () => {
  it('ties each track start to its chapter start and the end to the end of the book', () => {
    const total = 12 * 600_000;
    const a = alignUnitsToChapters(aliceChapters, librivoxTracks);
    const map = syncMapFromAlignment(aliceChapters, librivoxTracks, a, total);
    expect(mToT(map, 0)).toBe(0);
    expect(mToT(map, 600_000 * 5)).toBeCloseTo(5 / 12, 12);
    expect(mToT(map, 600_000 * 5 + 300_000)).toBeCloseTo(5.5 / 12, 12);
    expect(mToT(map, total)).toBe(1);
  });

  it('keeps an intro track at the first chapter start', () => {
    const chapters = [{ title: 'Chapter 1', t: 0.2 }, { title: 'Chapter 2', t: 0.6 }];
    const units = [{ title: 'Intro', m: 0 }, { title: 'Chapter 1', m: 100 }, { title: 'Chapter 2', m: 300 }];
    const map = syncMapFromAlignment(chapters, units, { method: 'number', pairs: [{ unit: 1, chapter: 0 }, { unit: 2, chapter: 1 }] }, 500);
    expect(mToT(map, 50)).toBe(0.2);
    expect(mToT(map, 100)).toBe(0.2);
    expect(mToT(map, 300)).toBe(0.6);
    expect(mToT(map, 500)).toBe(1);
  });

  it('ends at the next chapter when the edition stops early', () => {
    const units = librivoxTracks.slice(0, 6);
    const a = alignUnitsToChapters(aliceChapters, units);
    const map = syncMapFromAlignment(aliceChapters, units, a, 6 * 600_000);
    expect(mToT(map, 6 * 600_000)).toBeCloseTo(6 / 12, 12);
  });

  it('is linear when there is no alignment', () => {
    const map = syncMapFromAlignment(aliceChapters, librivoxTracks, { method: 'none', pairs: [] }, 1000);
    expect(mToT(map, 500)).toBeCloseTo(0.5, 12);
    expect(syncMapFromAlignment([], [], { method: 'none', pairs: [] }, 0).points).toHaveLength(2);
  });

  it('honours a story range inside the edition (an EPUB with a licence appendix)', () => {
    // Twelve chapters of 1000 characters after 500 characters of front matter, then a licence.
    const units = librivoxTracks.map((_, i) => ({ title: `Chapter ${i + 1}`, m: 500 + i * 1000 }));
    const a = alignUnitsToChapters(aliceChapters, units);
    const map = syncMapFromAlignment(aliceChapters, units, a, { start: 500, end: 12_500 });
    expect(mToT(map, 500)).toBe(0);
    expect(mToT(map, 6500)).toBeCloseTo(0.5, 12);
    expect(mToT(map, 12_500)).toBe(1);
    // The licence clamps to the end of the book instead of squashing chapter XII.
    expect(mToT(map, 15_000)).toBe(1);
    expect(mToT(map, 12_000)).toBeCloseTo(11.5 / 12, 12);
  });
});

describe('manualAlignment', () => {
  it('keeps valid increasing assignments and drops the rest', () => {
    const a = manualAlignment(aliceChapters, librivoxTracks.slice(0, 5), [null, 0, 0, 3, 99]);
    expect(a).toEqual({ method: 'manual', pairs: [{ unit: 1, chapter: 0 }, { unit: 3, chapter: 3 }] });
    expect(manualAlignment(aliceChapters, librivoxTracks, []).method).toBe('none');
  });
});
