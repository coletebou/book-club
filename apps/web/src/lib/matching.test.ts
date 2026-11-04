import { describe, expect, it } from 'vitest';
import { placedBetween } from './matching';

const units = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Track ${i + 1}`, m: i * 1000 }));

describe('units placed between matched ones (D77)', () => {
  it('counts the tracks after the first matched one that start no chapter', () => {
    // LibriVox's Christmas Carol, matched by its subtitles' words before staves numbered chapters.
    expect(placedBetween({ alignment: { method: 'title', unitToChapter: [10, null, null, null, 22] }, units: units(5) })).toBe(3);
    expect(placedBetween({ alignment: { method: 'number', unitToChapter: [7, 8, 9, 10, 11] }, units: units(5) })).toBe(0);
    // An intro track before the first match is where it should be.
    expect(placedBetween({ alignment: { method: 'count', unitToChapter: [null, 3, 4, 5] }, units: units(4) })).toBe(0);
    // A list of choices shorter than the units leaves the rest unmatched.
    expect(placedBetween({ alignment: { method: 'number', unitToChapter: [3, 4] }, units: units(4) })).toBe(2);
  });

  it('says nothing of a match by hand, a straight line, the book’s own chapters or a word-by-word line-up', () => {
    for (const method of ['manual', 'none', 'reference', 'forced'] as const) {
      expect(placedBetween({ alignment: { method, unitToChapter: [3, null, null] }, units: units(3) })).toBe(0);
    }
  });
});
