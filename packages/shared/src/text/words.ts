import { romanToInt } from './titles';

/**
 * Words and sentences of a book's text, for lining it up with what a narrator says. Offsets are
 * UTF-16 code units of the text they came from (plus a base), the measure EPUB locators use.
 */

/** A word: its normalised form and where it is in the text (end exclusive). */
export interface Word {
  readonly norm: string;
  readonly start: number;
  readonly end: number;
}

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** Letters and digits, with apostrophes inside a word ("don’t", "Alice’s", "o’clock"). */
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Words after which a Roman numeral is a number: "CHAPTER IV", "Book II". */
const NUMBERED = new Set(['chapter', 'book', 'part', 'volume', 'canto', 'act', 'scene', 'letter', 'stave', 'section']);

/** Lowercase, without accents or apostrophes: "Alice’s" → "alices", "Café" → "cafe". */
export function normalizeWord(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '');
}

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** English words for a whole number below a million: 42 → forty two, 1300 → one thousand three hundred. */
export function numberWords(n: number): string[] {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000) return [String(n)];
  if (n < 20) return [ONES[n]!];
  if (n < 100) return n % 10 === 0 ? [TENS[n / 10]!] : [TENS[Math.floor(n / 10)]!, ONES[n % 10]!];
  if (n < 1000) {
    const rest = n % 100;
    return [ONES[Math.floor(n / 100)]!, 'hundred', ...(rest > 0 ? numberWords(rest) : [])];
  }
  const rest = n % 1000;
  return [...numberWords(Math.floor(n / 1000)), 'thousand', ...(rest > 0 ? numberWords(rest) : [])];
}

/** A year as it is read aloud: 1865 → eighteen sixty five, 1900 → nineteen hundred, 1805 → eighteen oh five. */
function yearWords(n: number): string[] {
  const high = Math.floor(n / 100);
  const low = n % 100;
  if (low === 0) return [...numberWords(high), 'hundred'];
  return [...numberWords(high), ...(low < 10 ? ['oh', ONES[low]!] : numberWords(low))];
}

function expand(norm: string, previous: string): string[] {
  if (/^\d+$/.test(norm)) {
    const n = Number(norm);
    if (norm.length === 4 && n >= 1100 && n <= 1999 && !NUMBERED.has(previous)) return yearWords(n);
    return numberWords(n);
  }
  if (NUMBERED.has(previous)) {
    const roman = romanToInt(norm);
    if (roman !== null) return numberWords(roman);
  }
  return [norm];
}

/**
 * The words of a text, normalised for comparison with speech. Digits become the words a reader
 * says ("1865" → eighteen sixty five) and so do the Roman numerals of headings ("CHAPTER IV" →
 * chapter four), so a heading matches however the recogniser wrote it. The words of an expanded
 * number all keep the span of the token they came from.
 */
export function textWords(text: string, base = 0): Word[] {
  const out: Word[] = [];
  let previous = '';
  for (const match of text.matchAll(WORD)) {
    const start = base + match.index;
    const end = start + match[0].length;
    const norm = normalizeWord(match[0]);
    for (const w of expand(norm, previous)) out.push({ norm: w, start, end });
    previous = norm;
  }
  return out;
}

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof', 'rev', 'gen', 'col', 'capt', 'lt', 'sgt', 'mt',
  'vs', 'etc', 'no', 'vol', 'ch', 'fig', 'messrs', 'mme', 'mlle', 'esq', 'hon',
]);

/** Sentence punctuation, then closing quotes or brackets, then space and a capital or a digit. */
const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s+["'“‘([]*[\p{Lu}\p{N}])/gu;
/** A long sentence may also be cut after ; or : (the pieces a narrator breathes between). */
const CLAUSE_END = /[;:](?=\s)/g;
const LONG_SENTENCE_WORDS = 40;
const MIN_CLAUSE_WORDS = 10;

function countWords(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(WORD)) n++;
  return n;
}

function trimmed(text: string, start: number, end: number): TextSpan | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (s >= e || !/[\p{L}\p{N}]/u.test(text.slice(s, e))) return null;
  return { start: s, end: e };
}

function isAbbreviation(text: string, segmentStart: number, punct: number): boolean {
  if (text[punct] !== '.') return false;
  const before = /(\p{L}+)$/u.exec(text.slice(Math.max(segmentStart, punct - 12), punct));
  if (!before) return false;
  const word = before[1]!;
  return ABBREVIATIONS.has(word.toLowerCase()) || (word.length === 1 && /\p{Lu}/u.test(word));
}

/** Cut a long sentence after ; or : where both sides keep at least MIN_CLAUSE_WORDS words. */
function clauses(text: string, span: TextSpan): TextSpan[] {
  const body = text.slice(span.start, span.end);
  if (countWords(body) <= LONG_SENTENCE_WORDS) return [span];
  const out: TextSpan[] = [];
  let from = span.start;
  for (const m of body.matchAll(CLAUSE_END)) {
    const cut = span.start + m.index + 1;
    if (countWords(text.slice(from, cut)) >= MIN_CLAUSE_WORDS && countWords(text.slice(cut, span.end)) >= MIN_CLAUSE_WORDS) {
      const piece = trimmed(text, from, cut);
      if (piece) out.push(piece);
      from = cut;
    }
  }
  const last = trimmed(text, from, span.end);
  if (last) out.push(last);
  return out;
}

/**
 * Sentences of a text, as spans without surrounding space. A sentence ends at ., ! or ? (and any
 * closing quotes or brackets after it) when the next word starts with a capital letter or a
 * digit, except after a common abbreviation or an initial ("Mr. Darcy", "J. Smith"). `breaks` are
 * offsets that always end one: the edges of paragraphs, headings and list items, and line breaks
 * (each line of a poem is read as one). Text without letters or digits ("* * *") is no sentence.
 */
export function sentenceSpans(text: string, breaks: readonly number[] = []): TextSpan[] {
  const cuts = [...new Set([0, ...breaks.filter((b) => b > 0 && b < text.length), text.length])].sort((a, b) => a - b);
  const out: TextSpan[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const segStart = cuts[i]!;
    const segEnd = cuts[i + 1]!;
    const segment = text.slice(segStart, segEnd);
    let from = segStart;
    for (const m of segment.matchAll(SENTENCE_END)) {
      const punct = segStart + m.index;
      if (isAbbreviation(text, segStart, punct)) continue;
      const end = punct + m[0].length;
      const span = trimmed(text, from, end);
      if (span) out.push(...clauses(text, span));
      from = end;
    }
    const rest = trimmed(text, from, segEnd);
    if (rest) out.push(...clauses(text, rest));
  }
  return out;
}
