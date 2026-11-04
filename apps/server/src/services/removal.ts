import { voiceRoomName } from '@bookclub/shared';
import { type AppContext } from '../context';
import { type Db } from '../db/db';
import { deleteUnusedBlobRow } from '../repos/blobs';
import { editionFiles, editionsForBook } from '../repos/books';
import { disconnectParticipant } from './livekit';
import { stopTranscriptionOf } from './readalong';

/*
 * Removing a club or a book (D179) is a soft delete: the row is marked `deleted_at` and the app
 * treats it as gone (`clubById` and `bookById` no longer find it, so every access check answers
 * 404 and every list leaves it out), while its data and files stay on the server. The server's
 * admin can bring it back (`bookclub undelete`) or remove it for good (`bookclub purge`).
 */

/**
 * End a member's voice in a club: the club's own room and every ad hoc room of it this hub has
 * heard them join (PR #13 security review). The hub's `revoke` only stops app events, never an
 * already live LiveKit RTC session, so whoever leaves a club's voice must also be cut off there.
 */
export function endClubVoiceFor(ctx: AppContext, clubId: string, userId: string): void {
  const prefix = voiceRoomName(clubId, 'club'); // "club:<clubId>"; its own ad hoc rooms are "club:<clubId>:adhoc:<id>"
  const clubRooms = ctx.hub.voiceRoomsFor(userId).filter((name) => name === prefix || name.startsWith(`${prefix}:`));
  for (const roomName of new Set([prefix, ...clubRooms])) {
    ctx.hub.forceVoiceLeave(roomName, userId); // our own presence, so others see them leave immediately
    if (ctx.config.livekit) void disconnectParticipant(ctx.config.livekit, roomName, userId); // the real RTC session
  }
}

const memberIdsOf = (db: Db, clubId: string) => db.all<{ user_id: string }>('SELECT user_id FROM memberships WHERE club_id = ?', [clubId]).map((r) => r.user_id);

/** Disband a club (soft): gone for every member at once, even when its owner is its only one. */
export function disbandClub(ctx: AppContext, clubId: string, userId: string): void {
  const memberIds = memberIdsOf(ctx.db, clubId);
  for (const id of memberIds) endClubVoiceFor(ctx, clubId, id);
  // Told while they still hear the club: their apps drop it from their lists, then hear no more of it.
  ctx.hub.publish(clubId, () => ({ type: 'club:changed', clubId }));
  ctx.db.exec('UPDATE clubs SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL', [Date.now(), userId, clubId]);
  for (const id of memberIds) ctx.hub.revoke(clubId, id);
  ctx.log.info({ club: clubId, by: userId, members: memberIds.length }, 'club disbanded (recoverable)');
}

/** Remove a book from its club (soft): its formats, notes and places stay on the server. */
export function removeBook(ctx: AppContext, bookId: string, clubId: string, userId: string): void {
  ctx.db.exec('UPDATE books SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL', [Date.now(), userId, bookId]);
  ctx.hub.publish(clubId, () => ({ type: 'book:changed', clubId, bookId }));
  ctx.log.info({ book: bookId, club: clubId, by: userId }, 'book removed (recoverable)');
}

export interface DeletedRow {
  readonly kind: 'club' | 'book';
  readonly id: string;
  readonly name: string;
  readonly clubId: string;
  readonly deletedAt: number;
  readonly deletedBy: string | null;
}

export function listDeleted(db: Db): DeletedRow[] {
  return db.all<DeletedRow>(
    `SELECT 'club' AS kind, id, name, id AS clubId, deleted_at AS deletedAt, deleted_by AS deletedBy FROM clubs WHERE deleted_at IS NOT NULL
     UNION ALL
     SELECT 'book' AS kind, id, title AS name, club_id AS clubId, deleted_at AS deletedAt, deleted_by AS deletedBy FROM books WHERE deleted_at IS NOT NULL
     ORDER BY deletedAt DESC`,
  );
}

/** Bring a disbanded club or a removed book back, as it was. False when there is no such deleted row. */
export function undelete(ctx: AppContext, kind: 'club' | 'book', id: string): boolean {
  const table = kind === 'club' ? 'clubs' : 'books';
  const changed = ctx.db.exec(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL`, [id]).changes > 0;
  if (changed && kind === 'club') ctx.hub.publish(id, () => ({ type: 'club:changed', clubId: id }));
  return changed;
}

/** Remove what an edition (or a book's cover) leaves behind once no other row names it. */
export async function removeFiles(ctx: AppContext, editionIds: readonly string[], blobIds: Iterable<string>): Promise<void> {
  for (const id of editionIds) await ctx.storage.removePub(id);
  for (const blobId of new Set(blobIds)) {
    if (deleteUnusedBlobRow(ctx.db, blobId)) await ctx.storage.removeBlob(blobId);
  }
}

/** A book for good (`bookclub purge --book`): its rows, then the files no other book still uses. */
export async function purgeBook(ctx: AppContext, bookId: string): Promise<boolean> {
  const book = ctx.db.get<{ cover_blob_id: string | null }>('SELECT cover_blob_id FROM books WHERE id = ?', [bookId]);
  if (!book) return false;
  const editions = editionsForBook(ctx.db, bookId);
  const media = ctx.db.all<{ a: string | null; b: string | null; c: string | null }>(
    'SELECT original_blob_id AS a, derived_blob_id AS b, poster_blob_id AS c FROM comment_media WHERE book_id = ?',
    [bookId],
  );
  const blobIds = [
    ...editions.flatMap((e) => editionFiles(ctx.db, e.id).map((f) => f.blob_id)),
    ...(book.cover_blob_id ? [book.cover_blob_id] : []),
    ...media.flatMap((m) => [m.a, m.b, m.c].filter((x): x is string => !!x)),
  ];
  for (const e of editions) if (e.kind === 'audio') stopTranscriptionOf(ctx, e.id);
  ctx.db.tx(() => {
    clearIndexStatus(ctx.db, 'edition', editions.map((e) => e.id));
    ctx.db.exec('DELETE FROM books WHERE id = ?', [bookId]);
  });
  await removeFiles(ctx, editions.map((e) => e.id), blobIds);
  return true;
}

/** A club for good (`bookclub purge --club`): every book of it, its shelf, then the club itself. */
export async function purgeClub(ctx: AppContext, clubId: string): Promise<boolean> {
  if (!ctx.db.get('SELECT 1 AS x FROM clubs WHERE id = ?', [clubId])) return false;
  for (const { id } of ctx.db.all<{ id: string }>('SELECT id FROM books WHERE club_id = ?', [clubId])) await purgeBook(ctx, id);
  const shelf = ctx.db.all<{ id: string; blob_id: string | null }>('SELECT id, blob_id FROM cal_shelf_items WHERE club_id = ?', [clubId]);
  ctx.db.tx(() => {
    clearIndexStatus(ctx.db, 'shelf_item', shelf.map((s) => s.id));
    ctx.db.exec('DELETE FROM clubs WHERE id = ?', [clubId]);
  });
  await removeFiles(ctx, [], shelf.flatMap((s) => (s.blob_id ? [s.blob_id] : [])));
  return true;
}

/** Cal's indexing status names editions and shelf items by id alone (no foreign key to cascade). */
function clearIndexStatus(db: Db, kind: 'edition' | 'shelf_item', ids: readonly string[]): void {
  if (ids.length) db.exec('DELETE FROM cal_index_status WHERE kind = ? AND ref_id IN (SELECT value FROM json_each(?))', [kind, JSON.stringify(ids)]);
}
