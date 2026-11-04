import { describe, expect, it } from 'vitest';
import { unitsAtFileStarts } from '../src/repos/books';

describe("an audiobook's tracks and their units", () => {
  it('pairs each file with the unit it starts with, one unit per file', () => {
    const units = [
      { title: 'Chapter 1', m: 0 },
      { title: 'Chapter 2', m: 60_000 },
      { title: 'Chapter 3', m: 150_000 },
    ];
    expect(unitsAtFileStarts(units, [60_000, 90_000, 30_000])).toEqual([0, 1, 2]);
  });

  it('skips the chapters inside a file (an M4B): the next file starts at its own first unit', () => {
    // Part 1 holds chapters 1 to 3, part 2 chapters 4 and 5.
    const units = [
      { title: 'Chapter 1', m: 0 },
      { title: 'Chapter 2', m: 400_000 },
      { title: 'Chapter 3', m: 800_000 },
      { title: 'Chapter 4', m: 1_200_000 },
      { title: 'Chapter 5', m: 1_500_000 },
    ];
    expect(unitsAtFileStarts(units, [1_200_000, 700_000])).toEqual([0, 3]);
    // One file with all of them.
    expect(unitsAtFileStarts(units, [1_900_000])).toEqual([0]);
  });
});
