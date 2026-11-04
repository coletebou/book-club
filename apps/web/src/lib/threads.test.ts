import type { CommentView } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { splitThreads } from './threads';

const view = (id: string, createdAt: string, parentId: string | null = null): CommentView => ({
  id,
  bookId: 'book_alice',
  userId: 'user_ana',
  authorName: 'Ana',
  color: '#FF6B6B',
  t: 0.2,
  editionId: 'ed_epub_1',
  kind: 'epub',
  locator: { kind: 'epub', section: 2, offset: 10 },
  reaction: null,
  createdAt,
  parentId,
  hidden: false,
  endLocator: null,
  endT: null,
  quote: null,
  text: id,
});

describe('splitThreads', () => {
  it('keeps notes in order and gathers each note’s replies under it, oldest first', () => {
    const { notes, replies } = splitThreads([
      view('note_1', '2026-10-20T10:00:00.000Z'),
      view('reply_2', '2026-10-20T12:00:00.000Z', 'note_1'),
      view('note_2', '2026-10-20T10:30:00.000Z'),
      view('reply_1', '2026-10-20T11:00:00.000Z', 'note_1'),
    ]);
    expect(notes.map((n) => n.id)).toEqual(['note_1', 'note_2']);
    expect(replies.get('note_1')!.map((r) => r.id)).toEqual(['reply_1', 'reply_2']);
    expect(replies.get('note_2')).toBeUndefined();
  });
});
