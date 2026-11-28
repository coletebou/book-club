import type { CommentView } from '@bookclub/shared';
import { useMemo } from 'react';

/** A book's notes (what has a place in the book) and the replies under each, oldest first (D48). */
export interface Threads {
  readonly notes: CommentView[];
  readonly replies: ReadonlyMap<string, CommentView[]>;
}

export function splitThreads(all: readonly CommentView[]): Threads {
  const notes: CommentView[] = [];
  const replies = new Map<string, CommentView[]>();
  for (const c of all) {
    if (!c.parentId) {
      notes.push(c);
      continue;
    }
    const list = replies.get(c.parentId) ?? [];
    list.push(c);
    replies.set(c.parentId, list);
  }
  for (const list of replies.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { notes, replies };
}

export const NO_REPLIES: ReadonlyMap<string, CommentView[]> = new Map();

/** Keep the selected rows stable while the reader changes position or plays audio. */
export function useSheetComments(notes: readonly CommentView[] | undefined, selection: readonly string[] | null): readonly CommentView[] {
  return useMemo(() => {
    if (!notes || !selection) return [];
    const selected = new Set(selection);
    return notes.filter((note) => selected.has(note.id));
  }, [notes, selection]);
}
