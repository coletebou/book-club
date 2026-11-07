import { MAX_CHAT_TEXT } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { chatTextOf, fenceAt } from './in-chat';
import { type CalContentPart } from './types';

const citation = (n: number, chapterTitle: string | null = `Chapter ${n}`): CalContentPart => ({
  type: 'citation',
  chunkId: `c${n}`,
  bookId: 'b1',
  bookTitle: 'Alice',
  chapterTitle,
  t: n / 10,
  quote: `Passage ${n} `.repeat(40),
});

describe('fenceAt (D204)', () => {
  it('fences a hair before the furthest place read: read to a place is read up to it', () => {
    expect(fenceAt(0.5, 0)).toBeCloseTo(0.5, 8);
    expect(fenceAt(0.5, 0)).toBeLessThan(0.5);
  });

  it('goes as far as a message he was given is fenced, when that is further', () => {
    expect(fenceAt(0.2, 0.7)).toBe(0.7);
  });

  it('fences nothing before anything is read, and never past the end', () => {
    expect(fenceAt(0, 0)).toBeNull();
    expect(fenceAt(1, 1)).toBe(1);
  });
});

describe('chatTextOf (D204)', () => {
  it('is his words, then a numbered line for each passage cited, as his words number them', () => {
    const text = chatTextOf([{ type: 'text', text: 'The Rabbit is late. [1] He says so twice. [2]' }, citation(1), citation(2, null)]);
    const [words, notes] = text.split('\n\n');
    expect(words).toBe('The Rabbit is late. [1] He says so twice. [2]');
    const lines = notes!.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[1\] Alice, Chapter 1: “Passage 1 .*…”$/);
    expect(lines[1]).toMatch(/^\[2\] Alice: “Passage 2 /);
    // A quote is cut short for a chat bubble.
    expect(lines[0]!.length).toBeLessThan(160);
  });

  it('keeps within a chat message’s length, cut at a word, never through a character', () => {
    const long = chatTextOf([{ type: 'text', text: `${'word '.repeat(900)}😀`.repeat(2) }]);
    expect(long.length).toBeLessThanOrEqual(MAX_CHAT_TEXT);
    expect(long.endsWith('…')).toBe(true);
    expect(long.slice(0, -1).endsWith('word')).toBe(true);
    const emoji = chatTextOf([{ type: 'text', text: '😀'.repeat(MAX_CHAT_TEXT) }]);
    expect(emoji.length).toBeLessThanOrEqual(MAX_CHAT_TEXT);
    expect(/[\uD800-\uDBFF]…$/u.test(emoji)).toBe(false);
  });

  it('is empty when he said nothing', () => {
    expect(chatTextOf([{ type: 'text', text: '  ' }])).toBe('');
  });
});
