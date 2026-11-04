import { describe, expect, it } from 'vitest';
import { beforeStory, beforeStoryName, chapterIndexAt, chapterLabel, chapterNameAt, chapterNames, divisionAt, listeningLabel } from './chapters';

const chapters = [
  { title: 'Contents', t: 0 },
  { title: 'CHAPTER I. Down the Rabbit-Hole', t: 0.01 },
  { title: 'CHAPTER II. The Pool of Tears', t: 0.1 },
];

describe('chapters', () => {
  it('finds the chapter containing t', () => {
    expect(chapterIndexAt(chapters, 0)).toBe(0);
    expect(chapterIndexAt(chapters, 0.05)).toBe(1);
    expect(chapterIndexAt(chapters, 0.1)).toBe(2);
    expect(chapterIndexAt([{ title: 'Late', t: 0.5 }], 0.2)).toBe(-1);
  });

  it('labels positions with the chapter name and percentage', () => {
    expect(chapterLabel(chapters, 0.05)).toBe('Chapter 1 · 5%');
    // The contents are front matter: a place there is before the story's first chapter (D77).
    expect(chapterLabel(chapters, 0)).toBe('Before Chapter 1 · 0%');
    expect(chapterLabel([], 0.42)).toBe('42%');
    expect(chapterNameAt(chapters, 0.5)).toBe('Chapter 2');
    expect(chapterNameAt([{ title: 'X', t: 0.9 }], 0.1)).toBeNull();
  });

  it('names a place in the front matter by the chapter the story starts with, never by a note or a title page’s line', () => {
    // Gutenberg's A Christmas Carol, its chapters as its contents give them (D77).
    const carol = [
      { title: 'There are several editions of this ebook in the Project Gutenberg collection.', t: 0 },
      { title: 'A CHRISTMAS CAROL', t: 0.0032 },
      { title: 'CONTENTS', t: 0.0066 },
      { title: 'STAVE ONE. MARLEY’S GHOST.', t: 0.0123 },
      { title: 'STAVE TWO. THE FIRST OF THE THREE SPIRITS.', t: 0.2393 },
    ];
    expect(chapterLabel(carol, 0)).toBe('Before Stave 1 · 0%');
    // The story's very start, a character before the first entry of the contents.
    expect(chapterLabel(carol.map((c) => ({ ...c, t: c.t + 0.00001 })), 0)).toBe('Before Stave 1 · 0%');
    expect(chapterLabel(carol, 0.011)).toBe('Before Stave 1 · 1%');
    expect(chapterLabel(carol, 0.1)).toBe('Stave 1 · 10%');
    expect(chapterNameAt(carol, 0.3)).toBe('Stave 2');
    // A book whose chapters are all story, and one of a single chapter.
    expect(chapterLabel([{ title: 'CHAPTER I', t: 0 }, { title: 'CHAPTER II', t: 0.5 }], 0)).toBe('Chapter 1 · 0%');
    expect(chapterLabel([{ title: 'Contents', t: 0 }], 0.2)).toBe('Contents · 20%');
  });

  it('knows a place before the story, and names it by the story’s first chapter', () => {
    const gatsby = [
      { title: 'The Great Gatsby by F. Scott Fitzgerald', t: 0.00001 },
      { title: 'Table of Contents', t: 0.0002 },
      { title: 'I', t: 0.0013 },
      { title: 'II', t: 0.12 },
    ];
    expect(beforeStory(gatsby, 0)).toBe(true);
    expect(beforeStory(gatsby, 0.001)).toBe(true);
    expect(beforeStory(gatsby, 0.0013)).toBe(false);
    expect(beforeStoryName(gatsby)).toBe('Before Chapter 1');
    expect(chapterLabel(gatsby, 0.2)).toBe('Chapter 2 · 20%');
    expect(beforeStory([], 0)).toBe(false);
  });

  it('names a chapter with its part where the book numbers its chapters afresh in each (D86)', () => {
    // Crime and Punishment, as its contents give it: six parts of chapters I, II, …, and an epilogue.
    const crime = [
      { title: 'CRIME AND PUNISHMENT', t: 0 },
      { title: 'TRANSLATOR’S PREFACE', t: 0.001 },
      { title: 'PART I', t: 0.005 },
      { title: 'CHAPTER I', t: 0.0051 },
      { title: 'CHAPTER II', t: 0.02 },
      { title: 'PART II', t: 0.15 },
      { title: 'CHAPTER I', t: 0.1501 },
      { title: 'CHAPTER II', t: 0.17 },
      { title: 'EPILOGUE', t: 0.96 },
    ];
    expect(chapterNames(crime)).toEqual(['Crime and Punishment', 'Translator’s Preface', 'Part 1', 'Part 1, Chapter 1', 'Part 1, Chapter 2', 'Part 2', 'Part 2, Chapter 1', 'Part 2, Chapter 2', 'Epilogue']);
    expect(chapterLabel(crime, 0.16)).toBe('Part 2, Chapter 1 · 16%');
    // Before the story (the part's own title page too), and before the contents' first entry, the
    // place is named by the story's first chapter, with its part.
    expect(chapterLabel(crime, 0.002)).toBe('Before Part 1, Chapter 1 · 0%');
    expect(chapterLabel(crime.slice(1), 0)).toBe('Before Part 1, Chapter 1 · 0%');
    // A listener at the start of Part II's first track hears its chapter, named with its part.
    expect(listeningLabel(crime, 0.1500, 6)).toBe('Part 2, Chapter 1 · 15%');
    expect(chapterNameAt(crime, 0.03)).toBe('Part 1, Chapter 2');
    expect(divisionAt(crime, 0.16)).toBe('Part 2');
    // War and Peace's books by their numbers, an epilogue by its name, its span of years left out.
    const war = [
      { title: 'BOOK ONE: 1805', t: 0.002 },
      { title: 'CHAPTER I', t: 0.0021 },
      { title: 'BOOK TWO: 1805', t: 0.07 },
      { title: 'CHAPTER I', t: 0.0701 },
      { title: 'FIRST EPILOGUE: 1813 - 20', t: 0.9 },
      { title: 'CHAPTER I', t: 0.9001 },
    ];
    expect(chapterNames(war)).toEqual(['Book 1', 'Book 1, Chapter 1', 'Book 2', 'Book 2, Chapter 1', 'First Epilogue: 1813 - 20', 'First Epilogue, Chapter 1']);
    // A book numbered straight through keeps its chapters' own names, parts or none.
    const women = [
      { title: 'PART 1', t: 0.002 },
      { title: 'CHAPTER ONE PLAYING PILGRIMS', t: 0.0021 },
      { title: 'PART 2', t: 0.46 },
      { title: 'CHAPTER TWENTY-FOUR GOSSIP', t: 0.4601 },
    ];
    expect(chapterNames(women)).toEqual(['Part 1', 'Chapter 1', 'Part 2', 'Chapter 24']);
    expect(divisionAt(women, 0.5)).toBeNull();
  });

  it('takes chapters numbered apart from letters for no parts, and never the contents for a part', () => {
    // Frankenstein: letters 1 to 4, then chapters 1 to 24; no name comes twice.
    const frankenstein = [
      { title: 'Frankenstein; or, the Modern Prometheus', t: 0 },
      { title: 'CONTENTS', t: 0.001 },
      { title: 'Letter 1', t: 0.002 },
      { title: 'Letter 2', t: 0.01 },
      { title: 'Chapter 1', t: 0.05 },
      { title: 'Chapter 2', t: 0.08 },
    ];
    expect(chapterNames(frankenstein).slice(2)).toEqual(['Letter 1', 'Letter 2', 'Chapter 1', 'Chapter 2']);
    expect(beforeStoryName(frankenstein)).toBe('Before Letter 1');
    // A book whose first part has no heading of its own: its chapters are named alone, not "Contents, …".
    const unheaded = [
      { title: 'A Novel', t: 0 },
      { title: 'Contents', t: 0.001 },
      { title: 'CHAPTER I', t: 0.002 },
      { title: 'CHAPTER II', t: 0.2 },
      { title: 'PART II', t: 0.5 },
      { title: 'CHAPTER I', t: 0.5001 },
    ];
    expect(chapterNames(unheaded).slice(2)).toEqual(['Chapter 1', 'Chapter 2', 'Part 2', 'Part 2, Chapter 1']);
  });

  it('names a recording’s announcement before a chapter’s words by the chapter its track is', () => {
    // 0.099 is still the end of chapter I on the timeline, but chapter II's track has begun.
    expect(listeningLabel(chapters, 0.099, 2)).toBe('Chapter 2 · 9%');
    expect(chapterLabel(chapters, 0.099)).toBe('Chapter 1 · 9%');
    // Inside the chapter, or a track lined up with an earlier chapter, or none: as the timeline says.
    expect(listeningLabel(chapters, 0.2, 2)).toBe('Chapter 2 · 20%');
    expect(listeningLabel(chapters, 0.2, 1)).toBe('Chapter 2 · 20%');
    expect(listeningLabel(chapters, 0.05, null)).toBe('Chapter 1 · 5%');
  });
});
