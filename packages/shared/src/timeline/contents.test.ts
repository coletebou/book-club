import { describe, expect, it } from 'vitest';
import { type Publication } from '../api/schemas';
import { type ContentsEntry, MAX_FOLDED_SHARE, MIN_FRONT_CHARS, chaptersFromContents, readingContents } from './contents';

/** Entries in reading order: [title, m, depth, flags] with flags 'A' (alone) and 'C' (caption). */
function contents(rows: readonly (readonly [string, number, number, string?])[]): ContentsEntry[] {
  return rows.map(([title, m, depth, flags = '']) => ({ title, m, depth, alone: flags.includes('A'), caption: flags.includes('C') }));
}

const titles = (entries: readonly ContentsEntry[], story = { start: 0, end: 200_000 }) => chaptersFromContents(entries, story).map((c) => c.title);

describe('chapters from a book’s contents (D77)', () => {
  // Gutenberg's illustrated A Christmas Carol (#46), as its EPUB's contents and text are measured.
  const carol = contents([
    ['There are several editions of this ebook in the Project Gutenberg collection.', 1022, 0],
    ['A CHRISTMAS CAROL', 1623, 0, 'A'],
    ['IN PROSE', 1657, 0, 'A'],
    ['A Ghost Story of Christmas', 1713, 0, 'A'],
    ['CHARLES DICKENS', 1769, 0, 'A'],
    ['WITH ILLUSTRATIONS BY JOHN LEECH', 1807, 1, 'A'],
    ['PREFACE', 1864, 1],
    ['CONTENTS', 2263, 0],
    ['ILLUSTRATIONS', 2502, 0],
    ['STAVE ONE.', 3306, 0, 'A'],
    ['MARLEY’S GHOST.', 3321, 1],
    ['Marley’s Ghost', 31253, 1, 'C'],
    ['STAVE TWO.', 45701, 0, 'A'],
    ['THE FIRST OF THE THREE SPIRITS.', 45716, 1],
    ['Mr. Fezziwig’s Ball', 71120, 1, 'C'],
    ['STAVE THREE.', 85326, 0, 'A'],
    ['THE SECOND OF THE THREE SPIRITS.', 85343, 1],
    ['Scrooge’s Third Visitor', 91001, 1, 'C'],
    ['STAVE FOUR.', 138589, 0, 'A'],
    ['THE LAST OF THE SPIRITS.', 138605, 1],
    ['The Last of the Spirits', 171390, 1, 'C'],
    ['STAVE FIVE.', 172961, 0, 'A'],
    ['THE END OF IT.', 172977, 1],
    ['THE FULL PROJECT GUTENBERG™ LICENSE', 189167, 0],
  ]);
  const carolStory = { start: 1021, end: 187763 };

  it('takes a stave’s subtitle and pictures into it: five staves, each under its own name, ending where the next begins', () => {
    const chapters = chaptersFromContents(carol, carolStory);
    const staves = chapters.filter((c) => c.title.startsWith('STAVE'));
    expect(staves.map((c) => [c.title, c.m])).toEqual([
      ['STAVE ONE. MARLEY’S GHOST.', 3306],
      ['STAVE TWO. THE FIRST OF THE THREE SPIRITS.', 45701],
      ['STAVE THREE. THE SECOND OF THE THREE SPIRITS.', 85326],
      ['STAVE FOUR. THE LAST OF THE SPIRITS.', 138589],
      ['STAVE FIVE. THE END OF IT.', 172961],
    ]);
    // No picture and no subtitle is a chapter, so the last stave ends with the story, not 16 characters on.
    for (const name of ['Marley’s Ghost', 'Scrooge’s Third Visitor', 'THE END OF IT.', 'MARLEY’S GHOST.']) expect(chapters.map((c) => c.title)).not.toContain(name);
    // The licence after the story is joined to nothing.
    expect(chapters.at(-1)).toMatchObject({ title: 'THE FULL PROJECT GUTENBERG™ LICENSE', m: 189167 });
  });

  it('keeps the front matter as it is listed, a title page’s lines taken into the heading they sit under', () => {
    expect(titles(carol, carolStory).slice(0, 7)).toEqual([
      'There are several editions of this ebook in the Project Gutenberg collection.',
      'A CHRISTMAS CAROL',
      'IN PROSE',
      'A Ghost Story of Christmas',
      'CHARLES DICKENS: WITH ILLUSTRATIONS BY JOHN LEECH',
      'CONTENTS',
      'ILLUSTRATIONS',
    ]);
  });

  it('takes the same stave as one chapter when its contents list heading and subtitle side by side', () => {
    const flat = contents([
      ['STAVE ONE.', 3306, 0, 'A'],
      ['MARLEY’S GHOST.', 3321, 0],
      ['STAVE TWO.', 45701, 0, 'A'],
      ['THE FIRST OF THE THREE SPIRITS.', 45716, 0],
    ]);
    expect(chaptersFromContents(flat, carolStory).map((c) => [c.title, c.m])).toEqual([
      ['STAVE ONE. MARLEY’S GHOST.', 3306],
      ['STAVE TWO. THE FIRST OF THE THREE SPIRITS.', 45701],
    ]);
  });

  it('takes a story’s parts into the story (The Adventures of Sherlock Holmes)', () => {
    const sherlock = contents([
      ['Contents', 1099, 0],
      ['I. A SCANDAL IN BOHEMIA', 1540, 0, 'A'],
      ['I.', 1565, 1],
      ['II.', 20791, 1],
      ['III.', 42267, 1],
      ['II. THE RED-HEADED LEAGUE', 48189, 0],
      ['III. A CASE OF IDENTITY', 97636, 0],
    ]);
    expect(titles(sherlock, { start: 947, end: 565214 })).toEqual(['Contents', 'I. A SCANDAL IN BOHEMIA', 'II. THE RED-HEADED LEAGUE', 'III. A CASE OF IDENTITY']);
  });

  it('keeps a part’s chapters, and the part, when they are listed under it', () => {
    const nested = contents([
      ['PART ONE', 1000, 0, 'A'],
      ['Chapter 1', 1010, 1],
      ['Chapter 2', 20_000, 1],
      ['PART TWO', 40_000, 0, 'A'],
      ['Chapter 3', 40_010, 1],
    ]);
    expect(titles(nested, { start: 0, end: 60_000 })).toEqual(['PART ONE', 'Chapter 1', 'Chapter 2', 'PART TWO', 'Chapter 3']);
    // A heading over numbered chapters keeps them whatever it is called.
    const book = contents([
      ['Alice’s Adventures in Wonderland', 900, 0, 'A'],
      ['CHAPTER I. Down the Rabbit-Hole', 950, 1],
      ['CHAPTER II. The Pool of Tears', 12_000, 1],
    ]);
    expect(titles(book, { start: 900, end: 24_000 })).toEqual(['Alice’s Adventures in Wonderland', 'CHAPTER I. Down the Rabbit-Hole', 'CHAPTER II. The Pool of Tears']);
  });

  it(`never takes in more than ${MAX_FOLDED_SHARE * 100} % of the story: a title over unnumbered chapters keeps them`, () => {
    const wrapped = contents([
      ['The Little Book', 0, 0, 'A'],
      ['Down the Lane', 20, 1],
      ['The Garden', 30_000, 1],
      ['Home Again', 60_000, 1],
    ]);
    expect(titles(wrapped, { start: 0, end: 90_000 })).toEqual(['The Little Book', 'Down the Lane', 'The Garden', 'Home Again']);
  });

  it('takes nothing in under a heading that holds text of its own', () => {
    // Great Expectations: chapter XIX's last line is listed under it, and stays as it is.
    const ge = contents([
      ['Chapter XIX.', 299_541, 0],
      ['THIS IS THE END OF THE FIRST STAGE OF PIP’S EXPECTATIONS.', 330_165, 1, 'A'],
      ['Chapter XX.', 330_225, 0],
    ]);
    expect(titles(ge, { start: 880, end: 998_458 })).toEqual(['Chapter XIX.', 'THIS IS THE END OF THE FIRST STAGE OF PIP’S EXPECTATIONS.', 'Chapter XX.']);
  });

  it('takes the caption out of a chapter’s title (the illustrated Pride and Prejudice)', () => {
    const pp = contents([
      ['Chapter I.', 29_772, 0],
      ['I hope Mr. Bingley will like it. CHAPTER II.', 34_397, 0],
      ['He rode a black horse. CHAPTER III.', 38_765, 0],
      ['“On the Stairs.” CHAPTERXXVII.', 294_801, 0],
    ]);
    expect(titles(pp, { start: 991, end: 717_702 })).toEqual(['Chapter I.', 'CHAPTER II.', 'CHAPTER III.', 'CHAPTER XXVII.']);
  });

  it('keeps a picture’s heading that numbers a chapter, and the first entry whatever it is', () => {
    const odd = contents([
      ['Frontispiece', 0, 0, 'C'],
      ['CHAPTER I.', 500, 0, 'C'],
      ['A picture', 9000, 0, 'C'],
    ]);
    expect(titles(odd, { start: 0, end: 20_000 })).toEqual(['Frontispiece', 'CHAPTER I.']);
  });

  it('takes contents without hints as they are, but for captions in titles', () => {
    const plain: ContentsEntry[] = [
      { title: 'STAVE ONE.', m: 0, depth: 0 },
      { title: 'MARLEY’S GHOST.', m: 15, depth: 0 },
      { title: 'He rode a black horse. CHAPTER III.', m: 900, depth: 0 },
    ];
    expect(titles(plain, { start: 0, end: 2000 })).toEqual(['STAVE ONE.', 'MARLEY’S GHOST.', 'CHAPTER III.']);
    expect(chaptersFromContents([], { start: 0, end: 0 })).toEqual([]);
  });
});

describe('what of a book’s contents is reading (D86, D110)', () => {
  /** A publication of one document of `total` characters whose contents are these entries: [title, offset, depth, chapter]. */
  const publication = (total: number, rows: readonly (readonly [string, number, number?, boolean?])[], story: Publication['story'], backMatter?: Publication['backMatter']) =>
    ({
      sections: [{ index: 0, href: 'a.xhtml', textLength: total, linear: true }],
      toc: rows.map(([title, offset, depth = 0, chapter]) => ({ title, href: 'a.xhtml', section: 0, offset, depth, ...(chapter === false ? { chapter } : {}) })),
      story,
      ...(backMatter ? { backMatter } : {}),
    }) as Pick<Publication, 'sections' | 'toc' | 'story' | 'backMatter'>;

  // Gutenberg's Jekyll and Hyde (#43): a title page and its contents before Story of the Door.
  const jekyll = publication(
    158_907,
    [
      ['The Strange Case Of Dr. Jekyll And Mr. Hyde', 930],
      ['Contents', 1004],
      ['STORY OF THE DOOR', 1240],
      ['SEARCH FOR MR. HYDE', 13_000],
      ['DR. JEKYLL WAS QUITE AT EASE', 29_000],
      ['HENRY JEKYLL’S FULL STATEMENT OF THE CASE', 110_000],
      ['THE FULL PROJECT GUTENBERG™ LICENSE', 141_000],
    ],
    { start: 927, end: 140_430 },
  );

  it('lists the story’s chapters, not its title page, its printed contents or the licence after it', () => {
    const { listed, after } = readingContents(jekyll);
    expect(listed.map((i) => jekyll.toc[i]!.title)).toEqual(['STORY OF THE DOOR', 'SEARCH FOR MR. HYDE', 'DR. JEKYLL WAS QUITE AT EASE', 'HENRY JEKYLL’S FULL STATEMENT OF THE CASE']);
    expect(after).toEqual([]);
  });

  it('says what of the story is no reading: the front matter’s scraps and printed contents, from the story’s start to its first chapter', () => {
    expect(readingContents(jekyll).unread).toEqual([
      { start: 927, end: 930 },
      { start: 930, end: 1004 },
      { start: 1004, end: 1240 },
    ]);
  });

  it('keeps a preface: two pages and more of front matter, not the book’s own list, is reading', () => {
    const book = publication(
      50_000,
      [
        ['A Book', 0],
        ['PREFACE', 100],
        ['CONTENTS', 100 + MIN_FRONT_CHARS],
        ['CHAPTER I.', 200 + MIN_FRONT_CHARS],
        ['CHAPTER II.', 25_000],
      ],
      { start: 0, end: 50_000 },
    );
    const { listed, unread } = readingContents(book);
    expect(listed.map((i) => book.toc[i]!.title)).toEqual(['PREFACE', 'CHAPTER I.', 'CHAPTER II.']);
    expect(unread).toEqual([
      { start: 0, end: 100 },
      { start: 100 + MIN_FRONT_CHARS, end: 200 + MIN_FRONT_CHARS },
    ]);
  });

  it('lists the book’s own matter after the story apart, at the shallowest level it lists', () => {
    const book = publication(
      60_000,
      [
        ['Chapter 1', 0],
        ['Chapter 2', 25_000],
        ['Endnotes', 50_000],
        ['1', 50_100, 1],
        ['2', 50_200, 1],
        ['Colophon', 58_000, 0, false],
      ],
      { start: 0, end: 50_000 },
      { start: 50_000, end: 60_000 },
    );
    const { listed, after, unread } = readingContents(book);
    expect(listed.map((i) => book.toc[i]!.title)).toEqual(['Chapter 1', 'Chapter 2']);
    expect(after.map((i) => book.toc[i]!.title)).toEqual(['Endnotes', 'Colophon']);
    expect(unread).toEqual([]);
  });
});
