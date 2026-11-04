import { renderHook } from '@testing-library/react';
import type { CommentView, HiddenComment, RevealedComment } from '@bookclub/shared';
import { describe, expect, it, vi } from 'vitest';
import { fromFurtherOn, FURTHER_ON, howFarBack, nearButClosed, notAsFar, notAsFarLine, noteCue, openedBehind, opensWords, placeName, reactionAlone, reactionOnly, useOpenedBehind, whyClosed } from './further';

const chapters = [
  { index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0.02 },
  { index: 1, title: 'CHAPTER II. The Pool of Tears', t: 0.1 },
  { index: 2, title: 'CHAPTER XII. Alice’s Evidence', t: 0.92 },
];
const at = { bookId: 'book_1', color: '#D6B85E', editionId: 'edition_audio', locator: { kind: 'audio' as const, track: 1, ms: 90_000 }, createdAt: '2026-10-25T10:00:00.000Z', parentId: null };
/** As the server sends a friend's note to someone it is closed to (never its words). */
const closed = (over: Partial<HiddenComment> = {}): HiddenComment => ({ ...at, id: 'note_1', userId: 'user_ben', authorName: 'Ben', kind: 'audio', t: 0.12, reaction: '😢', hidden: true, hasText: true, ...over });
const opened = (c: HiddenComment): RevealedComment => {
  // `media`'s element shape differs between the hidden and open views (kind-only vs. the full
  // view): dropped here along with the hidden-only fields, rather than carried across untyped.
  const { hasText: _hasText, horizon: _horizon, media: _media, ...base } = c;
  return { ...base, hidden: false, endLocator: null, endT: null, quote: null, text: 'Poor Alice' };
};

describe('writing from further on (D69)', () => {
  it('is reading more than about a page past where you write, the threshold the answers use too', () => {
    expect(fromFurtherOn(1, 0.03)).toBe(true);
    expect(fromFurtherOn(0.03 + FURTHER_ON + 1e-6, 0.03)).toBe(true);
    // Up to about a page further on is the page in front of you: nothing waits for it.
    expect(fromFurtherOn(0.03 + FURTHER_ON, 0.03)).toBe(false);
    expect(fromFurtherOn(0.031, 0.03)).toBe(false);
    expect(fromFurtherOn(0.02, 0.03)).toBe(false);
    // Nothing known of your reading: nothing to say.
    expect(fromFurtherOn(undefined, 0.03)).toBe(false);
    expect(fromFurtherOn(null, 0.03)).toBe(false);
  });

  it('names where you have read to as the held notice does: the chapter, else how far', () => {
    expect(placeName(chapters, 1)).toBe('Chapter 12');
    expect(placeName(chapters, 0.5)).toBe('Chapter 2');
    expect(placeName(chapters, 0.01)).toBe('1%');
    // Read to the end of Chapter 1, the place Chapter 2 starts at: read to Chapter 1.
    expect(placeName(chapters, 0.1)).toBe('Chapter 1');
    expect(placeName(chapters, 0.1001)).toBe('Chapter 2');
  });
});

describe('who has not read as far as you (fidelity review round 16)', () => {
  const member = (userId: string, displayName: string, furthest: number) => ({ userId, displayName, furthest });
  const club = [member('user_cole', 'Cole', 0.16), member('user_ana', 'Ana', 0.58), member('user_ben', 'Ben', 0.18), member('user_cleo', 'Cleo', 0.71)];

  it('is no one when every friend is past you: there is nothing to ask', () => {
    expect(notAsFar(club, 'user_cole', 0.16)).toEqual([]);
  });

  it('is every friend more than about a page short of where you have read, never you', () => {
    expect(notAsFar(club, 'user_cleo', 0.71)).toEqual(['Cole', 'Ana', 'Ben']);
    expect(notAsFar(club, 'user_ana', 0.58)).toEqual(['Cole', 'Ben']);
    // Within a page of you is as far.
    expect(notAsFar(club, 'user_ben', 0.18)).toEqual(['Cole']);
    expect(notAsFar(club, 'user_ben', 0.16 + FURTHER_ON)).toEqual([]);
    // A friend who has not started is not as far.
    expect(notAsFar([...club, member('user_fern', 'Fern', 0)], 'user_cole', 0.16)).toEqual(['Fern']);
  });

  it('names them', () => {
    expect(notAsFarLine(['Ben'])).toBe('Ben has not read as far as you');
    expect(notAsFarLine(['Ana', 'Ben'])).toBe('Ana and Ben have not read as far as you');
    expect(notAsFarLine(['Ana', 'Ben', 'Cole'])).toBe('Ana, Ben and Cole have not read as far as you');
    expect(notAsFarLine(['Ana', 'Ben', 'Cole', 'Dee', 'Eve'])).toBe('Ana, Ben, Cole and 2 others have not read as far as you');
  });
});

describe('why a friend’s note is closed to you', () => {
  it('waits for where its writer had read to, whatever you have read', () => {
    expect(whyClosed(closed({ horizon: 'Chapter 9' }), [[0, 0.5]])).toBe('held');
    expect(whyClosed(closed({ horizon: 'Chapter 9' }), undefined)).toBe('held');
  });

  it('is about here when you have read its place: made in another format, it opens a little after', () => {
    expect(whyClosed(closed(), [[0, 0.125]])).toBe('near');
    expect(whyClosed(closed(), [[0.12, 0.13]])).toBe('near');
  });

  it('is ahead of you when you have not read this far, and in a part you skipped when you read past it without reading it', () => {
    expect(whyClosed(closed(), [[0, 0.11]])).toBe('ahead');
    // The first place of the next page is not read yet (ranges are half-open).
    expect(whyClosed(closed(), [[0, 0.12]])).toBe('ahead');
    expect(whyClosed(closed(), [])).toBe('ahead');
    expect(whyClosed(closed(), undefined)).toBe('ahead');
    expect(whyClosed(closed(), [[0, 0.05], [0.4, 0.45]])).toBe('skipped');
  });

  it('says, about here, who made it and in which format, and that it opens once you are surely past it; nothing else', () => {
    expect(nearButClosed(closed())).toBe('Ben wrote this while listening, about here · it opens a little further on, once you are surely past it');
    expect(nearButClosed(closed({ kind: 'pdf', authorName: 'Cleo' }))).toBe('Cleo wrote this in the PDF, about here · it opens a little further on, once you are surely past it');
    expect(nearButClosed(closed({ kind: 'epub', authorName: 'Ana' }), 'sentence')).toBe('Ana wrote this in the EPUB, about here: it opens a little further on, once you are surely past it.');
    // A reaction alone has no words to wait: whose and which it is, and nothing more to come (fidelity review round 16).
    expect(nearButClosed(closed({ hasText: false }))).toBe('Ben reacted 😢 while listening, about here, with no words.');
    expect(nearButClosed(closed({ hasText: false }), 'sentence')).toBe('Ben reacted 😢 while listening, about here, with no words.');
  });
});

describe('a reaction with no words, closed to you (fidelity review round 16)', () => {
  it('is a reaction without words, not a deleted note', () => {
    expect(reactionOnly(closed({ hasText: false }))).toBe(true);
    expect(reactionOnly(closed())).toBe(false);
    expect(reactionOnly(closed({ hasText: false, reaction: null, deleted: true }))).toBe(false);
  });

  it('says whose and which it is, as the club bar does, and that it has no words: nothing waits to be seen', () => {
    expect(reactionAlone(closed({ hasText: false, authorName: 'Ana', reaction: '🤯' }), 'ahead')).toBe('Ana reacted 🤯 here, with no words.');
    expect(reactionAlone(closed({ hasText: false, authorName: 'Ana', reaction: '🤯' }), 'skipped')).toBe('Ana reacted 🤯 here, with no words.');
    expect(reactionAlone(closed({ hasText: false, kind: 'pdf' }), 'near')).toBe('Ben reacted 😢 in the PDF, about here, with no words.');
  });
});

describe('a note behind you opening', () => {
  it('says whose, where, and why now', () => {
    expect(openedBehind(opened(closed()), 'near', chapters)).toBe('Ben’s note in Chapter 2 is open now: you are surely past it.');
    expect(openedBehind(opened(closed({ authorName: 'Cleo', t: 0.03 })), 'held', chapters)).toBe('Cleo’s note in Chapter 1 is open now: you have read as far as they had.');
    expect(openedBehind(opened(closed({ t: 0.01 })), 'near', chapters)).toBe('Ben’s note is open now: you are surely past it.');
  });

  it('is told once, for a note that waited for you to be past it or to read as far as its writer, never for one that was ahead of you', () => {
    const tell = vi.fn<(note: CommentView, was: 'near' | 'held') => void>();
    const near = closed();
    const held = closed({ id: 'note_2', authorName: 'Cleo', t: 0.03, horizon: 'Chapter 12' });
    const ahead = closed({ id: 'note_3', authorName: 'Ana', t: 0.5 });
    const gone = closed({ id: 'note_4', t: 0.12 });
    const already = opened(closed({ id: 'note_5', t: 0.11 }));
    const { rerender } = renderHook(({ notes, read }) => useOpenedBehind(notes, read, tell), {
      initialProps: { notes: [near, held, ahead, gone, already] as CommentView[], read: [[0, 0.125]] as [number, number][] },
    });
    // What was open when the book came up is no news.
    expect(tell).not.toHaveBeenCalled();
    // You read on: the progress that says so opens all of them (the one ahead by "read up to here").
    const read: [number, number][] = [[0, 0.6]];
    rerender({ notes: [opened(near), opened(held), opened(ahead), { ...opened(gone), deleted: true, text: null }, already], read });
    expect(tell.mock.calls.map(([c, was]) => [c.id, was])).toEqual([
      ['note_1', 'near'],
      ['note_2', 'held'],
    ]);
    rerender({ notes: [opened(near), opened(held), opened(ahead), already], read: [[0, 0.7]] });
    expect(tell).toHaveBeenCalledTimes(2);
  });
});

describe('the player’s cue for a friend’s note', () => {
  it('is at its place within four seconds, as before; one that opened while you listened, however far back it is by then', () => {
    expect(noteCue(0, false)).toBe('here');
    expect(noteCue(3999, false)).toBe('here');
    expect(noteCue(3999, true)).toBe('here');
    expect(noteCue(4000, false)).toBeNull();
    expect(noteCue(-1, true)).toBeNull();
    expect(noteCue(4000, true)).toBe('back');
    // Opened two minutes after its place (a tenth of a twenty-minute chapter, D63): told all the same.
    expect(noteCue(120_000, true)).toBe('back');
    expect(noteCue(3 * 3600_000, true)).toBe('back');
  });

  it('says how far back it is', () => {
    expect(howFarBack(400)).toBe('1 s back');
    expect(howFarBack(40_000)).toBe('40 s back');
    expect(howFarBack(59_400)).toBe('59 s back');
    expect(howFarBack(59_600)).toBe('1 min back');
    expect(howFarBack(89_000)).toBe('1 min back');
    expect(howFarBack(90_000)).toBe('2 min back');
    expect(howFarBack(4 * 60_000 + 10_000)).toBe('4 min back');
    expect(howFarBack(59.4 * 60_000)).toBe('59 min back');
    expect(howFarBack(59.6 * 60_000)).toBe('1 h back');
    expect(howFarBack(65 * 60_000)).toBe('1 h 5 min back');
    expect(howFarBack(2 * 3600_000)).toBe('2 h back');
  });
});

describe('a friend’s note opening behind you (D100)', () => {
  const opened = (text: string | null, reaction: string | null) => ({ hidden: false, text, reaction }) as unknown as CommentView;
  it('is told when it has words, not when a reaction alone (shown all along) opens', () => {
    expect(opensWords(opened('Curiouser and curiouser', '😱'))).toBe(true);
    expect(opensWords(opened(null, '😱'))).toBe(false);
    expect(opensWords(opened('  ', '😱'))).toBe(false);
    expect(opensWords({ hidden: true } as unknown as CommentView)).toBe(false);
  });
});
