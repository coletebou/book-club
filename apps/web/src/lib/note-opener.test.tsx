import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteHref, openNoteHere, readingHere, showNote, useNoteOpener } from './note-opener';

afterEach(cleanup);

function Reader({ bookId, notes, onOpen }: { bookId: string; notes: readonly string[]; onOpen: (id: string) => void }) {
  useNoteOpener(bookId, (id) => {
    if (!notes.includes(id)) return false;
    onOpen(id);
    return true;
  });
  return null;
}

describe('showing a note from a toast', () => {
  it('opens it in the reader of its book while one is open, with the reader’s latest notes', () => {
    const opened: string[] = [];
    const { rerender, unmount } = render(<Reader bookId="book_1" notes={['n1']} onOpen={(id) => opened.push(id)} />);
    expect(readingHere('book_1')).toBe(true);
    expect(readingHere('book_2')).toBe(false);
    expect(openNoteHere('book_1', 'n1')).toBe(true);
    // A note the reader does not have (deleted since): not opened there.
    expect(openNoteHere('book_1', 'n2')).toBe(false);
    rerender(<Reader bookId="book_1" notes={['n1', 'n2']} onOpen={(id) => opened.push(id)} />);
    expect(openNoteHere('book_1', 'n2')).toBe(true);
    expect(opened).toEqual(['n1', 'n2']);
    unmount();
    expect(readingHere('book_1')).toBe(false);
    expect(openNoteHere('book_1', 'n1')).toBe(false);
  });

  it('else goes to the note on the book page, naming the answer in it', () => {
    const navigate = vi.fn();
    showNote(navigate, { bookId: 'book_1', noteId: 'n1', commentId: 'r1' });
    showNote(navigate, { bookId: 'book_1', noteId: 'n1', commentId: 'n1' });
    expect(navigate.mock.calls).toEqual([
      ['/books/book_1#note-n1', { state: { comment: 'r1' } }],
      ['/books/book_1#note-n1', undefined],
    ]);
    expect(noteHref({ bookId: 'b', noteId: 'n' })).toEqual({ to: '/books/b#note-n' });
  });

  it('does not go anywhere when the reader there opened it', () => {
    const navigate = vi.fn();
    render(<Reader bookId="book_1" notes={['n1']} onOpen={() => undefined} />);
    showNote(navigate, { bookId: 'book_1', noteId: 'n1', commentId: 'r1' });
    expect(navigate).not.toHaveBeenCalled();
  });
});
