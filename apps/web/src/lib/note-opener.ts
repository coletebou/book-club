import { useEffect, useRef } from 'react';

/*
 * Showing a note's conversation from wherever you are (a toast's "Show", D89): the reader of its
 * book, if one is open, opens its sheet there; anywhere else, you go to the note on the book page
 * (`#note-<id>`, D85), which marks it, or the answer the link names.
 */

/** Opens a note's sheet in a reader, if that reader has the note: whether it did. */
type Opener = (noteId: string) => boolean;

const openers = new Map<string, Opener>();

/** While mounted, notes of this book are shown here (the reader's note sheet). */
export function useNoteOpener(bookId: string, open: Opener): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const opener: Opener = (noteId) => latest.current(noteId);
    openers.set(bookId, opener);
    return () => {
      if (openers.get(bookId) === opener) openers.delete(bookId);
    };
  }, [bookId]);
}

/** Whether a reader of this book is open, which shows its notes where you are. */
export function readingHere(bookId: string): boolean {
  return openers.has(bookId);
}

/** Opens a note in the reader of its book if one is open and has it; whether it did. */
export function openNoteHere(bookId: string, noteId: string): boolean {
  return openers.get(bookId)?.(noteId) ?? false;
}

/** Where to go for a note's conversation from outside its reader: the book page at the note (an answer in it, in the state). */
export function noteHref(target: { bookId: string; noteId: string; commentId?: string }): { to: string; state?: { comment: string } } {
  const to = `/books/${target.bookId}#note-${target.noteId}`;
  return target.commentId && target.commentId !== target.noteId ? { to, state: { comment: target.commentId } } : { to };
}

/** Shows a note's conversation: in its book's reader, if open; else by going to it on the book page. */
export function showNote(navigate: (to: string, options?: { state?: unknown }) => unknown, target: { bookId: string; noteId: string; commentId?: string }): void {
  if (openNoteHere(target.bookId, target.noteId)) return;
  const { to, state } = noteHref(target);
  void navigate(to, state ? { state } : undefined);
}
