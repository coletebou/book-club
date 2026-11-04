/** Text helpers for titles, chapter names and filenames. */

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural order for filenames: "track 2" before "track 10", case-insensitive. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'and', 'to', 'on', 'at', 'by', 'for', 'or', 'with']);

/** Lowercase, strip accents, possessives and punctuation, collapse whitespace. */
export function normalizeTitle(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]s\b/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(input: string): Set<string> {
  return new Set(
    normalizeTitle(input)
      .split(' ')
      .filter((w) => w.length > 0 && !STOPWORDS.has(w)),
  );
}

/**
 * Similarity of two titles in [0, 1]: overlap of meaningful words relative to the shorter
 * title, damped when either side has a single word. "Alice in Wonderland" and "Alice's Adventures
 * in Wonderland" score 1; unrelated titles score 0.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  const overlap = shared / Math.min(ta.size, tb.size);
  const dice = (2 * shared) / (ta.size + tb.size);
  const single = Math.min(ta.size, tb.size) === 1;
  return single ? Math.min(overlap, dice) : Math.max(dice, overlap * 0.95);
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

export function romanToInt(input: string): number | null {
  const s = input.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(s)) return null;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]!]!;
    const next = i + 1 < s.length ? ROMAN[s[i + 1]!]! : 0;
    total += v < next ? -v : v;
  }
  // Reject non-canonical numerals such as "iiii" or "vx".
  return intToRoman(total) === s ? total : null;
}

export function intToRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  let rest = n;
  for (const [v, s] of table) {
    while (rest >= v) {
      out += s;
      rest -= v;
    }
  }
  return out;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
  // Ordinals, as older books number their books and chapters ("Book the First", "Chapter the Third").
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
};

/**
 * A number written in words: "Three", or tens and units ("TWENTY-ONE", "forty seven": Little
 * Women's chapters 21 to 47, which read as their tens alone before).
 */
function wordNumber(word: string, units?: string): number | null {
  const n = WORD_NUMBERS[word.toLowerCase()];
  if (n === undefined) return null;
  const u = units === undefined ? undefined : WORD_NUMBERS[units.toLowerCase()];
  return n >= 20 && n % 10 === 0 && u !== undefined && u < 10 ? n + u : n;
}

/**
 * Words a book or a recording numbers its chapters with: "Chapter", in its abbreviations and a few
 * languages, and what some books call theirs: A Christmas Carol's staves, the cantos of a poem.
 */
const CHAPTER_WORD = String.raw`chapters?|chapt|chap|ch|kapitel|chapitre|capitulo|staves?|cantos?`;
/** The units word after tens ("-ONE" of "TWENTY-ONE"): only a number word, never the next word of a title. */
const UNITS = String.raw`(?:[-\s](one|two|three|four|five|six|seven|eight|nine)\b)?`;
const CHAPTER_KEYWORD = new RegExp(String.raw`\b(?:${CHAPTER_WORD}|book|part)\.?\s*[-–:#]?\s*(?:the\s+)?([0-9]+|[ivxlcdm]+\b|[a-z]+)${UNITS}`, 'i');

/**
 * The chapter number a title or filename names, if any: "CHAPTER XII. Alice's Evidence" → 12,
 * "wonderland_ch_01" → 1, "Chapter Three" → 3, "07 - The Tea Party" → 7.
 */
export function chapterNumber(input: string): number | null {
  const s = input.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ');
  // A track holding several chapters ("Chapters 1-2", "Ch 3 & 4") starts at the first of them.
  const range = /\b(?:chapters?|chaps?|ch)\.?\s*(\d+)\s*(?:-|–|to|and|&)\s*\d+/i.exec(s);
  if (range) return Number.parseInt(range[1]!, 10);
  const keyword = CHAPTER_KEYWORD.exec(s);
  if (keyword) {
    const token = keyword[1]!;
    if (/^[0-9]+$/.test(token)) return Number.parseInt(token, 10);
    const roman = romanToInt(token);
    if (roman !== null) return roman;
    const word = wordNumber(token, keyword[2]);
    if (word !== null) return word;
  }
  const leading = /^\s*(\d{1,4})\b/.exec(s);
  if (leading) return Number.parseInt(leading[1]!, 10);
  const trailing = /\b(\d{1,4})\s*$/.exec(s);
  if (trailing) return Number.parseInt(trailing[1]!, 10);
  return null;
}

/** What a number in a title or filename counts. A number with no word for it counts chapters. */
export type Counted = 'chapter' | 'part' | 'track' | 'disc' | 'volume' | 'book' | 'side';

/**
 * Words that number something a chapter is not: a part (the hour-long files a library lends, "Part
 * 3"), a CD's track or the disc itself, a volume or a book of a long work, a tape's side. A title
 * they number is that, never a chapter (D73).
 */
const DIVISIONS: Readonly<Record<string, Exclude<Counted, 'chapter'>>> = {
  part: 'part', parts: 'part', pt: 'part', teil: 'part', partie: 'part', parte: 'part',
  track: 'track', tracks: 'track', trk: 'track',
  disc: 'disc', discs: 'disc', disk: 'disc', disks: 'disc', cd: 'disc', cds: 'disc', tape: 'disc', cassette: 'disc',
  volume: 'volume', volumes: 'volume', vol: 'volume', tome: 'volume',
  book: 'book', books: 'book', bk: 'book', libro: 'book', livre: 'book',
  side: 'side', sides: 'side',
};

/** A counting word, then its number: digits, a Roman numeral or words ("Part Three", "CHAPTER TWENTY-ONE", "Book the First"). */
const COUNT = String.raw`\.?\s*[-–:#]?\s*(?:the\s+)?([0-9]+|[ivxlcdm]+\b|[a-z]+)${UNITS}`;
const CHAPTER_COUNT = new RegExp(String.raw`\b(?:${CHAPTER_WORD})${COUNT}(?:\s*(?:-|–|to|and|&)\s*(\d+))?`, 'gi');
// Longest first, so that "Parts 2" is read as parts, not as "part" and then "s".
const DIVISION_COUNT = new RegExp(String.raw`\b(${Object.keys(DIVISIONS).sort((a, b) => b.length - a.length).join('|')})${COUNT}`, 'gi');
/** Most chapters one file says it holds ("Chapters 11-12"): more is a year or another number. */
const MAX_RANGE = 50;

function countedNumber(token: string, units?: string): number | null {
  if (/^[0-9]+$/.test(token)) return Number.parseInt(token, 10);
  return romanToInt(token) ?? wordNumber(token, units);
}

/** What a title numbers: what it counts, its number, and the last of a range ("Chapters 11-12"). */
export interface Numbering {
  readonly counts: Counted;
  readonly n: number;
  readonly through: number;
}

/**
 * What a title or filename numbers, as the chapter matching reads it: a chapter for "CHAPTER XII.
 * Alice's Evidence", "wonderland_ch_01", "07 - The Tea Party" or a recording's section number
 * between its title and its reader ("alice_03_carroll_64kb"); but "Part 3", "Alice - Part 3.mp3",
 * "Track 07", "Disc 2", "Vol. 2" or "BOOK ONE: 1805" number a part, a track, a disc, a volume or a
 * book, and their numbers are not chapters' (D73). A chapter named as well wins ("Book 2, Chapter
 * 5" numbers chapter 5). Unlike chapterNumber, which reads any number a file is ordered by.
 */
export function numberedAs(input: string): Numbering | null {
  const s = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/_+/g, ' ');
  for (const [, token, units, last] of s.matchAll(CHAPTER_COUNT)) {
    const n = countedNumber(token!, units);
    if (n === null) continue;
    const through = last === undefined ? n : Number.parseInt(last, 10);
    return { counts: 'chapter', n, through: through > n && through - n <= MAX_RANGE ? through : n };
  }
  for (const [, word, token, units] of s.matchAll(DIVISION_COUNT)) {
    const n = countedNumber(token!, units);
    if (n !== null) return { counts: DIVISIONS[word!.toLowerCase()]!, n, through: n };
  }
  // A span of years numbers nothing ("FIRST EPILOGUE: 1813 - 20": War and Peace's epilogue).
  if (/\b\d{4}\s*[-–]\s*\d{1,4}\s*$/.test(s)) return null;
  // A number alone: first or last, else the only one ("alice 03 carroll 64kb": the bit rate is no
  // number). A decimal's last digits are no number of their own ("EDITION 3.0" numbers nothing).
  const alone = [...s.matchAll(/\b(\d{1,3})\b/g)];
  const bare = /^\s*(\d{1,4})\b/.exec(s)?.[1] ?? /(?<!\d[.,])\b(\d{1,4})\s*$/.exec(s)?.[1] ?? (alone.length === 1 ? alone[0]![1] : undefined);
  if (bare === undefined) return null;
  const n = Number.parseInt(bare, 10);
  return { counts: 'chapter', n, through: n };
}

/** Strip the extension and directory from a filename. */
export function filenameStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/\.[^.]+$/, '');
}

/**
 * A numbering word and its number, or a range of them, and nothing else: "Chapter I", "Chapter
 * 09", "Chapters 1-3", "Part 3".
 */
const NUMBER_ALONE = new RegExp(String.raw`^(?:${CHAPTER_WORD}|${Object.keys(DIVISIONS).sort((a, b) => b.length - a.length).join('|')})${COUNT}(?:\s*(?:-|–|to|and|&)\s*\d+)?\s*\.?$`, 'i');

/**
 * A track's name without a track number in front of a numbered name that is all the rest of it
 * says (FR164, D115): LibriVox tags "01 - Chapter I" and "06 - Chapter 6", shown as "Chapter I"
 * and "Chapter 6". The chapter matching reads either the same (the named number wins, numberedAs).
 * Any other name is as it is: "01 - STORY OF THE DOOR" is matched by its number, and "01 - Stave
 * 1: Marley's Ghost" is LibriVox's title as it stands.
 */
export function tidyTrackTitle(title: string): string {
  const numbered = /^\s*\d{1,4}(?:\s*[-–.:)]\s*|\s+)(.+)$/.exec(title);
  const rest = numbered?.[1]?.trim();
  if (!rest) return title;
  const words = NUMBER_ALONE.exec(rest);
  return words && countedNumber(words[1]!, words[2]) !== null ? rest : title;
}

/**
 * A readable name for an audio track. Uses the tag title when it is a real title (tidied:
 * "01 - Chapter I" → "Chapter I"), otherwise the filename: "wonderland_ch_01.mp3" → "Chapter 1";
 * "03 - The Pool of Tears.mp3" → "The Pool of Tears". A file named or tagged only by its number
 * keeps it as it is written ("01.mp3" → "01"): that is a chapter's number, as LibriVox's are,
 * where "Track 1" would number a CD's track (numberedAs, D74).
 */
export function prettifyTrackTitle(tagTitle: string | undefined, filename: string): string {
  const stem = filenameStem(filename);
  const tag = tagTitle?.trim();
  const tagLooksLikeFilename = tag !== undefined && (normalizeTitle(tag) === normalizeTitle(stem) || /^[\w-]+$/.test(tag));
  if (tag && !tagLooksLikeFilename) return tidyTrackTitle(tag);
  const source = tag || stem;
  const words = source
    .replace(/[_]+/g, ' ')
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutNumber = words.replace(/^\s*\d{1,4}\s*[-–.:)]\s*/, '');
  if (withoutNumber !== words && /\p{L}{3,}/u.test(withoutNumber)) return withoutNumber.trim();
  const n = chapterNumber(words);
  if (n !== null && /\b(?:chapter|chap|ch)\b/i.test(words)) return `Chapter ${n}`;
  return words.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
}

const CHAPTER_WORD_ALONE = new RegExp(`^(?:${CHAPTER_WORD})$`);

/** A title's words beyond its number: no stop words, chapter words, numerals or numbers in words. */
function wordsBesideNumber(title: string): string[] {
  // A numeral no book's chapters run past ("mix" and "dix" are words), as numeralAlone reads one.
  const numeral = (w: string) => (romanToInt(w) ?? Infinity) <= 400;
  return [...tokens(title)].filter((w) => !CHAPTER_WORD_ALONE.test(w) && !/^\d+$/.test(w) && !numeral(w) && !Object.hasOwn(WORD_NUMBERS, w));
}

/**
 * Whether a track's name says nothing beyond the chapter it is heard as (FR157): the chapter's
 * title under the track's number ("01 - STORY OF THE DOOR" for "STORY OF THE DOOR"), the chapter's
 * number alone ("Chapter 1" for "CHAPTER I. Down the Rabbit-Hole"), or both. A track numbering a
 * range of chapters ("Chapters 01 to 03"), a part or a disc, or naming anything else, says more.
 */
export function namesChapter(trackTitle: string, chapterTitle: string): boolean {
  const bare = trackTitle.replace(/^\s*\d{1,4}\s*[-–.:)_]\s*/, '');
  const own = wordsBesideNumber(bare);
  const theirs = new Set(wordsBesideNumber(chapterTitle));
  if (own.length > 0) return own.every((w) => theirs.has(w));
  // Only a number: the chapter's own, and no range.
  const track = numberedAs(bare);
  const chapter = numberedAs(chapterTitle);
  return track !== null && chapter !== null && track.counts === 'chapter' && chapter.counts === 'chapter' && track.n === chapter.n && track.through === track.n;
}

/**
 * Whether a track's name is one chapter's number and nothing more ("Chapter 6", "06 - Chapter 6",
 * "07"): a recording's own count of its files, which says nothing the chapter heard there does not,
 * even where the two numbers differ (FR161: The Time Machine's "06 - Chapter 6" holds its chapter
 * "IX. The Morlocks"). A range, a part, a disc or words of its own say more.
 */
export function numbersOneChapter(trackTitle: string): boolean {
  const bare = trackTitle.replace(/^\s*\d{1,4}\s*[-–.:)_]\s*/, '');
  if (wordsBesideNumber(bare).length > 0) return false;
  const n = numberedAs(bare);
  return n !== null && n.counts === 'chapter' && n.through === n.n;
}

/**
 * Tidy an EPUB TOC label: collapse whitespace and line breaks, and part a chapter's word from a
 * Roman numeral run into it ("CHAPTERXXVII." in the illustrated Pride and Prejudice).
 */
export function tidyLabel(label: string): string {
  return label
    .replace(/\s+/g, ' ')
    .replace(/\b(CHAPTER|Chapter)(?=[IVXLC]+\b)/g, '$1 ')
    .trim();
}

/** The word a title names its chapter by, as labels say it ("Stave 3"), when it is one. */
const CHAPTER_NAMES: readonly [RegExp, string][] = [
  [/\b(?:chapters?|chapt|chap|ch)\b/i, 'Chapter'],
  [/\bstaves?\b/i, 'Stave'],
  [/\bcantos?\b/i, 'Canto'],
];

/** A book's own lists in its front matter: its printed contents, its list of pictures. */
const BOOK_LIST = /^(?:(?:table of )?contents|list of (?:illustrations|plates|cantos)|illustrations)\.?$/i;

/** Whether a title is one of a book's own lists ("CONTENTS.", "List of Illustrations"). */
export function isBookList(title: string): boolean {
  return BOOK_LIST.test(title.trim());
}

/** The words a part, a book or a volume is named by, as labels say them ("Part 2"). */
const DIVISION_NAMES: Partial<Readonly<Record<Counted, string>>> = { part: 'Part', book: 'Book', volume: 'Volume' };

/** Words a title in capitals keeps in lower case inside it, once calmed ("Hell or the Inferno"). */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * A title set in capitals, in title case, as a label says it (D86): "FIRST EPILOGUE" → "First
 * Epilogue", "IV. THE BOSCOMBE VALLEY MYSTERY" → "IV. The Boscombe Valley Mystery". Roman numerals
 * and initials ("U.S.") keep their capitals. A title with any small letter, or spaced out letter by
 * letter ("D R A C U L A"), is as the book sets it.
 */
export function calmCaps(title: string): string {
  if (!/\p{Lu}/u.test(title) || /\p{Ll}/u.test(title)) return title;
  const words = title.split(' ');
  if (words.length >= 3 && words.every((w) => [...w].length === 1)) return title;
  let first = true;
  return words
    .map((word) => {
      const [, before = '', core = '', after = ''] = /^(\P{L}*)(.*?)(\P{L}*)$/u.exec(word) ?? [];
      const lower = core.toLowerCase();
      const kept = (/^[IVXLC]+$/.test(core) && romanToInt(core) !== null) || /^(?:\p{Lu}\.)+\p{Lu}?$/u.test(core);
      const calm = kept ? core : !first && SMALL_WORDS.has(lower) ? lower : lower.replace(/(^|[-—–])(\p{L})/gu, (_, dash: string, c: string) => dash + c.toUpperCase());
      // After a full stop, a colon or a dash, a new title starts: "I. A Scandal in Bohemia".
      if (core) first = /[.:;!?—–]/.test(after);
      else if (/^[:;—–-]+$/.test(before)) first = true;
      return before + calm + after;
    })
    .join(' ');
}

/**
 * A short name for a chapter, for labels such as "Chapter 3 · 24%": the chapter's own number when
 * its title names one ("CHAPTER III. A Caucus-Race…" → "Chapter 3", "STAVE ONE. MARLEY’S GHOST." →
 * "Stave 1"), a part's, a book's or a volume's when its title starts by numbering one ("PART II" →
 * "Part 2", "BOOK ONE: 1805" → "Book 1"), else its title, not shouting, and if long, up to a colon
 * or a dash ("Epilogue: “AND I ONLY AM ESCAPED…”" → "Epilogue") or shortened, with no full stop at
 * its end ("FINALE." → "Finale").
 */
export function shortChapterName(title: string, max = 40): string {
  const tidy = tidyLabel(title);
  // A chapter named by its numeral alone (The Great Gatsby's "I" to "IX"): "Chapter 1".
  const alone = numeralAlone(tidy);
  if (alone !== null) return `Chapter ${alone}`;
  const named = CHAPTER_NAMES.find(([word]) => word.test(tidy));
  const numbered = numberedAs(tidy);
  if (named && numbered?.counts === 'chapter') return `${named[1]} ${numbered.n}`;
  const division = numbered && DIVISION_NAMES[numbered.counts];
  if (division && /^(?:the\s+)?(?:parts?|books?|volumes?|vol)\b/i.test(tidy)) return `${division} ${numbered.n}`;
  let name = calmCaps(tidy).replace(/(\p{L}{3})\.$/u, '$1');
  if (name.length > max) {
    const head = name.split(/\s*[:;—–]\s*|\s+-\s+/)[0]!.replace(/(\p{L}{3})\.$/u, '$1');
    // Else cut at a word's end where one is near.
    const cut = name.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    name = head.length >= 4 && head.length <= max ? head : `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return name;
}

/**
 * The number of a title that is a numeral and nothing else ("II", "XII.", "7"), or null. A Roman
 * one in capitals, and no more than any book's chapters run to: "Mix" or "DIM" is a word.
 */
function numeralAlone(title: string): number | null {
  const m = /^\s*([IVXLCDM]+|\d{1,4})\s*\.?\s*$/.exec(title);
  if (!m) return null;
  if (/^\d+$/.test(m[1]!)) return Number.parseInt(m[1]!, 10);
  const n = romanToInt(m[1]!);
  return n !== null && n <= 400 ? n : null;
}

/**
 * A chapter's title as a heading shows it: as it is, but a numeral alone is a chapter's ("II" →
 * "Chapter II"), which alone under the book's title reads as a sign, not a chapter.
 */
export function chapterHeading(title: string): string {
  const tidy = tidyLabel(title);
  return numeralAlone(tidy) !== null ? `Chapter ${tidy.replace(/\.$/, '')}` : tidy;
}

/**
 * A chapter's title without an illustration's caption printed before it in its heading: the
 * illustrated Pride and Prejudice heads chapter III with its picture's caption, so its contents say
 * "He rode a black horse. CHAPTER III.". What a title says before a chapter's word and number that
 * end it, after a sentence's end, goes; a part or a book named there stays ("Part One. Chapter 1").
 */
export function withoutCaption(title: string): string {
  const tidy = tidyLabel(title);
  const end = new RegExp(String.raw`(?:^|[.!?”"’)\]]\s+)((?:${CHAPTER_WORD})\.?\s*[-–:#]?\s*(?:[0-9]+|[ivxlcdm]+|[a-z]+(?:[-\s][a-z]+)?)\.?)$`, 'i').exec(tidy);
  if (!end || end.index === 0) return tidy;
  const before = tidy.slice(0, end.index + 1);
  const division = numberedAs(before);
  if (division && division.counts !== 'chapter') return tidy;
  return numberedAs(end[1]!)?.counts === 'chapter' ? end[1]! : tidy;
}
