import { type Chapter, chapterLabel, mToT, prettifyTrackTitle } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { isGenericChapterName, learnChapterNames } from '../src/ingest/chapter-names';
import { placeOnTimeline } from '../src/ingest/pipeline';
import { type BookRow, type EditionRow } from '../src/repos/books';

const alice = { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' };

describe('isGenericChapterName', () => {
  it.each([
    // A number, and words that say what it counts.
    'Chapter 7',
    'CHAPTER 7',
    'Chapter 07',
    'Chapter VII',
    'chapter vii',
    'Chapter Seven',
    'Chapter Twenty-One',
    'Ch. 7',
    'Ch07',
    'Chap. 7',
    'Chapter 1 of 12',
    '1st Chapter',
    'Chapter 0001',
    'Track 07',
    'Track 4',
    'Track 1a',
    'track01',
    'Part 3',
    'Part III',
    'Part Three',
    'Book the First',
    'Book 2, Chapter 5',
    'Disc 1 Track 3',
    'CD2 - 05',
    'Side B 2',
    'Act 1, Scene 2',
    'Page 4',
    'Kapitel 3',
    'Capítulo 3',
    'Untitled 3',
    // A number alone.
    '07',
    '7',
    '1.',
    'XII',
    '',
    // A file's name, or the book's own title or author around a number.
    'wonderland_ch_07_64kb',
    'wonderland_ch_07_64kb.mp3',
    'aliceinwonderland_01_carroll_64kb',
    'Alice In Wonderland 07',
    'AliceInWonderland07',
    'Alice in Wonderland - Track 7',
    'Lewis Carroll - 03',
  ])('“%s” only numbers its chapter', (name) => {
    expect(isGenericChapterName(name, alice)).toBe(true);
  });

  it.each([
    'CHAPTER III. A Caucus-Race and a Long Tale',
    'Chapter XII. Alice’s Evidence',
    'Chapter 1: Down the Rabbit-Hole',
    'Chapter One: The Start',
    '3. A Caucus-Race',
    'The Pool of Tears 2',
    'Down the Rabbit-Hole',
    'Prologue',
    'Introduction',
    'Opening Credits',
    'Side A Opening',
    'Catch-22',
    // Words that count, or a book's title, without a number.
    'The Track',
    'The Letter',
    'Book',
    "Alice's Adventures in Wonderland",
    'down_the_rabbit_hole',
    // Names that read as Roman numerals only in capitals or after a word that counts.
    'Liv',
    'Mix',
  ])('“%s” is a real name', (name) => {
    expect(isGenericChapterName(name, alice)).toBe(false);
  });

  it('counts the book’s own title and author as part of a numbered name, not other books’', () => {
    const glass = { title: 'Through the Looking-Glass', author: 'Lewis Carroll' };
    expect(isGenericChapterName('Alice 07', alice)).toBe(true);
    expect(isGenericChapterName('Alice 07', glass)).toBe(false);
    expect(isGenericChapterName('Carroll 07', glass)).toBe(true);
    // A file's name is generic whatever else it says.
    expect(isGenericChapterName('wonderland_ch_07_64kb', glass)).toBe(true);
  });

  it('finds generic what the track list makes of numbered files, and real what it finds in their names', () => {
    const made = (file: string, tag?: string) => prettifyTrackTitle(tag, file);
    for (const name of [made('wonderland_ch_07_64kb.mp3', 'wonderland_ch_07'), made('07.mp3'), made('track01.mp3', ''), made('alice_in_wonderland_07.mp3')]) {
      expect(isGenericChapterName(name, alice), name).toBe(true);
    }
    expect(isGenericChapterName(made('03 - The Pool of Tears.mp3'), alice)).toBe(false);
    expect(isGenericChapterName(made('a.mp3', 'Chapter 1: Down the Rabbit-Hole'), alice)).toBe(false);
  });
});

describe('learnChapterNames', () => {
  const numbered: Chapter[] = [
    { index: 0, title: 'Chapter 1', t: 0 },
    { index: 1, title: 'Chapter 2', t: 0.3 },
    { index: 2, title: 'Chapter 3', t: 0.6 },
  ];

  it('names a chapter known only by number after the unit matched with it, in its place', () => {
    const named = learnChapterNames(numbered, [{ chapter: 2, title: 'CHAPTER III. A Caucus-Race and a Long Tale' }], alice);
    expect(named).toEqual([numbered[0], numbered[1], { index: 2, title: 'CHAPTER III. A Caucus-Race and a Long Tale', t: 0.6 }]);
    // The chapters it was given are as they were.
    expect(numbered[2]).toEqual({ index: 2, title: 'Chapter 3', t: 0.6 });
  });

  it('never replaces a real name, nor learns a generic one or one that numbers another chapter', () => {
    const prologue: Chapter[] = [{ index: 0, title: 'Prologue', t: 0 }, ...numbered.slice(1)];
    const offered = [
      { chapter: 0, title: 'CHAPTER I. Down the Rabbit-Hole' },
      { chapter: 1, title: 'Track 02' },
      { chapter: 2, title: 'CHAPTER IV. The Rabbit Sends in a Little Bill' },
    ];
    expect(learnChapterNames(prologue, offered, alice)).toBeNull();
    expect(learnChapterNames(numbered, [{ chapter: 7, title: 'CHAPTER VIII. The Queen’s Croquet-Ground' }], alice)).toBeNull();
  });

  it('learns a name that gives no number, as a text whose contents only name its chapters does', () => {
    expect(learnChapterNames(numbered, [{ chapter: 2, title: 'A Caucus-Race and a Long Tale' }], alice)![2]).toEqual({ index: 2, title: 'A Caucus-Race and a Long Tale', t: 0.6 });
    const filed: Chapter[] = [{ index: 0, title: 'aliceinwonderland_01_carroll_64kb', t: 0 }];
    expect(learnChapterNames(filed, [{ chapter: 0, title: 'Down the Rabbit-Hole' }], alice)).toEqual([{ index: 0, title: 'Down the Rabbit-Hole', t: 0 }]);
  });

  it('learns a name once: the first real one offered stays', () => {
    const offered = [
      { chapter: 2, title: 'CHAPTER III. A Caucus-Race and a Long Tale' },
      { chapter: 2, title: 'Chapter 3: Another Edition’s Name' },
    ];
    const once = learnChapterNames(numbered, offered, alice)!;
    expect(once[2]!.title).toBe('CHAPTER III. A Caucus-Race and a Long Tale');
    expect(learnChapterNames(once, [{ chapter: 2, title: 'Chapter 3: Another Edition’s Name' }], alice)).toBeNull();
  });
});

describe('placeOnTimeline with chapters known only by number', () => {
  const book = (chapters: readonly Chapter[], over: Partial<BookRow> = {}): BookRow => ({
    id: 'book1',
    club_id: 'club1',
    title: alice.title,
    author: alice.author,
    cover_blob_id: null,
    reference_edition_id: chapters.length > 0 ? 'audio' : null,
    chapters_json: JSON.stringify(chapters),
    created_by: 'u1',
    created_at: 0,
    ...over,
  });
  const edition = (id: string, status: EditionRow['status'] = 'ready'): EditionRow => ({
    id,
    book_id: 'book1',
    kind: id === 'audio' ? 'audio' : 'epub',
    status,
    error: null,
    geometry_json: null,
    units_json: '[]',
    sync_json: null,
    alignment_json: '{"method":"none","unitToChapter":[]}',
    meta_json: '{}',
    size_bytes: 0,
    created_by: 'u1',
    created_at: 0,
  });
  type Ingested = Parameters<typeof placeOnTimeline>[3];
  const ingested = (units: { title: string; m: number }[], end: number): Ingested => ({
    geometry: { kind: 'epub', sectionLengths: [end] },
    units,
    story: { start: 0, end },
    meta: {},
  });
  // Three tracks named after their files, the book's first format: its chapters are theirs.
  const tracks = [
    { title: 'Chapter 1', m: 0 },
    { title: 'Chapter 2', m: 4000 },
    { title: 'Chapter 3', m: 9000 },
  ];
  const numbered = placeOnTimeline(book([]), [edition('audio', 'processing')], 'audio', ingested(tracks, 12_000)).chapters!;
  const text = [
    { title: 'Contents', m: 0 },
    { title: 'CHAPTER I. Down the Rabbit-Hole', m: 100 },
    { title: 'CHAPTER II. The Pool of Tears', m: 1100 },
    { title: 'CHAPTER III. A Caucus-Race and a Long Tale', m: 2100 },
  ];

  it('a text matched to them by number names them, moving nothing', () => {
    expect(numbered.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    const placement = placeOnTimeline(book(numbered), [edition('audio'), edition('text', 'processing')], 'text', ingested(text, 3000));
    expect(placement.alignment).toEqual({ method: 'number', unitToChapter: [null, 0, 1, 2] });
    expect(placement.chapters).toEqual(numbered.map((c, i) => ({ ...c, title: text[i + 1]!.title })));
    // Each chapter of the text starts where the chapter it names starts, as it did before.
    for (const [i, c] of numbered.entries()) expect(mToT(placement.sync, text[i + 1]!.m)).toBeCloseTo(c.t, 12);
    // A member's label stays "Chapter 3 · …": the name learned numbers the same chapter.
    expect(chapterLabel(placement.chapters!, 0.8)).toBe(chapterLabel(numbered, 0.8));
  });

  it('a text whose contents only name its chapters, matched one to one, names them too', () => {
    const names = ['Down the Rabbit-Hole', 'The Pool of Tears', 'A Caucus-Race and a Long Tale'];
    const placement = placeOnTimeline(book(numbered), [edition('audio'), edition('text', 'processing')], 'text', ingested(names.map((title, i) => ({ title, m: i * 1000 })), 3000));
    expect(placement.alignment).toEqual({ method: 'count', unitToChapter: [0, 1, 2] });
    expect(placement.chapters).toEqual(numbered.map((c, i) => ({ ...c, title: names[i] })));
  });

  it('a third format with names of its own changes none of them', () => {
    const named = placeOnTimeline(book(numbered), [edition('audio'), edition('text', 'processing')], 'text', ingested(text, 3000)).chapters!;
    const pdf = [
      { title: 'Chapter 1: Somewhere Else', m: 0 },
      { title: 'Chapter 2: Further On', m: 30 },
      { title: 'Chapter 3: The Last of It', m: 75 },
    ];
    const third = placeOnTimeline(book(named), [edition('audio'), edition('text'), edition('pdf', 'processing')], 'pdf', ingested(pdf, 100));
    expect(third.alignment.method).toBe('count');
    expect(third.chapters).toBeNull();
    // Nor does the same text, read again.
    expect(placeOnTimeline(book(named), [edition('audio'), edition('text', 'processing')], 'text', ingested(text, 3000)).chapters).toBeNull();
  });

  it('the first format, read again, keeps the names its chapters learned where they still are', () => {
    const named = placeOnTimeline(book(numbered), [edition('audio'), edition('text', 'processing')], 'text', ingested(text, 3000)).chapters!;
    // The text is gone, or not ready: the audiobook is the book's first format again.
    const again = placeOnTimeline(book(named), [edition('audio', 'processing')], 'audio', ingested(tracks, 12_000));
    expect(again.alignment.method).toBe('reference');
    expect(again.chapters).toEqual(named);
    // A chapter that has moved is a chapter of its own: it has the edition's name for it.
    const moved = placeOnTimeline(book(named), [edition('audio', 'processing')], 'audio', ingested([tracks[0]!, tracks[1]!, { title: 'Chapter 3', m: 9600 }], 12_000));
    expect(moved.chapters!.map((c) => c.title)).toEqual(['CHAPTER I. Down the Rabbit-Hole', 'CHAPTER II. The Pool of Tears', 'Chapter 3']);
  });
});
