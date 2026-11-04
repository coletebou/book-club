import { type EditionKind, type Locator, type Reaction } from '@bookclub/shared';
import { type Db } from '../db/db';
import { newId } from '../lib/crypto';
import { toJson } from '../lib/json';

export interface CommentRow {
  id: string;
  book_id: string;
  user_id: string;
  edition_id: string;
  kind: EditionKind;
  locator_json: string;
  end_locator_json: string | null;
  t: number;
  end_t: number | null;
  quote: string | null;
  text: string | null;
  reaction: Reaction | null;
  client_id: string | null;
  created_at: number;
  deleted_at: number | null;
  /** The note a reply answers (D48); null for a note. */
  parent_id: string | null;
  /**
   * Where its writer had read to when they wrote it, when that was past its place (D69): the
   * edition, the place there and its t. Null for none.
   */
  horizon_edition_id: string | null;
  horizon_locator_json: string | null;
  horizon_t: number | null;
}

/** Where a comment's writer had read to when they wrote it (D69): a place in one edition. */
export interface Horizon {
  readonly editionId: string;
  readonly locator: Locator;
  readonly t: number;
}

export interface CommentWithAuthor extends CommentRow {
  author_name: string;
  /** The author's colour slot in the book's club; null once they have left it. */
  author_slot: number | null;
}

/** A comment with its author's name and colour slot in the club. */
const WITH_AUTHOR = `SELECT c.*, u.display_name AS author_name, m.color AS author_slot
   FROM comments c
   JOIN users u ON u.id = c.user_id
   JOIN books b ON b.id = c.book_id
   LEFT JOIN memberships m ON m.club_id = b.club_id AND m.user_id = c.user_id
   LEFT JOIN comments p ON p.id = c.parent_id`;

export function commentById(db: Db, id: string): CommentWithAuthor | undefined {
  return db.get<CommentWithAuthor>(
    `${WITH_AUTHOR} WHERE c.id = ? AND c.deleted_at IS NULL`,
    [id],
  );
}

/** The comment a client id was used for, deleted or not (the id stays taken, as in the unique index). */
export function commentByClientId(db: Db, userId: string, clientId: string): CommentWithAuthor | undefined {
  return db.get<CommentWithAuthor>(
    `${WITH_AUTHOR} WHERE c.user_id = ? AND c.client_id = ?`,
    [userId, clientId],
  );
}

/**
 * A book's notes and replies in timeline order (replies after their note, oldest first). A deleted
 * note with replies stays, as a placeholder without its words, so the replies keep their place.
 */
export function commentsForBook(db: Db, bookId: string): CommentWithAuthor[] {
  return db.all<CommentWithAuthor>(
    `${WITH_AUTHOR} WHERE c.book_id = ? AND (c.deleted_at IS NULL OR (c.parent_id IS NULL AND EXISTS (
       SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.deleted_at IS NULL)))
     ORDER BY c.t, COALESCE(p.created_at, c.created_at), COALESCE(c.parent_id, c.id), c.parent_id IS NOT NULL, c.created_at`,
    [bookId],
  );
}

/** The live replies to a note, oldest first. */
export function repliesTo(db: Db, parentId: string): CommentWithAuthor[] {
  return db.all<CommentWithAuthor>(`${WITH_AUTHOR} WHERE c.parent_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at`, [parentId]);
}

export function countCommentsForBook(db: Db, bookId: string): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE book_id = ? AND deleted_at IS NULL AND parent_id IS NULL', [bookId])?.n ?? 0);
}

export function insertComment(
  db: Db,
  input: {
    bookId: string;
    userId: string;
    editionId: string;
    kind: EditionKind;
    locator: Locator;
    endLocator: Locator | null;
    t: number;
    endT: number | null;
    quote: string | null;
    text: string | null;
    reaction: Reaction | null;
    clientId: string | null;
    parentId?: string | null;
    /** Where its writer had read to, when past its place (D69). */
    horizon?: Horizon | null;
  },
): string {
  const id = newId();
  db.exec(
    `INSERT INTO comments (id, book_id, user_id, edition_id, kind, locator_json, end_locator_json, t, end_t, quote, text, reaction, client_id, created_at, parent_id,
       horizon_edition_id, horizon_locator_json, horizon_t)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.bookId,
      input.userId,
      input.editionId,
      input.kind,
      toJson(input.locator),
      input.endLocator ? toJson(input.endLocator) : null,
      input.t,
      input.endT,
      input.quote,
      input.text,
      input.reaction,
      input.clientId,
      Date.now(),
      input.parentId ?? null,
      input.horizon?.editionId ?? null,
      input.horizon ? toJson(input.horizon.locator) : null,
      input.horizon?.t ?? null,
    ],
  );
  return id;
}

/**
 * Delete a comment: its words go at once (an empty text keeps the row valid), and with them what
 * held them (D69); the row stays so a retried post with the same client id cannot bring it back.
 */
export function softDeleteComment(db: Db, id: string): void {
  db.exec(
    `UPDATE comments SET deleted_at = ?, text = CASE WHEN text IS NULL THEN NULL ELSE '' END, quote = NULL,
       horizon_edition_id = NULL, horizon_locator_json = NULL, horizon_t = NULL WHERE id = ?`,
    [Date.now(), id],
  );
}
