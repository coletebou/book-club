import type { Chapter, CommentView } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { answerOpenText, inConversation, wherePhrase } from './answer-open';

const chapters: Chapter[] = [
  { index: 0, title: 'Alice’s Adventures in Wonderland', t: 0 },
  { index: 1, title: 'THE MILLENNIUM FULCRUM EDITION 3.0', t: 0.0002 },
  { index: 2, title: 'Contents', t: 0.001 },
  { index: 3, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0.004 },
  { index: 4, title: 'CHAPTER II. The Pool of Tears', t: 0.083 },
  { index: 5, title: 'CHAPTER III. A Caucus-Race and a Long Tale', t: 0.159 },
];

const comment = (id: string, userId: string, authorName: string, t: number, parentId: string | null = null): CommentView => ({
  id,
  bookId: 'book_1',
  userId,
  authorName,
  color: '#D6B85E',
  t,
  editionId: 'ed_1',
  kind: 'epub',
  locator: { kind: 'epub', section: 3, offset: 0 },
  reaction: null,
  createdAt: '2026-10-25T10:00:00.000Z',
  parentId,
  hidden: false,
  endLocator: null,
  endT: null,
  quote: null,
  text: 'words',
});

describe('who is in a note’s conversation', () => {
  const note = comment('cm_note', 'user_cole', 'Cole', 0.2);
  const thread = [note, comment('cm_a', 'user_ana', 'Ana', 0.2, 'cm_note'), comment('cm_b', 'user_ben', 'Ben', 0.3, 'cm_other')];

  it('is its writer and whoever answered it, nobody else', () => {
    expect(inConversation(note, thread, 'user_cole')).toBe(true);
    expect(inConversation(note, thread, 'user_ana')).toBe(true);
    // Ben answered another note.
    expect(inConversation(note, thread, 'user_ben')).toBe(false);
    expect(inConversation(note, thread, 'user_dora')).toBe(false);
    expect(inConversation(note, thread, undefined)).toBe(false);
  });
});

describe('what you are told as an answer opens', () => {
  const note = comment('cm_note', 'user_cole', 'Cole', 0.1);
  const answer = comment('cm_answer', 'user_ana', 'Ana', 0.1, 'cm_note');

  it('names whose note it answers, and where', () => {
    expect(answerOpenText({ answer, note }, 'user_dee', chapters)).toBe('Ana’s answer to Cole’s note in Chapter 2 is open now.');
    expect(answerOpenText({ answer, note }, 'user_cole', chapters)).toBe('Ana’s answer to your note in Chapter 2 is open now.');
    expect(answerOpenText({ answer: { ...answer, userId: 'user_cole', authorName: 'Cole' }, note }, 'user_dee', chapters)).toBe('Cole’s answer to their own note in Chapter 2 is open now.');
  });

  it('says where in words that read: in a chapter, before the first, or how far into a book without chapters', () => {
    expect(wherePhrase(chapters, 0.2)).toBe('in Chapter 3');
    expect(wherePhrase(chapters, 0.0005)).toBe('before Chapter 1');
    expect(wherePhrase([], 0.24)).toBe('at 24%');
  });
});
