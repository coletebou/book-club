import { describe, expect, it } from 'vitest';
import type { Chapter, Edition } from '@bookclub/shared';
import { chapterAt, chapterNamedAt, chapterOfTrack, chaptersHeld, chaptersInTrack, listEntries, severalUnheard, trackLabel, trackName, unitIndexAtM } from './tracks';

const track = (index: number, durationMs: number, chapter: number | null = null, heard?: { chapter: number; ms: number }[]) => ({
  index,
  title: `Track ${index + 1}`,
  durationMs,
  url: `/t${index}`,
  mime: 'audio/mpeg',
  chapter,
  ...(heard ? { chapters: heard } : {}),
});
const edition = (tracks: ReturnType<typeof track>[], units: { title: string; m: number }[]) => ({ tracks, units }) as unknown as Edition;
const chapters: Chapter[] = [
  { index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0 },
  { index: 1, title: 'CHAPTER II. The Pool of Tears', t: 0.5 },
];

describe('listEntries (the player’s list)', () => {
  it('lists the tracks, named after the chapters they start', () => {
    const e = edition([track(0, 60_000, 0), track(1, 90_000, 1)], [{ title: 'Track 1', m: 0 }, { title: 'Track 2', m: 60_000 }]);
    expect(listEntries(e, chapters)).toEqual([
      { title: 'CHAPTER I. Down the Rabbit-Hole', track: 0, ms: 0, durationMs: 60_000 },
      { title: 'CHAPTER II. The Pool of Tears', track: 1, ms: 0, durationMs: 90_000 },
    ]);
  });

  it('lists the chapters inside a single-file audiobook, each at its place in the file', () => {
    const e = edition([track(0, 12_000)], [{ title: 'One', m: 0 }, { title: 'Two', m: 4_000 }, { title: 'Three', m: 8_000 }]);
    expect(listEntries(e, chapters)).toEqual([
      { title: 'One', track: 0, ms: 0, durationMs: 4_000 },
      { title: 'Two', track: 0, ms: 4_000, durationMs: 4_000 },
      { title: 'Three', track: 0, ms: 8_000, durationMs: 4_000 },
    ]);
  });

  it('finds the track of each chapter when several files have chapters inside', () => {
    const e = edition([track(0, 10_000), track(1, 10_000)], [{ title: 'A', m: 0 }, { title: 'B', m: 5_000 }, { title: 'C', m: 10_000 }, { title: 'D', m: 15_000 }]);
    expect(listEntries(e, chapters).map((x) => [x.title, x.track, x.ms, x.durationMs])).toEqual([
      ['A', 0, 0, 5_000],
      ['B', 0, 5_000, 5_000],
      ['C', 1, 0, 5_000],
      ['D', 1, 5_000, 5_000],
    ]);
  });
});

describe('a track that holds several chapters (FR152)', () => {
  // LibriVox's four-track Jekyll and Hyde: "Chapter 01 to 03", "Chapter 04 to 07", … lined up
  // sentence by sentence, which hears where each chapter starts in its track.
  const jekyll: Chapter[] = ['Story of the Door', 'Search for Mr. Hyde', 'Dr. Jekyll Was Quite at Ease', 'The Carew Murder Case', 'Incident of the Letter'].map((title, index) => ({ index, title, t: index / 5 }));
  const tracks = [
    { ...track(0, 2_583_000, null, [{ chapter: 0, ms: 32_000 }, { chapter: 1, ms: 980_000 }, { chapter: 2, ms: 2_190_000 }]), title: 'Chapter 01 to 03' },
    { ...track(1, 2_300_000, null, [{ chapter: 3, ms: 30_000 }]), title: 'Chapter 04 to 07' },
  ];
  const e = { ...edition(tracks, [{ title: 'Chapter 01 to 03', m: 0 }, { title: 'Chapter 04 to 07', m: 2_583_000 }]), alignment: { method: 'forced', unitToChapter: [null, null] } } as unknown as Edition;

  it('lists those chapters under the track, each at its start in it; a track of one chapter is as it was', () => {
    expect(listEntries(e, jekyll).map((x) => [x.title, x.track, x.ms, x.durationMs, x.depth ?? 0])).toEqual([
      ['Chapter 01 to 03', 0, 0, 2_583_000, 0],
      ['Story of the Door', 0, 32_000, 948_000, 1],
      ['Search for Mr. Hyde', 0, 980_000, 1_210_000, 1],
      ['Dr. Jekyll Was Quite at Ease', 0, 2_190_000, 393_000, 1],
      ['Chapter 04 to 07', 1, 0, 2_300_000, 0],
    ]);
    expect(chaptersInTrack(e, 1)).toEqual([]);
  });

  it('names the chapter being heard, its opening words its first chapter’s', () => {
    expect([0, 31_000, 32_000, 979_000, 980_000, 2_500_000].map((ms) => chapterAt(e, 0, ms))).toEqual([0, 0, 0, 0, 1, 2]);
    // A track of one chapter heard, with no chapter matched to it: that chapter (FR161), where it
    // was nothing before (the player named the track's tag).
    expect(chapterAt(e, 1, 100_000)).toBe(3);
    // A track that opens inside a chapter (a book cut into parts): before the first chapter heard
    // well into it, the chapter before goes on.
    const parts = { ...e, tracks: [tracks[0], track(1, 2_000_000, null, [{ chapter: 3, ms: 600_000 }, { chapter: 4, ms: 1_500_000 }])] } as unknown as Edition;
    expect(chapterAt(parts, 1, 100_000)).toBe(2);
    expect(chapterAt(parts, 1, 700_000)).toBe(3);
    expect(chapterAt(parts, 1, 1_600_000)).toBe(4);
  });
});

describe('a track that says it holds several chapters, none heard yet (FR152)', () => {
  // Matched by its first number ("Chapters 04 to 06" starts CHAPTER IV), with no read-along yet.
  const alice: Chapter[] = ['CHAPTER I.', 'CHAPTER II.', 'CHAPTER III.', 'CHAPTER IV.'].map((title, index) => ({ index, title, t: index / 4 }));
  const e = {
    ...edition([{ ...track(0, 60_000, 0), title: 'Chapters 01 to 03' }, { ...track(1, 30_000, 3), title: 'Chapter 4' }], [{ title: 'Chapters 01 to 03', m: 0 }, { title: 'Chapter 4', m: 60_000 }]),
    alignment: { method: 'number', unitToChapter: [0, 3] },
  } as unknown as Edition;

  it('goes by its own name in the list and in the player, which cannot tell which of them plays', () => {
    expect(listEntries(e, alice).map((x) => x.title)).toEqual(['Chapters 01 to 03', 'CHAPTER IV.']);
    expect(severalUnheard(e, 0)).toBe(true);
    expect(chapterNamedAt(e, 0, 40_000)).toBeNull();
    // Where it starts on the timeline is still its first chapter, as the club's places say.
    expect(chapterAt(e, 0, 40_000)).toBe(0);
    expect([severalUnheard(e, 1), chapterNamedAt(e, 1, 10_000)]).toEqual([false, 3]);
  });
});

describe('the chapter playing', () => {
  const withAlignment = (e: Edition, unitToChapter: (number | null)[]) => ({ ...e, alignment: { method: 'number', unitToChapter } }) as unknown as Edition;

  it('finds the unit at a place, in order, before the first none', () => {
    const units = [{ m: 1_000 }, { m: 5_000 }, { m: 9_000 }];
    expect([0, 1_000, 4_999, 5_000, 8_000, 9_000, 20_000].map((m) => unitIndexAtM(units, m))).toEqual([-1, 0, 0, 1, 1, 2, 2]);
    expect(unitIndexAtM([], 3_000)).toBe(-1);
  });

  it('follows the chapters inside a file as it plays (an M4B), not just the file’s first', () => {
    const e = withAlignment(edition([track(0, 12_000, 0)], [{ title: 'One', m: 0 }, { title: 'Two', m: 4_000 }, { title: 'Three', m: 8_000 }]), [0, 1, 2]);
    expect([0, 3_999, 4_000, 11_000].map((ms) => chapterAt(e, 0, ms))).toEqual([0, 0, 1, 2]);
  });

  it('counts the files before, and knows a part with no chapter (an introduction outside the story)', () => {
    const e = withAlignment(edition([track(0, 10_000), track(1, 10_000), track(2, 10_000)], [{ title: 'Intro', m: 0 }, { title: 'A', m: 10_000 }, { title: 'B', m: 20_000 }]), [null, 0, 1]);
    expect([chapterAt(e, 0, 5_000), chapterAt(e, 1, 0), chapterAt(e, 2, 9_999)]).toEqual([null, 0, 1]);
  });
});

describe('each track named by the chapter it holds, once lined up (FR160, FR161)', () => {
  // The Time Machine (Gutenberg #35) as a club's LibriVox recording of it is lined up sentence by
  // sentence: its tags number its own files ("06 - Chapter 6" holds the book's chapter IX), so no
  // chapter is matched to a track, and the read-along says which chapter each opens with.
  const tm: Chapter[] = [
    'The Time Machine', 'CONTENTS', 'I. Introduction', 'II. The Machine', 'III. The Time Traveller Returns', 'IV. Time Travelling', 'V. In the Golden Age',
    'VI. The Sunset of Mankind', 'VII. A Sudden Shock', 'VIII. Explanation', 'IX. The Morlocks', 'X. When Night Came',
  ].map((title, index) => ({ index, title, t: index / 12 }));
  const tagged = (index: number, title: string, durationMs: number, chapter: number | null, heard?: { chapter: number; ms: number }[]) => ({ ...track(index, durationMs, chapter, heard), title });
  const tracks = [
    tagged(0, '01 - Chapter I', 1_290_580, 2, [{ chapter: 2, ms: 14_540 }, { chapter: 3, ms: 746_600 }]),
    tagged(1, '02 - Chapter II', 839_837, 4, [{ chapter: 4, ms: 1_080 }]),
    tagged(2, '06 - Chapter 6', 866_952, 10, [{ chapter: 10, ms: 23_060 }]),
    // A file going on with a chapter begun in the one before: none heard starting in it.
    tagged(3, '07 - Chapter 7', 600_000, 10),
    // One the recogniser heard nothing of: nothing better than its tag is known.
    tagged(4, '09 - Chapter 09', 700_000, null),
  ];
  const e = {
    ...edition(tracks, tracks.map((tr, i) => ({ title: tr.title, m: i * 1_000_000 }))),
    alignment: { method: 'forced', unitToChapter: tracks.map(() => null) },
  } as unknown as Edition;

  it('lists a track of one chapter by that chapter, a track of several with them under it, and the tag, tidied, where nothing is known', () => {
    expect(listEntries(e, tm).map((x) => [x.title, x.track, x.ms, x.depth ?? 0])).toEqual([
      ['Chapter I', 0, 0, 0],
      ['I. Introduction', 0, 14_540, 1],
      ['II. The Machine', 0, 746_600, 1],
      ['III. The Time Traveller Returns', 1, 0, 0],
      ['IX. The Morlocks', 2, 0, 0],
      ['IX. The Morlocks', 3, 0, 0],
      ['Chapter 09', 4, 0, 0],
    ]);
    expect([0, 1, 2, 3, 4].map((i) => chapterOfTrack(e, i))).toEqual([null, 4, 10, 10, null]);
  });

  it('names the chapter heard in the title and on the lock screen, its announcement included, and the tag tidied where none is', () => {
    // "06 - Chapter 6", at 0:00 (LibriVox's preamble), at its first sentence and later: IX.
    expect([0, 23_060, 400_000].map((ms) => chapterNamedAt(e, 2, ms))).toEqual([10, 10, 10]);
    expect(chapterNamedAt(e, 3, 100_000)).toBe(10);
    expect([0, 746_599, 746_600].map((ms) => chapterNamedAt(e, 0, ms))).toEqual([2, 2, 3]);
    expect(chapterNamedAt(e, 4, 1_000)).toBeNull();
    expect([0, 2, 4].map((i) => trackName(e, i))).toEqual(['Chapter I', 'Chapter 6', 'Chapter 09']);
    // Where a note is pinned, "1:09 in …": the track as the list calls it.
    expect([0, 2, 3, 4].map((i) => trackLabel(e, tm, i))).toEqual(['Chapter I', 'IX. The Morlocks', 'IX. The Morlocks', 'Chapter 09']);
  });

  it('a track opening with the end of a chapter, another heard starting in it, holds both: the one going on first', () => {
    const parts: Edition = { ...e, tracks: [tagged(0, 'Part 3', 2_000_000, 5, [{ chapter: 6, ms: 40_000 }])], units: [{ title: 'Part 3', m: 0 }] };
    expect(chaptersHeld(parts, 0)).toEqual([{ chapter: 5, ms: 0 }, { chapter: 6, ms: 40_000 }]);
    expect([0, 39_999, 40_000].map((ms) => chapterAt(parts, 0, ms))).toEqual([5, 5, 6]);
    expect(listEntries(parts, tm).map((x) => [x.title, x.ms, x.depth ?? 0])).toEqual([
      ['Part 3', 0, 0],
      ['V. In the Golden Age', 40_000, 1],
    ]);
  });

  it('lists the demo’s LibriVox Alice a chapter a track, none twice, its closing words under the chapter it ends (FR160)', () => {
    const alice: Chapter[] = ['Alice’s Adventures in Wonderland', 'THE MILLENNIUM FULCRUM EDITION 3.0', 'Contents', 'CHAPTER I. Down the Rabbit-Hole', 'CHAPTER II. The Pool of Tears', 'CHAPTER III. A Caucus-Race and a Long Tale'].map(
      (title, index) => ({ index, title, t: index / 6 }),
    );
    // As the server says it once lined up: each chapter heard starting in its own track only.
    const demo = {
      ...edition(
        [
          tagged(0, 'Chapter 1', 640_584, 3, [{ chapter: 3, ms: 13_200 }]),
          tagged(1, 'Chapter 2', 735_768, 4, [{ chapter: 4, ms: 17_300 }]),
          tagged(2, 'Chapter 3', 1_063_993, 5, [{ chapter: 5, ms: 35_240 }]),
        ],
        [{ title: 'Chapter 1', m: 0 }, { title: 'Chapter 2', m: 640_584 }, { title: 'Chapter 3', m: 1_376_352 }],
      ),
      alignment: { method: 'forced', unitToChapter: [3, 4, 5] },
    } as unknown as Edition;
    const titles = listEntries(demo, alice).map((x) => x.title);
    expect(titles).toEqual(['CHAPTER I. Down the Rabbit-Hole', 'CHAPTER II. The Pool of Tears', 'CHAPTER III. A Caucus-Race and a Long Tale']);
    expect(new Set(titles).size).toBe(titles.length);
    // "End of chapter 1. Read by Krista McQuillan, Tokyo, Japan…", the track's last seven seconds.
    expect([633_300, 640_000].map((ms) => chapterNamedAt(demo, 0, ms))).toEqual([3, 3]);
    expect(chapterNamedAt(demo, 1, 0)).toBe(4);
  });
});

