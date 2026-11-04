import { type Chapter, chapterNumber, romanToInt } from '@bookclub/shared';

/**
 * A folder of tracks whose tags say nothing names its chapters after its files: "Chapter 7" (from
 * wonderland_ch_07_64kb.mp3), "Track 07", "07", "Alice in Wonderland 07". Such a name only numbers
 * the chapter; a text added later knows it as "CHAPTER VII. A Mad Tea-Party", and the book takes
 * that name. A name that says anything more is the book's own, and stays.
 */

/** What a book is called, and by whom: words a file's name repeats around its number. */
export interface BookNaming {
  readonly title: string;
  readonly author: string;
}

/** Words that say what a number counts: "Chapter 7", "Track 07", "Disc 2", "Part III", "Page 4". */
const NUMBERING = new Set([
  'chapter', 'chapters', 'chap', 'chapt', 'ch', 'track', 'tracks', 'trk', 'part', 'parts', 'pt', 'book', 'bk', 'volume', 'vol',
  'section', 'sect', 'sec', 'page', 'pages', 'pp', 'disc', 'disk', 'cd', 'side', 'episode', 'ep', 'act', 'scene', 'canto', 'letter',
  'file', 'audio', 'audiobook', 'no', 'nr', 'num', 'number', 'kapitel', 'chapitre', 'capitulo', 'teil', 'partie', 'parte', 'libro', 'livre',
]);

/** Numbers written out, and places in a series: "Chapter Seven", "Book the First". */
const NUMBER_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty',
  'ninety', 'hundred', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh',
  'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
  'thirtieth', 'fortieth', 'fiftieth',
]);

/**
 * Words that name nothing: little words ("Chapter 1 of 12"), the endings of 1st and 2nd, and what
 * a file's name carries besides its number (its bit rate, where it came from, a missing title).
 */
const EMPTY_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'and', 'to', 'on', 'at', 'by', 'for', 'or', 'with', 'st', 'nd', 'rd', 'th',
  'kb', 'kbps', 'khz', 'hz', 'vbr', 'cbr', 'librivox', 'unabridged', 'abridged', 'untitled', 'unnamed', 'unknown',
]);

const AUDIO_FILE = /\.(?:mp3|m4a|m4b|mp4|aac|ogg|oga|opus|flac|wav|webm)$/i;

/**
 * The words of a name as written, without accents: apart at spaces and punctuation, between letters
 * and digits ("ch07", "64kb") and where a capital starts a word inside another ("AliceInWonderland").
 */
function wordsOf(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\p{Ll}(?=\p{Lu})|\p{L}(?=\p{N})|\p{N}(?=\p{L})/gu, '$& ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/**
 * Whether a chapter's name only numbers it: nothing but a number ("07"), or a number with words
 * that count ("Chapter Seven", "Track 07", "Part III", "Book the First"), little words, the book's
 * own title or author ("Alice in Wonderland 07"); or a file's name with a number in it
 * ("wonderland_ch_07_64kb": no title is written with underscores). A word of the name's own makes
 * it real ("CHAPTER III. A Caucus-Race and a Long Tale", "Prologue", "Catch-22"), as does the
 * lack of a number: "The Letter" is a title.
 */
export function isGenericChapterName(name: string, book: BookNaming): boolean {
  const stem = name.trim().replace(AUDIO_FILE, '');
  const words = wordsOf(stem);
  if (!words.some((w) => /\p{L}/u.test(w))) return true;
  const own = new Set(wordsOf(`${book.title} ${book.author}`).map((w) => w.toLowerCase()));
  let numbered = false;
  let named = false;
  let counting = false;
  for (const word of words) {
    const lower = word.toLowerCase();
    // A Roman numeral counts in capitals, or after a word that counts ("Chapter iv"): "Liv" and
    // "Mix" are names.
    const roman = (counting || word === word.toUpperCase()) && romanToInt(lower) !== null;
    counting = NUMBERING.has(lower);
    if (counting || EMPTY_WORDS.has(lower)) continue;
    if (/^\p{N}+$/u.test(word) || NUMBER_WORDS.has(lower) || roman) numbered = true;
    else if (word.length > 1 && !own.has(lower)) named = true;
  }
  const fileName = stem.includes('_') && !/\s/.test(stem);
  return numbered && (!named || fileName);
}

/**
 * The chapters, each known only by a generic name taking the real one offered for it (the title of
 * the unit an edition starts it with), unless the two name different numbers: "Chapter 3" becomes
 * "CHAPTER III. A Caucus-Race and a Long Tale", never "CHAPTER IV. The Rabbit Sends in a Little
 * Bill", which says the match is wrong there. Every chapter keeps its place; a real name is never
 * replaced, so a name is learned once. Null when no name changes.
 */
export function learnChapterNames(chapters: readonly Chapter[], offered: readonly { readonly chapter: number; readonly title: string }[], book: BookNaming): Chapter[] | null {
  let named: Chapter[] | null = null;
  for (const { chapter, title } of offered) {
    const current = (named ?? chapters)[chapter];
    if (!current || !isGenericChapterName(current.title, book) || isGenericChapterName(title, book)) continue;
    const was = chapterNumber(current.title);
    const is = chapterNumber(title);
    if (was !== null && is !== null && was !== is) continue;
    named ??= [...chapters];
    named[chapter] = { ...current, title };
  }
  return named;
}
