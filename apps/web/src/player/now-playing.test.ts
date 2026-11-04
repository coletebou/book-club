import { describe, expect, it } from 'vitest';
import type { BookDetail, Chapter, Edition } from '@bookclub/shared';
import { ARTWORK_SIZES, atBookStart, chapterStep, chapterStops, nowPlayingArtwork, nowPlayingMetadata, positionStateOf } from './now-playing';

const BASE = 'https://books.example/books/b1/listen';
const track = (index: number, durationMs: number, chapter: number | null = null, heard?: { chapter: number; ms: number }[], title = `Track ${index + 1}`) => ({
  index,
  title,
  durationMs,
  url: `/t${index}`,
  mime: 'audio/mpeg',
  chapter,
  ...(heard ? { chapters: heard } : {}),
});
const edition = (tracks: ReturnType<typeof track>[], units: { title: string; m: number }[] = tracks.map((t, i) => ({ title: t.title, m: tracks.slice(0, i).reduce((a, x) => a + x.durationMs, 0) }))) =>
  ({ tracks, units, alignment: { method: 'chapters', unitToChapter: [] } }) as unknown as Edition;
const chapters: Chapter[] = ['CHAPTER I. Down the Rabbit-Hole', 'CHAPTER II. The Pool of Tears', 'CHAPTER III. A Caucus-Race'].map((title, index) => ({ index, title, t: index / 3 }));
const book = { id: 'b1', title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', coverUrl: '/media/books/b1/cover?v=abc', chapters } as unknown as BookDetail;

describe('the lock screen’s artwork (D190)', () => {
  it('is the cover as square tiles in every size, absolute, keeping its version', () => {
    const art = nowPlayingArtwork(book.coverUrl, BASE);
    expect(art.map((a) => a.sizes)).toEqual(ARTWORK_SIZES.map((s) => `${s}x${s}`));
    for (const [i, a] of art.entries()) {
      const url = new URL(a.src);
      expect(url.origin).toBe('https://books.example');
      expect(url.pathname).toBe('/media/books/b1/cover');
      expect(Object.fromEntries(url.searchParams)).toEqual({ v: 'abc', shape: 'square', w: String(ARTWORK_SIZES[i]) });
      expect(a.type).toBe('image/webp');
    }
    expect(art.at(-1)!.sizes).toBe('512x512');
  });
});

describe('the lock screen’s lines', () => {
  const e = edition([track(0, 60_000, 0), track(1, 90_000, 1)]);
  it('names the chapter playing, the author and the book', () => {
    expect(nowPlayingMetadata(book, e, 1, 1, BASE)).toEqual(expect.objectContaining({ title: 'CHAPTER II. The Pool of Tears', artist: 'Lewis Carroll', album: "Alice's Adventures in Wonderland" }));
  });
  it('goes by the track’s own tidy name where no chapter names it, and by the book’s where the track has none', () => {
    const named = edition([track(0, 60_000, null, undefined, '01 - Chapter 6')]);
    expect(nowPlayingMetadata(book, named, 0, null, BASE).title).toBe('Chapter 6');
    const nameless = edition([track(0, 60_000, null, undefined, '')]);
    expect(nowPlayingMetadata(book, nameless, 0, null, BASE).title).toBe(book.title);
  });
});

describe('the previous and next chapter (D190)', () => {
  const folder = edition([track(0, 60_000, 0), track(1, 90_000, 1), track(2, 30_000, 2)]);
  const m4b = edition([track(0, 12_000)], [{ title: 'One', m: 0 }, { title: 'Two', m: 4_000 }, { title: 'Three', m: 8_000 }]);

  it('in a folder of tracks, a chapter is a track', () => {
    const stops = chapterStops(folder, chapters);
    expect(stops).toEqual([{ track: 0, ms: 0 }, { track: 1, ms: 0 }, { track: 2, ms: 0 }]);
    expect(chapterStep(stops, { track: 0, ms: 20_000 }, 1)).toEqual({ track: 1, ms: 0 });
    expect(chapterStep(stops, { track: 2, ms: 1_000 }, 1)).toBeNull();
  });

  it('in a single file, the chapters inside it, where the files would give only one', () => {
    const stops = chapterStops(m4b, chapters);
    expect(stops).toEqual([{ track: 0, ms: 0 }, { track: 0, ms: 4_000 }, { track: 0, ms: 8_000 }]);
    expect(chapterStep(stops, { track: 0, ms: 5_000 }, 1)).toEqual({ track: 0, ms: 8_000 });
    expect(chapterStep(stops, { track: 0, ms: 8_500 }, -1)).toEqual({ track: 0, ms: 4_000 });
  });

  it('previous restarts the chapter a few seconds in, else goes to the one before, and stays at the book’s start', () => {
    const stops = chapterStops(folder, chapters);
    expect(chapterStep(stops, { track: 1, ms: 45_000 }, -1)).toEqual({ track: 1, ms: 0 });
    expect(chapterStep(stops, { track: 1, ms: 2_000 }, -1)).toEqual({ track: 0, ms: 0 });
    expect(chapterStep(stops, { track: 0, ms: 2_000 }, -1)).toEqual({ track: 0, ms: 0 });
    expect(atBookStart(stops, { track: 0, ms: 2_000 })).toBe(true);
    expect(atBookStart(stops, { track: 0, ms: 9_000 })).toBe(false);
  });

  it('a track of several chapters stops at each, never twice at its start', () => {
    const jekyll: Chapter[] = ['A', 'B', 'C'].map((title, index) => ({ index, title, t: index / 3 }));
    const e = edition([track(0, 600_000, null, [{ chapter: 0, ms: 0 }, { chapter: 1, ms: 200_000 }, { chapter: 2, ms: 400_000 }], 'Chapter 01 to 03')]);
    expect(chapterStops(e, jekyll)).toEqual([{ track: 0, ms: 0 }, { track: 0, ms: 200_000 }, { track: 0, ms: 400_000 }]);
  });

  it('has nowhere to go in an empty audiobook', () => {
    expect(chapterStep([], { track: 0, ms: 0 }, 1)).toBeNull();
    expect(chapterStep([], { track: 0, ms: 0 }, -1)).toBeNull();
  });
});

describe('the lock screen’s scrubber', () => {
  it('is the element’s own position, length and speed, exactly', () => {
    expect(positionStateOf({ duration: 612.4, currentTime: 200.73, playbackRate: 1.5 })).toEqual({ duration: 612.4, position: 200.73, playbackRate: 1.5 });
  });
  it('is nothing until the track’s length is known', () => {
    for (const duration of [NaN, 0, Infinity]) expect(positionStateOf({ duration, currentTime: 0, playbackRate: 1 })).toBeNull();
  });
  it('keeps the position inside the track and the speed above 0 (paused is the playback state’s to say)', () => {
    expect(positionStateOf({ duration: 100, currentTime: 101, playbackRate: 1 })?.position).toBe(100);
    expect(positionStateOf({ duration: 100, currentTime: -1, playbackRate: 1 })?.position).toBe(0);
    expect(positionStateOf({ duration: 100, currentTime: 5, playbackRate: 0 })?.playbackRate).toBe(1);
  });
});
