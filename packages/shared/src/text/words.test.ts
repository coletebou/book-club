import { describe, expect, it } from 'vitest';
import { normalizeWord, numberWords, sentenceSpans, textWords } from './words';

const spans = (text: string, breaks: number[] = []) => sentenceSpans(text, breaks).map((s) => text.slice(s.start, s.end));

describe('normalizeWord', () => {
  it('lowercases and drops accents and apostrophes', () => {
    expect(normalizeWord('Alice’s')).toBe('alices');
    expect(normalizeWord("DON'T")).toBe('dont');
    expect(normalizeWord('Café')).toBe('cafe');
    expect(normalizeWord('naïve')).toBe('naive');
  });
});

describe('numberWords', () => {
  it('says whole numbers the way a narrator would', () => {
    expect(numberWords(0)).toEqual(['zero']);
    expect(numberWords(7)).toEqual(['seven']);
    expect(numberWords(13)).toEqual(['thirteen']);
    expect(numberWords(20)).toEqual(['twenty']);
    expect(numberWords(42)).toEqual(['forty', 'two']);
    expect(numberWords(100)).toEqual(['one', 'hundred']);
    expect(numberWords(105)).toEqual(['one', 'hundred', 'five']);
    expect(numberWords(999)).toEqual(['nine', 'hundred', 'ninety', 'nine']);
    expect(numberWords(1000)).toEqual(['one', 'thousand']);
    expect(numberWords(123_456)).toEqual(['one', 'hundred', 'twenty', 'three', 'thousand', 'four', 'hundred', 'fifty', 'six']);
  });

  it('leaves what it cannot say as digits', () => {
    expect(numberWords(1_000_000)).toEqual(['1000000']);
    expect(numberWords(2.5)).toEqual(['2.5']);
  });
});

describe('textWords', () => {
  it('finds words with their offsets, apostrophes inside words and hyphens between them', () => {
    const text = '‘and what is the use of a book,’ thought Alice; Rabbit-Hole, o’clock';
    const words = textWords(text, 100);
    expect(words.map((w) => w.norm)).toEqual(['and', 'what', 'is', 'the', 'use', 'of', 'a', 'book', 'thought', 'alice', 'rabbit', 'hole', 'oclock']);
    for (const w of words) expect(normalizeWord(text.slice(w.start - 100, w.end - 100)).replace(/[^\p{L}\p{N}]/gu, '')).toBe(w.norm);
    expect(words[0]).toEqual({ norm: 'and', start: 101, end: 104 });
  });

  it('reads chapter numerals and digits as words, keeping the token’s span', () => {
    const text = 'CHAPTER IV. In 1865 I saw 42 cats.';
    const words = textWords(text);
    expect(words.map((w) => w.norm)).toEqual(['chapter', 'four', 'in', 'eighteen', 'sixty', 'five', 'i', 'saw', 'forty', 'two', 'cats']);
    const year = words.filter((w) => ['eighteen', 'sixty', 'five'].includes(w.norm));
    expect(new Set(year.map((w) => text.slice(w.start, w.end)))).toEqual(new Set(['1865']));
    expect(text.slice(words[1]!.start, words[1]!.end)).toBe('IV');
  });

  it('reads years with oh and hundred, and numbers after a chapter word as plain numbers', () => {
    expect(textWords('in 1805').map((w) => w.norm)).toEqual(['in', 'eighteen', 'oh', 'five']);
    expect(textWords('by 1900').map((w) => w.norm)).toEqual(['by', 'nineteen', 'hundred']);
    expect(textWords('Chapter 1200').map((w) => w.norm)).toEqual(['chapter', 'one', 'thousand', 'two', 'hundred']);
    expect(textWords('Part 3').map((w) => w.norm)).toEqual(['part', 'three']);
  });

  it('keeps the pronoun I and words that only look like numerals', () => {
    expect(textWords('I did. Mix it.').map((w) => w.norm)).toEqual(['i', 'did', 'mix', 'it']);
  });
});

describe('sentenceSpans', () => {
  it('cuts after sentence punctuation and closing quotes when a capital follows', () => {
    const text = 'Alice was tired. ‘What is the use of a book?’ So she was considering. Was it? Yes!';
    expect(spans(text)).toEqual(['Alice was tired.', '‘What is the use of a book?’', 'So she was considering.', 'Was it?', 'Yes!']);
  });

  it('does not cut dialogue that goes on in lower case', () => {
    const text = '‘Well!’ thought Alice to herself. ‘I wish I hadn’t cried so much!’ said Alice, as she swam about.';
    expect(spans(text)).toEqual(['‘Well!’ thought Alice to herself.', '‘I wish I hadn’t cried so much!’ said Alice, as she swam about.']);
  });

  it('does not cut after abbreviations and initials', () => {
    const text = 'Mr. Darcy met Dr. Watson and J. R. Smith. Then they left.';
    expect(spans(text)).toEqual(['Mr. Darcy met Dr. Watson and J. R. Smith.', 'Then they left.']);
  });

  it('cuts at block edges and line breaks, and skips text without words', () => {
    const text = 'CHAPTER I.\nDown the Rabbit-Hole\n\n* * *\n\nHow doth the little crocodile\nImprove his shining tail';
    const breaks = [...text.matchAll(/\n/g)].flatMap((m) => [m.index, m.index + 1]);
    expect(spans(text, breaks)).toEqual(['CHAPTER I.', 'Down the Rabbit-Hole', 'How doth the little crocodile', 'Improve his shining tail']);
  });

  it('cuts a very long sentence after a semicolon where both pieces are long', () => {
    const half = 'and the little thing grew larger and larger as she watched it go on and on';
    const text = `${half} through the long hall; ${half} into the garden at last.`;
    const out = spans(text);
    expect(out).toHaveLength(2);
    expect(out[0]!.endsWith('hall;')).toBe(true);
    expect(out[1]!.startsWith('and the little')).toBe(true);
    // A short clause is not cut off on its own.
    const short = `Yes; ${half} ${half} ${half}.`;
    expect(spans(short)).toEqual([short]);
  });

  it('returns spans that are exact slices of the text, without surrounding space', () => {
    const text = '  First one.   Second one!  ';
    const out = sentenceSpans(text);
    expect(out).toEqual([
      { start: 2, end: 12 },
      { start: 15, end: 26 },
    ]);
  });
});
