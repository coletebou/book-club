import { type Chapter, calmCaps, meetingStops } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { chapterSubtitle, stopChoices } from './stop-titles';

const chapters = (...entries: [string, number][]): Chapter[] => entries.map(([title, t], index) => ({ index, title, t }));

/** Gutenberg's Alice as the club's book has it: its title page and contents, then its twelve chapters. */
const ALICE = chapters(
  ['Alice’s Adventures in Wonderland', 0],
  ['THE MILLENNIUM FULCRUM EDITION 3.0', 0.0002],
  ['Contents', 0.001],
  ['CHAPTER I. Down the Rabbit-Hole', 0.004],
  ['CHAPTER II. The Pool of Tears', 0.083],
  ['CHAPTER III. A Caucus-Race and a Long Tale', 0.159],
  ['CHAPTER IV. The Rabbit Sends in a Little Bill', 0.225],
  ['CHAPTER V. Advice from a Caterpillar', 0.321],
  ['CHAPTER VI. Pig and Pepper', 0.403],
  ['CHAPTER VII. A Mad Tea-Party', 0.499],
  ['CHAPTER VIII. The Queen’s Croquet-Ground', 0.587],
  ['CHAPTER IX. The Mock Turtle’s Story', 0.681],
  ['CHAPTER X. The Lobster Quadrille', 0.769],
  ['CHAPTER XI. Who Stole the Tarts?', 0.848],
  ['CHAPTER XII. Alice’s Evidence', 0.92],
);

describe('what a chapter’s heading says beyond its number', () => {
  it('is its title, as the book has it', () => {
    expect(chapterSubtitle('CHAPTER VII. A Mad Tea-Party')).toBe('A Mad Tea-Party');
    expect(chapterSubtitle('CHAPTER XI. Who Stole the Tarts?')).toBe('Who Stole the Tarts?');
    expect(chapterSubtitle('Chapter 3: The Pool of Tears')).toBe('The Pool of Tears');
    expect(chapterSubtitle('Chapter Twenty-One — The Ball')).toBe('The Ball');
    expect(chapterSubtitle('CHAPTERXXVII. Mr. Collins')).toBe('Mr. Collins');
  });

  it('is said calmly when the book sets it in capitals', () => {
    expect(chapterSubtitle('STAVE ONE. MARLEY’S GHOST.')).toBe('Marley’s Ghost');
    expect(chapterSubtitle('STAVE TWO. THE FIRST OF THE THREE SPIRITS.')).toBe('The First of the Three Spirits');
    expect(chapterSubtitle('CHAPTER I. DOWN THE RABBIT-HOLE')).toBe('Down the Rabbit-Hole');
  });

  it('follows the chapter’s own number in a book in parts', () => {
    expect(chapterSubtitle('Part 2, Chapter 1. The Return')).toBe('The Return');
    expect(chapterSubtitle('PART TWO. CHAPTER III. THE LETTER')).toBe('The Letter');
  });

  it('is nothing for a heading that is its number, or a title with no number (its name says it all)', () => {
    for (const title of ['CHAPTER I.', 'Chapter 3', 'II', 'XII.', 'Preface', 'The Last Chapter', 'BOOK ONE: 1805', 'II. The Second', 'Chapter 1.1', 'He rode a black horse. CHAPTER III.']) {
      expect(chapterSubtitle(title), title).toBeNull();
    }
  });
});

describe('a title in capitals, calmed (calmCaps, as the choices say it)', () => {
  it('starts each word with a capital, the small ones after the first in small letters', () => {
    expect(calmCaps('THE LAST OF THE SPIRITS')).toBe('The Last of the Spirits');
    expect(calmCaps('A MAD TEA-PARTY')).toBe('A Mad Tea-Party');
    expect(calmCaps('“OFF WITH HER HEAD!”')).toBe('“Off with Her Head!”');
  });

  it('keeps a numeral, and leaves any title with small letters as it is', () => {
    expect(calmCaps('BOOK II IN WHICH I GO')).toBe('Book II in Which I Go');
    expect(calmCaps('The Pool of Tears')).toBe('The Pool of Tears');
    expect(calmCaps('1805')).toBe('1805');
  });
});

describe('the next stop’s choices', () => {
  it('name each chapter’s title beside its name, and keep the stops and their labels as they are', () => {
    const choices = stopChoices(ALICE);
    expect(choices.map(({ t, label }) => ({ t, label }))).toEqual(meetingStops(ALICE));
    expect(choices.map((c) => c.text)).toEqual([
      'The end of Chapter 1 · Down the Rabbit-Hole',
      'The end of Chapter 2 · The Pool of Tears',
      'The end of Chapter 3 · A Caucus-Race and a Long Tale',
      'The end of Chapter 4 · The Rabbit Sends in a Little Bill',
      'The end of Chapter 5 · Advice from a Caterpillar',
      'The end of Chapter 6 · Pig and Pepper',
      'The end of Chapter 7 · A Mad Tea-Party',
      'The end of Chapter 8 · The Queen’s Croquet-Ground',
      'The end of Chapter 9 · The Mock Turtle’s Story',
      'The end of Chapter 10 · The Lobster Quadrille',
      'The end of Chapter 11 · Who Stole the Tarts?',
      // Named for the book, not a chapter.
      'The end of the book',
    ]);
  });

  it('say only the name where a chapter has no title beyond its number', () => {
    const gatsby = chapters(['I', 0], ['II', 0.11], ['III', 0.22], ['IV', 0.33], ['V', 0.44], ['VI', 0.55], ['VII', 0.66], ['VIII', 0.77], ['IX', 0.88]);
    expect(stopChoices(gatsby).map((c) => c.text)).toEqual(['The end of Chapter 1', 'The end of Chapter 2', 'The end of Chapter 3', 'The end of Chapter 4', 'The end of Chapter 5', 'The end of Chapter 6', 'The end of Chapter 7', 'The end of Chapter 8', 'The end of the book']);
    // A book without chapters stops at its quarters.
    expect(stopChoices([]).map((c) => c.text)).toEqual(['25%', '50%', '75%', 'The end of the book']);
  });

  it('take the title of the chapter the stop ends: where a part’s heading starts at its first chapter, the chapter’s', () => {
    // A part's heading where its first chapter starts, as War and Peace has them: the stop keeps
    // its label (meetingStops' own), the title is the chapter's.
    const parts = chapters(['BOOK ONE: 1805', 0], ['CHAPTER I. WELL, PRINCE', 0], ['CHAPTER II. Anna Pávlovna’s drawing room', 0.5]);
    const choices = stopChoices(parts);
    expect(choices.map(({ t, label }) => ({ t, label }))).toEqual(meetingStops(parts));
    expect(choices.map((c) => c.text)).toEqual([`${meetingStops(parts)[0]!.label.replace(/^t/, 'T')} · Well, Prince`, 'The end of the book']);
    // The chapter in the middle of a book, not the one whose end is the book's.
    const two = chapters(['CHAPTER I. Begin', 0], ['CHAPTER II. Middle', 0.5]);
    expect(stopChoices(two).map((c) => c.text)).toEqual(['The end of Chapter 1 · Begin', 'The end of the book']);
  });
});
