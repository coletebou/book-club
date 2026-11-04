import { type Db } from '../db/db';
import { newId } from '../lib/crypto';

/** A note or reply's voice recording, photo or video (D140), one row per file. */
export interface CommentMediaRow {
  id: string;
  comment_id: string | null;
  user_id: string;
  book_id: string;
  idx: number;
  kind: 'voice' | 'photo' | 'video';
  status: 'processing' | 'ready' | 'failed';
  original_blob_id: string | null;
  derived_blob_id: string | null;
  poster_blob_id: string | null;
  mime: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  transcript: string | null;
  transcript_status: 'none' | 'queued' | 'ready' | 'failed';
  error: string | null;
  created_at: number;
}

export function insertCommentMedia(
  db: Db,
  input: { userId: string; bookId: string; kind: CommentMediaRow['kind'] },
): CommentMediaRow {
  const id = newId();
  const created_at = Date.now();
  db.exec(
    `INSERT INTO comment_media (id, comment_id, user_id, book_id, idx, kind, status, created_at)
     VALUES (?, NULL, ?, ?, 0, ?, 'processing', ?)`,
    [id, input.userId, input.bookId, input.kind, created_at],
  );
  return {
    id,
    comment_id: null,
    user_id: input.userId,
    book_id: input.bookId,
    idx: 0,
    kind: input.kind,
    status: 'processing',
    original_blob_id: null,
    derived_blob_id: null,
    poster_blob_id: null,
    mime: null,
    duration_ms: null,
    width: null,
    height: null,
    transcript: null,
    transcript_status: 'none',
    error: null,
    created_at,
  };
}

export function commentMediaById(db: Db, id: string): CommentMediaRow | undefined {
  return db.get<CommentMediaRow>('SELECT * FROM comment_media WHERE id = ?', [id]);
}

export interface ProcessedMedia {
  readonly status: 'ready' | 'failed';
  readonly originalBlobId: string | null;
  readonly derivedBlobId: string | null;
  readonly posterBlobId: string | null;
  readonly mime: string | null;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
  /** 'queued': a transcript will follow in the background (voice only, TRANSCRIBE_COMMAND set). */
  readonly transcriptStatus: CommentMediaRow['transcript_status'];
  readonly error: string | null;
}

export function markMediaProcessed(db: Db, id: string, result: ProcessedMedia): void {
  db.exec(
    `UPDATE comment_media SET status = ?, original_blob_id = ?, derived_blob_id = ?, poster_blob_id = ?, mime = ?,
       duration_ms = ?, width = ?, height = ?, transcript_status = ?, error = ? WHERE id = ?`,
    [
      result.status,
      result.originalBlobId,
      result.derivedBlobId,
      result.posterBlobId,
      result.mime,
      result.durationMs,
      result.width,
      result.height,
      result.transcriptStatus,
      result.error,
      id,
    ],
  );
}

export function setMediaTranscript(db: Db, id: string, transcript: string | null, status: CommentMediaRow['transcript_status']): void {
  db.exec('UPDATE comment_media SET transcript = ?, transcript_status = ? WHERE id = ?', [transcript, status, id]);
}

/** Media still unclaimed (no note posted yet), owned by whoever uploaded them, this book's. */
export function unclaimedMedia(db: Db, userId: string, bookId: string, ids: readonly string[]): CommentMediaRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.all<CommentMediaRow>(
    `SELECT * FROM comment_media WHERE comment_id IS NULL AND user_id = ? AND book_id = ? AND id IN (${placeholders})`,
    [userId, bookId, ...ids],
  );
}

/**
 * Claim uploaded media for a freshly created note or reply, in the order asked: true when every
 * id named was still unclaimed and theirs (a race, or an id already spent, fails the whole
 * attachment, so a note is never left with only some of what its writer meant to attach).
 */
export function attachMedia(db: Db, commentId: string, userId: string, bookId: string, ids: readonly string[]): boolean {
  // Called inside the transaction that creates the comment: nothing else can claim these ids
  // between this read and the updates below, so one query settles whether every id is theirs.
  if (unclaimedMedia(db, userId, bookId, ids).length !== ids.length) return false;
  ids.forEach((id, idx) => {
    db.exec('UPDATE comment_media SET comment_id = ?, idx = ? WHERE id = ? AND comment_id IS NULL', [commentId, idx, id]);
  });
  return true;
}

export function mediaForComment(db: Db, commentId: string): CommentMediaRow[] {
  return db.all<CommentMediaRow>('SELECT * FROM comment_media WHERE comment_id = ? ORDER BY idx', [commentId]);
}

/** One query for many comments (the discussion list), grouped by comment id, each ordered by idx. */
export function mediaForComments(db: Db, commentIds: readonly string[]): Map<string, CommentMediaRow[]> {
  const out = new Map<string, CommentMediaRow[]>();
  if (commentIds.length === 0) return out;
  const placeholders = commentIds.map(() => '?').join(', ');
  for (const row of db.all<CommentMediaRow>(`SELECT * FROM comment_media WHERE comment_id IN (${placeholders}) ORDER BY comment_id, idx`, [...commentIds])) {
    const list = out.get(row.comment_id!);
    if (list) list.push(row);
    else out.set(row.comment_id!, [row]);
  }
  return out;
}

/** A note's media, for deleting it (repos/comments.ts: softDeleteComment removes the files too). */
export function takeMediaForComment(db: Db, commentId: string): CommentMediaRow[] {
  const rows = mediaForComment(db, commentId);
  if (rows.length > 0) db.exec('DELETE FROM comment_media WHERE comment_id = ?', [commentId]);
  return rows;
}

/** Uploaded media nobody attached to a note, older than `olderThanMs` (an abandoned composer). */
export function orphanMedia(db: Db, olderThanMs: number): CommentMediaRow[] {
  return db.all<CommentMediaRow>('SELECT * FROM comment_media WHERE comment_id IS NULL AND created_at < ?', [Date.now() - olderThanMs]);
}

export function deleteCommentMediaRow(db: Db, id: string): void {
  db.exec('DELETE FROM comment_media WHERE id = ?', [id]);
}
