import type { ReadAlongTrack } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { followTarget, narrationAt, offsetNow, onPage, sentenceIndexAt, sentencesOf } from './readalong';

const track: ReadAlongTrack = {
  audioEditionId: 'ed_audio_1',
  textEditionId: 'ed_epub_1',
  track: 0,
  sentences: [
    [2, 0, 10, 13_200, 13_900],
    [2, 11, 20, 14_440, 15_322],
    [2, 33, 200, 15_980, 21_407],
  ],
  text: ['CHAPTER I.', 'Down the Rabbit-Hole', 'Alice was beginning to get very tired…'],
};

describe('read-along sentences', () => {
  it('turns the server’s rows into sentences with their text', () => {
    expect(sentencesOf(track)[1]).toEqual({ index: 1, section: 2, offset: 11, length: 20, startMs: 14_440, endMs: 15_322, text: 'Down the Rabbit-Hole' });
    expect(sentencesOf(undefined)).toEqual([]);
  });

  it('finds the sentence being read at a moment: the last one started', () => {
    const s = sentencesOf(track);
    expect(sentenceIndexAt(s, 0)).toBe(-1);
    expect(sentenceIndexAt(s, 13_200)).toBe(0);
    expect(sentenceIndexAt(s, 14_000)).toBe(0);
    expect(sentenceIndexAt(s, 14_440)).toBe(1);
    expect(sentenceIndexAt(s, 600_000)).toBe(2);
    expect(sentenceIndexAt([], 10)).toBe(-1);
  });

  it('estimates how far into a sentence the narrator is, by the share of its time gone', () => {
    const long = sentencesOf(track)[2]!;
    expect(offsetNow(long, 15_000)).toBe(33);
    expect(offsetNow(long, (15_980 + 21_407) / 2)).toBe(133);
    expect(offsetNow(long, 99_999)).toBe(233);
  });
});

/*
 * D184's regressions, with fixtures as the server answers them: LibriVox's opening (its first words
 * at 13.2 s, as the reference transcript has them), a commercial audiobook's track of opening
 * credits that reads no sentence, and the closing credits after the last.
 */
describe('where the narrator is in the text (D184)', () => {
  const opening: ReadAlongTrack = { ...track, lead: [2, 0], previous: null };
  const credits: ReadAlongTrack = { audioEditionId: 'a', textEditionId: 'e', track: 0, lead: [2, 0], previous: null, sentences: [], text: [] };
  const closing: ReadAlongTrack = { audioEditionId: 'a', textEditionId: 'e', track: 11, lead: null, previous: [13, 4_200], sentences: [], text: [] };

  it('during the opening credits, before the first sentence: before the text, which begins at the first sentence', () => {
    const n = narrationAt(opening, sentencesOf(opening), 5_000);
    expect(n).toMatchObject({ state: 'before', lead: { section: 2, offset: 0 }, next: { index: 0, text: 'CHAPTER I.' } });
    // The pages go to where the text begins, ready for the narrator.
    expect(followTarget(n)).toEqual({ section: 2, offset: 0 });
  });

  it('a whole track of credits: before the text, which begins where the next track takes it up', () => {
    const n = narrationAt(credits, [], 60_000);
    expect(n).toEqual({ state: 'before', lead: { section: 2, offset: 0 }, next: null });
    expect(followTarget(n)).toEqual({ section: 2, offset: 0 });
  });

  it('the closing credits: past the text, and the pages stay', () => {
    const n = narrationAt(closing, [], 1_000);
    expect(n).toEqual({ state: 'after', previous: { section: 13, offset: 4_200 } });
    expect(followTarget(n)).toBeNull();
  });

  it('reading: the sentence and the place in it; between two sentences, the one just read', () => {
    const s = sentencesOf(opening);
    expect(narrationAt(opening, s, 13_550)).toEqual({ state: 'reading', sentence: s[0], offset: 5 });
    expect(narrationAt(opening, s, 14_200)).toEqual({ state: 'reading', sentence: s[0], offset: 10 });
    expect(followTarget(narrationAt(opening, s, 18_700))).toEqual({ section: 2, offset: 33 + 100 });
  });

  it('a response from an older server, with no lead: this track’s first sentence leads', () => {
    expect(narrationAt(track, sentencesOf(track), 1_000)).toEqual(expect.objectContaining({ state: 'before', lead: { section: 2, offset: 0 } }));
    expect(narrationAt({ ...track, sentences: [], text: [] }, [], 1_000)).toEqual({ state: 'after', previous: null });
  });

  it('nothing to follow while the track’s read-along is still coming', () => {
    expect(narrationAt(undefined, [], 5_000)).toEqual({ state: 'loading' });
    expect(followTarget({ state: 'loading' })).toBeNull();
  });

  it('a place is on a page from its first offset up to the next page’s; the last page holds the section’s very end', () => {
    const page = { section: 2, start: 100, end: 200, last: false };
    expect(onPage({ section: 2, offset: 100 }, page)).toBe(true);
    expect(onPage({ section: 2, offset: 199 }, page)).toBe(true);
    expect(onPage({ section: 2, offset: 200 }, page)).toBe(false);
    expect(onPage({ section: 3, offset: 150 }, page)).toBe(false);
    // Narration at the section's last character, on its last page: here, not a page to turn to
    // again and again (which would display the same page on every tick).
    expect(onPage({ section: 2, offset: 200 }, { ...page, last: true })).toBe(true);
  });
});
