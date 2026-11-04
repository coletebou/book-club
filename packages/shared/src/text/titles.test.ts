import { describe, expect, it } from 'vitest';
import {
  calmCaps,
  chapterHeading,
  chapterNumber,
  filenameStem,
  intToRoman,
  isBookList,
  namesChapter,
  naturalCompare,
  normalizeTitle,
  numberedAs,
  numbersOneChapter,
  prettifyTrackTitle,
  romanToInt,
  shortChapterName,
  tidyLabel,
  tidyTrackTitle,
  titleSimilarity,
  withoutCaption,
} from './titles';

describe('naturalCompare', () => {
  it('orders numbered filenames numerically', () => {
    const files = ['track 10.mp3', 'Track 2.mp3', 'track 1.mp3', 'track 02b.mp3', 'intro.mp3'];
    expect([...files].sort(naturalCompare)).toEqual(['intro.mp3', 'track 1.mp3', 'Track 2.mp3', 'track 02b.mp3', 'track 10.mp3']);
  });

  it('orders LibriVox chapter files', () => {
    const files = ['wonderland_ch_10_64kb.mp3', 'wonderland_ch_02_64kb.mp3', 'wonderland_ch_01_64kb.mp3'];
    expect([...files].sort(naturalCompare)[0]).toBe('wonderland_ch_01_64kb.mp3');
  });

  it('is a total order (ties broken deterministically)', () => {
    expect(naturalCompare('a', 'A')).not.toBe(0);
    expect(naturalCompare('same', 'same')).toBe(0);
  });
});

describe('normalizeTitle and titleSimilarity', () => {
  it('strips case, accents, possessives and punctuation', () => {
    expect(normalizeTitle("  Alice’s Adventures in Wonderland! ")).toBe('alice adventures in wonderland');
    expect(normalizeTitle('Les Misérables')).toBe('les miserables');
  });

  it('scores the LibriVox album title as the same book as the Gutenberg title', () => {
    expect(titleSimilarity('Alice in Wonderland', "Alice's Adventures in Wonderland")).toBeGreaterThanOrEqual(0.8);
  });

  it('scores unrelated titles low', () => {
    expect(titleSimilarity('Moby Dick', "Alice's Adventures in Wonderland")).toBe(0);
    expect(titleSimilarity('', 'x')).toBe(0);
  });

  it('is cautious with one-word titles', () => {
    expect(titleSimilarity('Alice', "Alice's Adventures in Wonderland")).toBeLessThan(0.6);
  });
});

describe('roman numerals', () => {
  it('converts both ways and rejects malformed numerals', () => {
    expect(romanToInt('XII')).toBe(12);
    expect(romanToInt('xlii')).toBe(42);
    expect(romanToInt('iiii')).toBeNull();
    expect(romanToInt('abc')).toBeNull();
    expect(intToRoman(1994)).toBe('mcmxciv');
  });
});

describe('chapterNumber', () => {
  it.each([
    ['CHAPTER XII. Alice’s Evidence', 12],
    ['wonderland_ch_01_64kb.mp3', 1],
    ['Chapter Three', 3],
    ['07 - The Tea Party.mp3', 7],
    ['Part 2', 2],
    // Older books number by ordinals (A Tale of Two Cities' "Book the First").
    ['Book the First', 1],
    ['Chapter the Third', 3],
    ['Epilogue', null],
    ['The Pool of Tears 2', 2],
    ['Chapters 1-2', 1],
    ['Ch 3 & 4.mp3', 3],
    ['chapters_05_to_06', 5],
  ])('%s → %s', (input, expected) => {
    expect(chapterNumber(input)).toBe(expected);
  });
});

describe('numberedAs (D73)', () => {
  it.each([
    // Chapters, as LibriVox and the texts name them: what the chapter matching pairs.
    ['CHAPTER XII. Alice’s Evidence', 'chapter', 12],
    ['wonderland_ch_01_64kb.mp3', 'chapter', 1],
    ['Chapter 3', 'chapter', 3],
    ['Chapter Three', 'chapter', 3],
    ['Chapt. 4', 'chapter', 4],
    ['Capítulo 3', 'chapter', 3],
    ['03 - The Pool of Tears.mp3', 'chapter', 3],
    ['Alice in Wonderland 07', 'chapter', 7],
    // A recording's section number between its title and its reader; the bit rate is no number.
    ['alice_03_carroll_64kb.mp3', 'chapter', 3],
    ['01', 'chapter', 1],
    // A chapter named beside a part or a book is that chapter.
    ['Book 2, Chapter 5', 'chapter', 5],
    ['Part 2 - Chapter 5', 'chapter', 5],
    // Parts, tracks, discs, volumes, books and sides are not chapters.
    ['Part 3', 'part', 3],
    ['Alice - Part 3.mp3', 'part', 3],
    ['Parts 2', 'part', 2],
    ['Part Three', 'part', 3],
    ['Part III', 'part', 3],
    ['Teil 3', 'part', 3],
    ['Track 03', 'track', 3],
    ['track01', 'track', 1],
    ['Disc 2', 'disc', 2],
    ['CD2 - 05', 'disc', 2],
    ['Vol. 2', 'volume', 2],
    ['Volume II', 'volume', 2],
    ['Book 3', 'book', 3],
    ['BOOK ONE: 1805', 'book', 1],
    ['Side 2', 'side', 2],
    // A word that only looks like one: "Book" in a title counts nothing.
    ['The Book Thief 3', 'chapter', 3],
  ] as const)('%s numbers %s %s', (input, counts, n) => {
    expect(numberedAs(input)).toEqual({ counts, n, through: n });
  });

  it('reads the range a file of several chapters names, but not a year as its end', () => {
    expect(numberedAs('Chapters 1-2')).toEqual({ counts: 'chapter', n: 1, through: 2 });
    expect(numberedAs('Ch 3 & 4.mp3')).toEqual({ counts: 'chapter', n: 3, through: 4 });
    expect(numberedAs('chapters_05_to_06')).toEqual({ counts: 'chapter', n: 5, through: 6 });
    expect(numberedAs('Chapter 12 - 2005 recording')).toEqual({ counts: 'chapter', n: 12, through: 12 });
  });

  it('reads what some books call their chapters, and numbers in words of tens and units', () => {
    // A Christmas Carol's staves, as the Gutenberg text and LibriVox's tags (cut at 30 characters) name them.
    expect(numberedAs('STAVE ONE.')).toEqual({ counts: 'chapter', n: 1, through: 1 });
    expect(numberedAs('STAVE FIVE. THE END OF IT.')).toEqual({ counts: 'chapter', n: 5, through: 5 });
    expect(numberedAs('Stave 2: The First of the')).toEqual({ counts: 'chapter', n: 2, through: 2 });
    expect(numberedAs('03 - Stave 3: The Second of th')).toEqual({ counts: 'chapter', n: 3, through: 3 });
    expect(numberedAs('Canto XXXIV')).toEqual({ counts: 'chapter', n: 34, through: 34 });
    // Little Women's chapters 21 to 47 read as their tens alone before.
    expect(numberedAs('CHAPTER TWENTY-ONE LAURIE MAKES MISCHIEF, AND JO MAKES PEACE')).toEqual({ counts: 'chapter', n: 21, through: 21 });
    expect(numberedAs('Chapter forty seven')).toEqual({ counts: 'chapter', n: 47, through: 47 });
    // The word after a number is the title's, not part of the number.
    expect(numberedAs('CHAPTER ONE PLAYING PILGRIMS')).toEqual({ counts: 'chapter', n: 1, through: 1 });
    expect(numberedAs('CHAPTER TWENTY A PLEA')).toEqual({ counts: 'chapter', n: 20, through: 20 });
    expect(numberedAs('PART TWENTY-TWO')).toEqual({ counts: 'part', n: 22, through: 22 });
    expect(chapterNumber('Chapter Thirty-Three')).toBe(33);
    expect(chapterNumber('Stave 4: The Last of the')).toBe(4);
  });

  it('finds no number where none is written', () => {
    for (const title of ['Epilogue', 'Contents', 'Chapter the Last', 'Side A', '']) expect(numberedAs(title), title).toBeNull();
    // An ordinal numbers what its word counts (A Tale of Two Cities' books).
    expect(numberedAs('Book the First—Recalled to Life')).toEqual({ counts: 'book', n: 1, through: 1 });
    expect(numberedAs('Chapter the Twelfth')).toEqual({ counts: 'chapter', n: 12, through: 12 });
    // A span of years ends a title without numbering it: War and Peace's first epilogue.
    expect(numberedAs('FIRST EPILOGUE: 1813 - 20')).toBeNull();
    expect(numberedAs('BOOK FIVE: 1806 - 07')).toEqual({ counts: 'book', n: 5, through: 5 });
  });

  it('reads no chapter in the last digits of a decimal: the Gutenberg edition’s note is front matter (D74)', () => {
    expect(numberedAs('THE MILLENNIUM FULCRUM EDITION 3.0')).toBeNull();
    expect(numberedAs('Alice’s Adventures in Wonderland')).toBeNull();
    // A number of its own at the end still is one.
    expect(numberedAs('Alice in Wonderland 07')).toEqual({ counts: 'chapter', n: 7, through: 7 });
    expect(numberedAs('Alice in Wonderland, 07')).toEqual({ counts: 'chapter', n: 7, through: 7 });
  });

  it('leaves chapterNumber as it was: the number a file is ordered by, whatever it counts', () => {
    expect(chapterNumber('Part 3')).toBe(3);
    expect(chapterNumber('Track 03')).toBe(3);
  });
});

describe('prettifyTrackTitle', () => {
  it('keeps a real tag title', () => {
    expect(prettifyTrackTitle('Chapter 1: Down the Rabbit-Hole', 'a.mp3')).toBe('Chapter 1: Down the Rabbit-Hole');
  });

  it('turns LibriVox tag titles that are just filenames into chapter names', () => {
    expect(prettifyTrackTitle('wonderland_ch_01', 'wonderland_ch_01_64kb.mp3')).toBe('Chapter 1');
  });

  it('drops track-number prefixes from filenames', () => {
    expect(prettifyTrackTitle(undefined, '03 - The Pool of Tears.mp3')).toBe('The Pool of Tears');
  });

  it('keeps bare numbers as they are written and title-cases the rest', () => {
    // A number alone is a chapter's (D74): called "Track 4", it would number a CD's track (D73).
    expect(prettifyTrackTitle(undefined, '04.mp3')).toBe('04');
    expect(numberedAs(prettifyTrackTitle(undefined, '04.mp3'))).toEqual({ counts: 'chapter', n: 4, through: 4 });
    expect(prettifyTrackTitle(undefined, 'side_a_opening.mp3')).toBe('Side A Opening');
    expect(prettifyTrackTitle('', 'track01.mp3')).toBe('Track 01');
  });

  it('names the nine usual namings of a chapter’s file, and numbers each as the chapter matching reads it (D74)', () => {
    // [tag, file name, the name shown, what that name numbers]
    const namings: [string | undefined, string, string, string | null][] = [
      [undefined, '01.mp3', '01', 'chapter:1'],
      [undefined, '1.mp3', '1', 'chapter:1'],
      [undefined, 'Track 01.mp3', 'Track 01', 'track:1'],
      ['01', 'alice.mp3', '01', 'chapter:1'],
      [undefined, 'alice_01_carroll_64kb.mp3', 'Alice 01 Carroll 64kb', 'chapter:1'],
      ['Chapter 01', 'a.mp3', 'Chapter 01', 'chapter:1'],
      [undefined, '01 - Down the Rabbit-Hole.mp3', 'Down the Rabbit-Hole', null],
      ['CHAPTER I', 'a.mp3', 'CHAPTER I', 'chapter:1'],
      ['Down the Rabbit-Hole', 'a.mp3', 'Down the Rabbit-Hole', null],
    ];
    for (const [tag, file, shown, numbers] of namings) {
      const name = prettifyTrackTitle(tag, file);
      expect(name, file).toBe(shown);
      const n = numberedAs(name);
      expect(n === null ? null : `${n.counts}:${n.n}`, file).toBe(numbers);
    }
  });
});

describe('small helpers', () => {
  it('filenameStem and tidyLabel', () => {
    expect(filenameStem('Audio/Book One/01 Intro.mp3')).toBe('01 Intro');
    expect(filenameStem('C:\\music\\a.b.mp3')).toBe('a.b');
    expect(tidyLabel('CHAPTER I.\n  Down the Rabbit-Hole ')).toBe('CHAPTER I. Down the Rabbit-Hole');
  });
});

describe('shortChapterName', () => {
  it('uses the chapter number when the title names one', () => {
    expect(shortChapterName('CHAPTER III. A Caucus-Race and a Long Tale')).toBe('Chapter 3');
    expect(shortChapterName('Chapter 12')).toBe('Chapter 12');
  });

  it('keeps short titles and trims long ones', () => {
    expect(shortChapterName('Contents')).toBe('Contents');
    expect(shortChapterName('THE MILLENNIUM FULCRUM EDITION 3.0 AND SOME MORE')).toBe('The Millennium Fulcrum Edition 3.0 and…');
  });

  it('names a stave or a canto as the book does, and a chapter beside its book by the chapter', () => {
    expect(shortChapterName('STAVE ONE. MARLEY’S GHOST.')).toBe('Stave 1');
    expect(shortChapterName('Canto XXXIV')).toBe('Canto 34');
    expect(shortChapterName('CHAPTER TWENTY-ONE LAURIE MAKES MISCHIEF')).toBe('Chapter 21');
    expect(shortChapterName('Book 2, Chapter 5')).toBe('Chapter 5');
    expect(shortChapterName('“On the Stairs.” CHAPTERXXVII.')).toBe('Chapter 27');
  });

  it('names a part, a book or a volume by its number when its title starts by numbering one (D86)', () => {
    expect(shortChapterName('PART II')).toBe('Part 2');
    expect(shortChapterName('BOOK ONE: 1805')).toBe('Book 1');
    expect(shortChapterName('Part the Second')).toBe('Part 2');
    expect(shortChapterName('VOLUME III.')).toBe('Volume 3');
    // A number further on is not the title's: a recording's part, or a title that only mentions one.
    expect(shortChapterName('Alice - Part 3')).toBe('Alice - Part 3');
    expect(shortChapterName('The Book of Thel 2')).toBe('The Book of Thel 2');
    expect(shortChapterName('FIRST EPILOGUE: 1813 - 20')).toBe('First Epilogue: 1813 - 20');
  });
});

describe('a title in capitals, as a label says it (D86)', () => {
  it('is in title case, its numerals and initials kept, a new title started after a full stop', () => {
    expect(calmCaps('IV. THE BOSCOMBE VALLEY MYSTERY')).toBe('IV. The Boscombe Valley Mystery');
    expect(calmCaps('NOTE TO THE THIRD EDITION')).toBe('Note to the Third Edition');
    expect(calmCaps('JONATHAN HARKER’S JOURNAL—A NEW START')).toBe('Jonathan Harker’s Journal—A New Start');
    expect(calmCaps('EXTRACTS (SUPPLIED BY A SUB-SUB-LIBRARIAN)')).toBe('Extracts (Supplied by a Sub-Sub-Librarian)');
    expect(calmCaps('LOUIS XIV AND THE U.S.A.')).toBe('Louis XIV and the U.S.A.');
    expect(calmCaps('THE MILLENNIUM FULCRUM EDITION 3.0 AND MORE')).toBe('The Millennium Fulcrum Edition 3.0 and More');
  });

  it('tells a book’s own lists, which name no place in its story', () => {
    for (const t of ['CONTENTS.', 'Table of Contents', 'List of Illustrations', ' ILLUSTRATIONS ']) expect(isBookList(t)).toBe(true);
    for (const t of ['Contents of the Second Drawer', 'PREFACE']) expect(isBookList(t)).toBe(false);
  });

  it('leaves a title with small letters, or spaced out letter by letter, as the book sets it', () => {
    expect(calmCaps('MOBY-DICK; or, THE WHALE.')).toBe('MOBY-DICK; or, THE WHALE.');
    expect(calmCaps('D R A C U L A')).toBe('D R A C U L A');
    expect(calmCaps('1805')).toBe('1805');
  });

  it('gives a chapter’s short name without shouting, up to a colon or a dash when long, with no full stop at its end', () => {
    expect(shortChapterName('FINALE.')).toBe('Finale');
    expect(shortChapterName('CHAPTER THE LAST')).toBe('Chapter the Last');
    expect(shortChapterName('Epilogue: “AND I ONLY AM ESCAPED ALONE TO TELL THEE.”')).toBe('Epilogue');
    // Up to 40 characters, a story's title whole (The Adventures of Sherlock Holmes).
    expect(shortChapterName('VIII. THE ADVENTURE OF THE SPECKLED BAND')).toBe('VIII. The Adventure of the Speckled Band');
    expect(shortChapterName('THERE ARE SEVERAL EDITIONS OF THIS EBOOK IN THE COLLECTION')).toBe('There Are Several Editions of This…');
    expect(shortChapterName('Mr.')).toBe('Mr.');
  });
});

describe('a chapter named by its numeral alone', () => {
  it('is a chapter in labels and in a heading (The Great Gatsby’s "I" to "IX")', () => {
    expect(shortChapterName('II')).toBe('Chapter 2');
    expect(shortChapterName('XII.')).toBe('Chapter 12');
    expect(shortChapterName('7')).toBe('Chapter 7');
    expect(chapterHeading('II')).toBe('Chapter II');
    expect(chapterHeading('XII.')).toBe('Chapter XII');
    // Anything more than a numeral is a title of its own.
    expect(shortChapterName('I. A SCANDAL IN BOHEMIA')).toBe('I. A Scandal in Bohemia');
    expect(chapterHeading('STAVE ONE. MARLEY’S GHOST.')).toBe('STAVE ONE. MARLEY’S GHOST.');
    expect(chapterHeading('Mix')).toBe('Mix');
    expect(shortChapterName('DIM')).toBe('Dim');
    expect(shortChapterName('CCCXL')).toBe('Chapter 340');
  });
});

describe('withoutCaption', () => {
  it('drops the caption an illustrated edition prints in a chapter’s heading', () => {
    // The illustrated Pride and Prejudice (Gutenberg #1342), as its contents name chapters.
    expect(withoutCaption('He rode a black horse. CHAPTER III.')).toBe('CHAPTER III.');
    expect(withoutCaption('“to assure you in the most animated language.” CHAPTER XIX.')).toBe('CHAPTER XIX.');
    expect(withoutCaption('“Lady Catherine, said she, you have given me a treasure.” CHAPTER XXIX')).toBe('CHAPTER XXIX');
    expect(withoutCaption('“On the Stairs.” CHAPTERXXVII.')).toBe('CHAPTER XXVII.');
  });

  it('keeps a title that only starts with its chapter, or names a part or a book before it', () => {
    for (const title of ['Chapter I.', 'STAVE ONE. MARLEY’S GHOST.', 'CHAPTER III. A Caucus-Race and a Long Tale', 'Part One. Chapter 1', 'Book 2, Chapter 5', 'The Last of the Spirits', 'Down the Rabbit-Hole'])
      expect(withoutCaption(title)).toBe(title);
  });
});

describe('a track’s name that only repeats its chapter’s (FR157)', () => {
  it('is LibriVox’s number and the chapter’s title, or the chapter’s number alone', () => {
    expect(namesChapter('01 - STORY OF THE DOOR', 'STORY OF THE DOOR')).toBe(true);
    expect(namesChapter('03 - The Pool of Tears', 'CHAPTER II. The Pool of Tears')).toBe(true);
    expect(namesChapter('Chapter 1', 'CHAPTER I. Down the Rabbit-Hole')).toBe(true);
    expect(namesChapter('Chapter 01 - Down the Rabbit-Hole', 'CHAPTER I. Down the Rabbit-Hole')).toBe(true);
    expect(namesChapter('Stave 1', 'STAVE ONE. MARLEY’S GHOST.')).toBe(true);
  });

  it('says more where it holds several chapters, numbers a part or another chapter, or names something else', () => {
    expect(namesChapter('Chapter 01 to 03', 'Story of the Door')).toBe(false);
    expect(namesChapter('Chapters 01 to 03', 'CHAPTER I. Down the Rabbit-Hole')).toBe(false);
    expect(namesChapter('Part 3', 'CHAPTER III.')).toBe(false);
    expect(namesChapter('Chapter 2', 'CHAPTER I. Down the Rabbit-Hole')).toBe(false);
    expect(namesChapter('Alice in Wonderland 05', 'CHAPTER V. Advice from a Caterpillar')).toBe(false);
    // A word that reads as a numeral is still a word.
    expect(namesChapter('The Mix', 'CHAPTER I. Down the Rabbit-Hole')).toBe(false);
  });
});

describe('a track’s name that is a chapter’s number alone (FR161)', () => {
  it('is the recording’s own count of its files, whatever chapter of the book it holds', () => {
    // LibriVox's Time Machine: "06 - Chapter 6" holds the book's chapter IX.
    for (const name of ['06 - Chapter 6', 'Chapter 6', 'Chapter I', 'CHAPTER IX', '07', 'Stave 2', 'Ch. 3']) expect(numbersOneChapter(name), name).toBe(true);
  });

  it('says more as a range, a part, a disc or a track, or with words of its own', () => {
    for (const name of ['Chapters 01 to 03', 'Part 3', 'Disc 2', 'Track 07', '01 - STORY OF THE DOOR', 'Chapter 1: Down the Rabbit-Hole', 'Alice in Wonderland 05', '13 - Epilogue']) {
      expect(numbersOneChapter(name), name).toBe(false);
    }
  });
});

describe('a track’s name tidied (FR164)', () => {
  it('drops a track number in front of a numbered name that is all the rest says, numbered as before', () => {
    const tidied: [string, string][] = [
      ['01 - Chapter I', 'Chapter I'],
      ['06 - Chapter 6', 'Chapter 6'],
      ['09 - Chapter 09', 'Chapter 09'],
      ['01 Chapter I', 'Chapter I'],
      ['1. Chapter One.', 'Chapter One.'],
      ['01 - Chapters 01 to 03', 'Chapters 01 to 03'],
      ['2 - Ch. 3', 'Ch. 3'],
      ['03 - Part 3', 'Part 3'],
    ];
    for (const [tag, shown] of tidied) {
      expect(tidyTrackTitle(tag), tag).toBe(shown);
      // The chapter matching reads it as it read the tag (numberedAs, D73, D74).
      expect(numberedAs(shown), tag).toEqual(numberedAs(tag));
      expect(chapterNumber(shown), tag).toBe(chapterNumber(tag));
    }
  });

  it('keeps any other name: the number its chapter is matched by, LibriVox’s titles as they stand', () => {
    for (const tag of ['01 - STORY OF THE DOOR', "01 - Stave 1: Marley's Ghost", '13 - Epilogue', '01 - Chapter Introduction', 'Chapter 01', '04', 'Part 3', 'Track 01', '1984']) expect(tidyTrackTitle(tag), tag).toBe(tag);
  });

  it('is how a tag is filled in for a track before it is lined up, on the upload form and on the server', () => {
    expect(['01 - Chapter I', '02 - Chapter II', '04 - Chapter 4', '13 - Epilogue'].map((tag, i) => prettifyTrackTitle(tag, `timemachine_${String(i + 1).padStart(2, '0')}_wells_64kb.mp3`))).toEqual([
      'Chapter I',
      'Chapter II',
      'Chapter 4',
      '13 - Epilogue',
    ]);
    expect(prettifyTrackTitle("01 - Stave 1: Marley's Ghost", 'christmascarol_1_dickens_64kb.mp3')).toBe("01 - Stave 1: Marley's Ghost");
  });
});
