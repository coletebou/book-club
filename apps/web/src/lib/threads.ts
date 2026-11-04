import type { CommentView } from '@bookclub/shared';

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
