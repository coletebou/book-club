import { describe, expect, it } from 'vitest';
import { type EditionRow } from '../src/repos/books';
import { placeLabel } from '../src/services/labels';

const MIN = 60_000;
const chapters = [
  { index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0 },
  { index: 1, title: 'CHAPTER II. The Pool of Tears', t: 0.5 },
];

/** An audiobook of two ten-minute tracks, one per chapter; chapter II's words begin 20 s into its track. */
const audio: EditionRow = {
  id: 'ed_audio',
  book_id: 'book_alice',
  kind: 'audio',
  status: 'ready',
  error: null,
  geometry_json: JSON.stringify({ kind: 'audio', trackDurationsMs: [10 * MIN, 10 * MIN] }),
  units_json: JSON.stringify([
    { title: 'Chapter 1', m: 0 },
    { title: 'Chapter 2', m: 10 * MIN },
  ]),
  // Refined by reading along: the timeline reaches chapter II only where its words begin.
  sync_json: JSON.stringify({ points: [{ m: 0, t: 0 }, { m: 10 * MIN + 20_000, t: 0.5 }, { m: 20 * MIN, t: 1 }] }),
  alignment_json: JSON.stringify({ method: 'forced', unitToChapter: [0, 1] }),
  meta_json: '{}',
  size_bytes: 0,
  created_by: 'user_cole',
  created_at: 0,
};

describe('services/labels placeLabel', () => {
  it('names the recording’s announcement before a chapter’s words by the chapter its track is', () => {
    // 17 s into chapter II's track: still the end of chapter I on the timeline.
    const t = 0.49;
    expect(placeLabel(chapters, audio, { kind: 'audio', track: 1, ms: 17_000 }, t)).toBe('Chapter 2 · 49%');
    // Inside the chapter, and in other formats, as the timeline says.
    expect(placeLabel(chapters, audio, { kind: 'audio', track: 1, ms: 300_000 }, 0.74)).toBe('Chapter 2 · 74%');
    expect(placeLabel(chapters, audio, { kind: 'audio', track: 0, ms: 300_000 }, 0.25)).toBe('Chapter 1 · 25%');
    expect(placeLabel(chapters, undefined, { kind: 'epub', section: 3, offset: 0 }, 0.49)).toBe('Chapter 1 · 49%');
  });
});
