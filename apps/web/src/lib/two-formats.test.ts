import { describe, expect, it } from 'vitest';
import type { BookDetail, Edition } from '@bookclub/shared';
import { ALONG_RESUME, alongStart, audiobookFor, catchUpTo, chapterShort, elsewhereThan, formatActions, needsStartTap, playFrom, resolveAlong, textFor } from './two-formats';

const chapters = ['Contents', 'CHAPTER I. Down the Rabbit-Hole', 'CHAPTER II. The Pool of Tears', 'CHAPTER III. A Caucus-Race'].map((title, i) => ({ index: i, title, t: i === 0 ? 0 : (i - 1) / 3 + 0.001 }));
const book = { chapters } as unknown as BookDetail;
const audio = {
  id: 'ea', kind: 'audio', status: 'ready', readAlong: { textEditionId: 'ee', sentences: 100, coverage: 0.97 },
  tracks: [{ index: 0, durationMs: 600_000 }, { index: 1, durationMs: 600_000 }],
  geometry: { kind: 'audio', trackDurationsMs: [600_000, 600_000] }, sync: { points: [{ m: 0, t: 0 }, { m: 1_200_000, t: 1 }] },
} as unknown as Edition;
const epub = { id: 'ee', kind: 'epub', status: 'ready' } as unknown as Edition;
const pdf = { id: 'ep', kind: 'pdf', status: 'ready' } as unknown as Edition;

describe('the book page’s one way in (D198)', () => {
  const listen = (a: ReturnType<typeof formatActions>[number]) => [a.edition.id, a.along?.id ?? null, a.label, a.primary];

  it('nothing read yet: one Open into the text, no along', () => {
    expect(formatActions(book, [epub, audio], null).map(listen)).toEqual([['ee', null, 'Open', true]]);
  });

  it('listening last: Continue into the lined-up text with the audiobook along', () => {
    const mine = { editionId: 'ea', t: 0.5 };
    expect(formatActions(book, [epub, pdf, audio], mine).map(listen)).toEqual([['ee', 'ea', 'Continue', true]]);
  });

  it('reading last: Continue into that text, without starting the audiobook', () => {
    expect(formatActions(book, [epub, pdf, audio], { editionId: 'ep', t: 0.5 }).map(listen)).toEqual([['ep', null, 'Continue', true]]);
  });

  it('the audiobook hidden for this book: Continue into the text, no along', () => {
    expect(formatActions(book, [epub, audio], { editionId: 'ea', t: 0.5 }, { audioHidden: true }).map(listen)).toEqual([['ee', null, 'Continue', true]]);
  });

  it('an audiobook alone opens in the player', () => {
    expect(formatActions(book, [audio], { editionId: 'ea', t: 0.5 }).map(listen)).toEqual([['ea', null, 'Continue', true]]);
    expect(formatActions(book, [audio], null).map(listen)).toEqual([['ea', null, 'Open', true]]);
  });

  it('chapterShort still names story chapters', () => {
    expect(chapterShort(book, 0.0005)).toBeNull();
    expect(chapterShort(book, 0.9)).toBe('Chapter 3');
  });
});

describe('one place, whichever format (D186)', () => {
  it('a paused player goes to where you read on to', () => {
    const here = { kind: 'audio' as const, track: 0, ms: 60_000 };
    expect(catchUpTo({ source: 'other-format', at: 1_000, locator: { kind: 'audio', track: 1, ms: 30_000 } }, audio, here)).toEqual({ kind: 'audio', track: 1, ms: 30_000 });
  });
  it('stays when its own place is the newest, or the place is the same, or there is none', () => {
    const here = { kind: 'audio' as const, track: 0, ms: 60_000 };
    expect(catchUpTo({ source: 'device', at: 1_000, locator: { kind: 'audio', track: 1, ms: 30_000 } }, audio, here)).toBeNull();
    expect(catchUpTo({ source: 'other-format', at: 1_000, locator: { kind: 'audio', track: 0, ms: 61_000 } }, audio, here)).toBeNull();
    expect(catchUpTo({ source: 'other-format', at: 1_000, locator: { kind: 'audio', track: 1, ms: 30_000 } }, audio, null)).toBeNull();
  });

  it('Play in the book resumes when the narrator is on this page or about to come to it, else starts at this page', () => {
    const page = { startT: 0.4, endT: 0.41 };
    expect(playFrom(0.405, page)).toBe('resume'); // on this page
    expect(playFrom(0.415, page)).toBe('resume'); // the next page: a glance back
    expect(playFrom(0.399, page)).toBe('resume'); // a word before, still this sentence
    expect(playFrom(0.3, page)).toBe('page'); // you read on since it stopped
    expect(playFrom(0.6, page)).toBe('page'); // you went back to reread
    expect(playFrom(null, page)).toBe('page');
  });
});

describe('the audiobook over the text (D194, D197)', () => {
  const other = { id: 'eb', kind: 'audio', status: 'ready' } as unknown as Edition;
  const processing = { id: 'ex', kind: 'audio', status: 'processing' } as unknown as Edition;

  it('a reader reads along with the audiobook lined up with it, else the first ready one, else none', () => {
    expect(audiobookFor([other, audio, epub], epub)?.id).toBe('ea');
    expect(audiobookFor([processing, other, epub], epub)?.id).toBe('eb');
    expect(audiobookFor([processing, epub], epub)).toBeNull();
  });

  it('a listener reads along in the edition the audiobook is lined up with, else the EPUB, else the PDF', () => {
    expect(textFor([pdf, epub, audio], audio)?.id).toBe('ee');
    expect(textFor([pdf, epub, other], other)?.id).toBe('ee');
    expect(textFor([pdf, other], other)?.id).toBe('ep');
    expect(textFor([other], other)).toBeNull();
  });

  it('the one obvious Play: the audiobook over the page, not playing, refused or asked for and not started', () => {
    expect(needsStartTap(true, { playing: false, blocked: true }, false)).toBe(true);
    expect(needsStartTap(true, { playing: false, blocked: false }, true)).toBe(true);
    expect(needsStartTap(true, { playing: false, blocked: false }, false)).toBe(false);
    expect(needsStartTap(true, { playing: true, blocked: true }, true)).toBe(false);
    expect(needsStartTap(false, { playing: false, blocked: true }, true)).toBe(false);
  });

  it('reading along from the book page starts at your place, in the audiobook; before anything is read, at its start', () => {
    const b = { chapters, editions: [epub, audio] } as unknown as BookDetail;
    expect(alongStart(b, audio, null)).toBeNull();
    expect(alongStart(b, audio, { editionId: 'ee', t: 0 })).toBeNull();
    expect(alongStart(b, audio, { editionId: 'ea', t: 0.75 })).toEqual({ kind: 'audio', track: 1, ms: 300_000 });
  });

  it('a paused audiobook goes to your place first only when it is somewhere else in the book', () => {
    const here = { kind: 'audio' as const, track: 0, ms: 60_000 };
    expect(elsewhereThan(audio, here, { kind: 'audio', track: 1, ms: 300_000 })).toBe(true);
    expect(elsewhereThan(audio, here, { kind: 'audio', track: 0, ms: 61_000 })).toBe(false);
    expect(elsewhereThan(audio, null, here)).toBe(false);
  });

  it('along=1 resumes the lined-up audiobook over the text (D198)', () => {
    expect(resolveAlong([epub, audio], epub, ALONG_RESUME)).toBe('ea');
    expect(resolveAlong([epub, audio], epub, 'ea')).toBe('ea');
    expect(resolveAlong([epub, audio], epub, null)).toBeNull();
  });
});
