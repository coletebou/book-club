import { type Db } from '../db/db';
import { newId } from '../lib/crypto';

/** One uploaded picture (D203) or recording (D276). */
export interface ChatAttachmentRow {
  id: string;
  message_id: string | null;
  club_id: string;
  user_id: string;
  idx: number;
  kind: 'image' | 'voice';
  status: 'processing' | 'ready' | 'failed';
  blob_id: string | null;
  thumb_blob_id: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

export function insertChatAttachment(db: Db, input: { userId: string; clubId: string; kind?: ChatAttachmentRow['kind'] }): ChatAttachmentRow {
  const row: ChatAttachmentRow = {
    id: newId(),
    message_id: null,
    club_id: input.clubId,
    user_id: input.userId,
    idx: 0,
    kind: input.kind ?? 'image',
    status: 'processing',
    blob_id: null,
    thumb_blob_id: null,
    mime: null,
    width: null,
    height: null,
    duration_ms: null,
    error: null,
    created_at: Date.now(),
  };
  db.exec(
    `INSERT INTO chat_attachments (id, message_id, club_id, user_id, idx, kind, status, created_at) VALUES (?, NULL, ?, ?, 0, ?, 'processing', ?)`,
    [row.id, row.club_id, row.user_id, row.kind, row.created_at],
  );
  return row;
}

export function chatAttachmentById(db: Db, id: string): ChatAttachmentRow | undefined {
  return db.get<ChatAttachmentRow>('SELECT * FROM chat_attachments WHERE id = ?', [id]);
}

export interface ProcessedChatAttachment {
  readonly status: 'ready' | 'failed';
  readonly blobId: string | null;
  readonly thumbBlobId: string | null;
  readonly mime: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs?: number | null;
  readonly error: string | null;
}

export function markAttachmentProcessed(db: Db, id: string, result: ProcessedChatAttachment): void {
  db.exec('UPDATE chat_attachments SET status = ?, blob_id = ?, thumb_blob_id = ?, mime = ?, width = ?, height = ?, duration_ms = ?, error = ? WHERE id = ?', [
    result.status,
    result.blobId,
    result.thumbBlobId,
    result.mime,
    result.width,
    result.height,
    result.durationMs ?? null,
    result.error,
    id,
  ]);
}

/**
 * Claim uploads for a message just created, in the order asked: true when every id
 * named is an upload of this person's for this club, ready, and not yet sent with anything. Called
 * inside the transaction that creates the message, so a retry or a race claims nothing twice and a
 * message is never left with only some of what its writer meant to send.
 */
export function attachToMessage(db: Db, messageId: string, userId: string, clubId: string, ids: readonly string[]): boolean {
  if (ids.length === 0) return true;
  const placeholders = ids.map(() => '?').join(', ');
  const ready = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM chat_attachments WHERE message_id IS NULL AND status = 'ready' AND user_id = ? AND club_id = ? AND id IN (${placeholders})`,
    [userId, clubId, ...ids],
  );
  if (Number(ready?.n ?? 0) !== ids.length) return false;
  ids.forEach((id, idx) => db.exec('UPDATE chat_attachments SET message_id = ?, idx = ? WHERE id = ? AND message_id IS NULL', [messageId, idx, id]));
  return true;
}

/** Many messages' pictures in one query, each message's in order. */
export function attachmentsForMessages(db: Db, messageIds: readonly string[]): Map<string, ChatAttachmentRow[]> {
  const out = new Map<string, ChatAttachmentRow[]>();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => '?').join(', ');
  for (const row of db.all<ChatAttachmentRow>(`SELECT * FROM chat_attachments WHERE message_id IN (${placeholders}) ORDER BY message_id, idx`, [...messageIds])) {
    const list = out.get(row.message_id!);
    if (list) list.push(row);
    else out.set(row.message_id!, [row]);
  }
  return out;
}

/** A message's attachments, taken off it to delete them with it (the caller removes the bytes). */
export function takeAttachmentsOf(db: Db, messageId: string): ChatAttachmentRow[] {
  const rows = db.all<ChatAttachmentRow>('SELECT * FROM chat_attachments WHERE message_id = ? ORDER BY idx', [messageId]);
  if (rows.length > 0) db.exec('DELETE FROM chat_attachments WHERE message_id = ?', [messageId]);
  return rows;
}

/** Attachments uploaded but never sent, older than `olderThanMs` (an abandoned composer). */
export function orphanChatAttachments(db: Db, olderThanMs: number): ChatAttachmentRow[] {
  return db.all<ChatAttachmentRow>('SELECT * FROM chat_attachments WHERE message_id IS NULL AND created_at < ?', [Date.now() - olderThanMs]);
}

export function deleteChatAttachmentRow(db: Db, id: string): void {
  db.exec('DELETE FROM chat_attachments WHERE id = ?', [id]);
}

/** An attachment's stored bytes. */
export function blobsOf(row: Pick<ChatAttachmentRow, 'blob_id' | 'thumb_blob_id'>): string[] {
  return [row.blob_id, row.thumb_blob_id].filter((id): id is string => id !== null);
}
