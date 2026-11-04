import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { BookProgress, CommentView } from '@bookclub/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { keys } from '../lib/queries';
import { Discussion } from './Discussion';

afterEach(cleanup);

const chapters = [
  { index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0.02 },
  { index: 1, title: 'CHAPTER XII. Alice’s Evidence', t: 0.92 },
];
const at = { bookId: 'book_1', color: '#D6B85E', createdAt: '2026-10-25T10:00:00.000Z', parentId: null, editionId: 'edition_1', kind: 'epub' as const, locator: { kind: 'epub' as const, section: 2, offset: 900 } };
const words = { endLocator: null, endT: null, quote: null };
/** Cole's welcome on page 4, written having read the whole book: friends read it once they have read to Chapter 12 (D69). */
const welcome: CommentView = { ...at, ...words, id: 'note_mine', userId: 'user_cole', authorName: 'Cole', reaction: null, t: 0.03, hidden: false, text: 'Welcome to the club!', horizon: 'Chapter 12' };
/** Cole's, only about its passage: nothing waits. */
const aboutHere: CommentView = { ...at, ...words, id: 'note_here', userId: 'user_cole', authorName: 'Cole', reaction: null, t: 0.031, hidden: false, text: 'Look at the jar' };
/** Ana's, open to Cole. */
const ana: CommentView = { ...at, ...words, id: 'note_ana', userId: 'user_ana', authorName: 'Ana', reaction: '😂', t: 0.032, hidden: false, text: 'Down, down, down' };
/** Ben's 😢, made while listening: its place is read, and it opens a little after it (D63). */
const heard: CommentView = { ...at, id: 'note_heard', userId: 'user_ben', authorName: 'Ben', reaction: '😢', t: 0.04, kind: 'audio', editionId: 'edition_audio', locator: { kind: 'audio', track: 0, ms: 200_000 }, hidden: true, hasText: true };
/** Cleo's, ahead of Cole. */
const ahead: CommentView = { ...at, id: 'note_ahead', userId: 'user_cleo', authorName: 'Cleo', reaction: null, t: 0.6, hidden: true, hasText: true };
/** Ana's 🤯 with no words, ahead of Cole. */
const reaction: CommentView = { ...at, id: 'note_reaction', userId: 'user_ana', authorName: 'Ana', reaction: '🤯', t: 0.62, hidden: true, hasText: false };
/** Cleo's, written from further on, which Cole has read the place of. */
const held: CommentView = { ...at, id: 'note_held', userId: 'user_cleo', authorName: 'Cleo', reaction: null, t: 0.035, hidden: true, hasText: true, horizon: 'Chapter 9' };

function discussion(comments: CommentView[], readRanges: [number, number][] = [[0, 0.05]], selfId = 'user_cole') {
  const qc = new QueryClient();
  const furthest = readRanges[readRanges.length - 1]?.[1] ?? 0;
  qc.setQueryData<BookProgress>(keys.progress('book_1'), {
    mine: { editionId: 'edition_1', locator: null, t: furthest, label: '', readRanges, furthest, finished: false, at: 1 },
    members: [],
  });
  render(
    <QueryClientProvider client={qc}>
      <Discussion comments={comments} chapters={chapters} selfId={selfId} canModerate={false} />
    </QueryClientProvider>,
  );
  return (id: string) => screen.getAllByTestId('note').find((li) => li.getAttribute('data-comment') === id)!;
}

describe('the book page’s notes (fidelity review round 13)', () => {
  // Cole did not want the writer told this under their own note (fidelity feedback, round
  // 2026-10-28): the line is gone everywhere, held or not.
  it('no longer says, under your own note written from further on, when friends read it', () => {
    discussion([welcome, aboutHere, ana]);
    expect(screen.queryByTestId('note-held-for')).toBeNull();
  });

  it('a friend’s note made in another format, whose place you have read, says so and that it opens a little further on', () => {
    const note = discussion([heard, held, ahead]);
    const near = note('note_heard').querySelector('.note-locked')!;
    expect(near.getAttribute('data-closed')).toBe('near');
    expect(near.textContent?.trim()).toBe('Ben wrote this while listening, about here: it opens a little further on, once you are surely past it.');
    expect(note('note_heard').textContent).toContain('😢');
    // Waiting for where its writer had read to, and ahead of you, as before.
    expect(note('note_held').textContent).toContain('Cleo wrote this from Chapter 9: it opens when you get there.');
    expect(note('note_ahead').querySelector('.note-locked')!.getAttribute('data-closed')).toBe('ahead');
    expect(note('note_ahead').textContent).toContain('A note waits here. You will see it when you get there.');
  });

  it('a reaction with no words ahead of you says whose and which it is, and promises nothing more (fidelity review round 16)', () => {
    const note = discussion([reaction, { ...reaction, id: 'note_heard_reaction', authorName: 'Ben', reaction: '😢', t: 0.04, kind: 'audio', editionId: 'edition_audio', locator: { kind: 'audio', track: 0, ms: 200_000 } }]);
    const line = note('note_reaction').querySelector('.note-locked')!;
    expect(line.getAttribute('data-closed')).toBe('ahead');
    expect(line.textContent?.trim()).toBe('Ana reacted 🤯 here, with no words.');
    // Nothing locked away: no lock, and no "when you get there".
    expect(line.querySelector('svg')).toBeNull();
    expect(note('note_reaction').textContent).not.toContain('when you get there');
    // Made while listening, about where you have read: the same, and where it was made.
    expect(note('note_heard_reaction').querySelector('.note-locked')!.textContent?.trim()).toBe('Ben reacted 😢 while listening, about here, with no words.');
    expect(note('note_heard_reaction').textContent).not.toContain('opens');
  });

  it('a deleted note ahead of you says it was deleted, not that a reaction waits', () => {
    const note = discussion([{ ...ahead, id: 'note_gone', hasText: false, deleted: true }]);
    expect(note('note_gone').querySelector('.note-locked')!.textContent?.trim()).toBe('This note was deleted.');
  });

  it('a note made in another format but ahead of you says only that a note waits there', () => {
    const note = discussion([{ ...heard, t: 0.4 }], []);
    expect(note('note_heard').textContent).toContain('A note waits here. You will see it when you get there.');
  });
});
