import { type Db } from '../db/db';
import { newId } from '../lib/crypto';

export interface ChatMessageRow {
  id: string;
  club_id: string;
  book_id: string | null;
  user_id: string;
  parent_id: string | null;
  text: string;
  spoiler_t: number | null;
  spoiler_edition_id: string | null;
  client_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export interface ChatMessageWithAuthor extends ChatMessageRow {
  author_name: string;
  author_color: string | null;
}

const WITH_AUTHOR = `SELECT m.*, u.display_name AS author_name, mm.color AS author_color
   FROM chat_messages m
   JOIN users u ON u.id = m.user_id
   LEFT JOIN memberships mm ON mm.club_id = m.club_id AND mm.user_id = m.user_id`;

export function chatMessageById(db: Db, id: string): ChatMessageWithAuthor | undefined {
  return db.get<ChatMessageWithAuthor>(`${WITH_AUTHOR} WHERE m.id = ?`, [id]);
}

export function chatMessageByClientId(db: Db, userId: string, clientId: string): ChatMessageWithAuthor | undefined {
  return db.get<ChatMessageWithAuthor>(`${WITH_AUTHOR} WHERE m.user_id = ? AND m.client_id = ?`, [userId, clientId]);
}

/**
 * A page of a club's chat, newest first (`before`: strictly older than that message). Deleted
 * messages stay as placeholders when they have replies, like comments (repos/comments.ts).
 * `channel` (D199) narrows the page to one channel: `general` is the messages tagged to no book,
 * a book id that book's own; absent, it is the club's whole stream.
 */
export function chatMessagesForClub(db: Db, clubId: string, options: { before?: string; limit: number; channel?: string }): ChatMessageWithAuthor[] {
  const where = ['m.club_id = ?'];
  const params: (string | number)[] = [clubId];
  if (options.channel === 'general') where.push('m.book_id IS NULL');
  else if (options.channel) {
    where.push('m.book_id = ?');
    params.push(options.channel);
  }
  const cursor = options.before ? db.get<{ created_at: number; id: string }>('SELECT created_at, id FROM chat_messages WHERE id = ? AND club_id = ?', [options.before, clubId]) : undefined;
  if (cursor) {
    where.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))');
    params.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  params.push(options.limit);
  return db.all<ChatMessageWithAuthor>(`${WITH_AUTHOR} WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`, params);
}

export function reactionsFor(db: Db, messageIds: readonly string[]): Map<string, { emoji: string; user_id: string }[]> {
  const out = new Map<string, { emoji: string; user_id: string }[]>();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => '?').join(',');
  for (const row of db.all<{ message_id: string; emoji: string; user_id: string }>(
    `SELECT message_id, emoji, user_id FROM chat_reactions WHERE message_id IN (${placeholders})`,
    [...messageIds],
  )) {
    const list = out.get(row.message_id) ?? [];
    list.push({ emoji: row.emoji, user_id: row.user_id });
    out.set(row.message_id, list);
  }
  return out;
}

export function insertChatMessage(
  db: Db,
  input: {
    clubId: string;
    bookId: string | null;
    userId: string;
    text: string;
    parentId: string | null;
    clientId: string | null;
    spoilerT: number | null;
    spoilerEditionId: string | null;
  },
): string {
  const id = newId();
  db.exec(
    `INSERT INTO chat_messages (id, club_id, book_id, user_id, parent_id, text, spoiler_t, spoiler_edition_id, client_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.clubId, input.bookId, input.userId, input.parentId, input.text, input.spoilerT, input.spoilerEditionId, input.clientId, Date.now()],
  );
  return id;
}

export function editChatMessage(db: Db, id: string, text: string): void {
  db.exec('UPDATE chat_messages SET text = ?, edited_at = ? WHERE id = ?', [text, Date.now(), id]);
}

/** A delete that has replies stays as a placeholder (its words gone), like a deleted comment. */
export function deleteChatMessage(db: Db, id: string): void {
  db.exec('UPDATE chat_messages SET deleted_at = ? WHERE id = ?', [Date.now(), id]);
}

export function setReaction(db: Db, messageId: string, userId: string, emoji: string, on: boolean): void {
  if (on) db.exec('INSERT OR IGNORE INTO chat_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', [messageId, userId, emoji, Date.now()]);
  else db.exec('DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, userId, emoji]);
}

export interface ChatReadRow {
  club_id: string;
  user_id: string;
  last_read_at: number;
  last_read_message_id: string | null;
}

export function chatReadOf(db: Db, clubId: string, userId: string): ChatReadRow | undefined {
  return db.get<ChatReadRow>('SELECT * FROM chat_reads WHERE club_id = ? AND user_id = ?', [clubId, userId]);
}

export function markChatRead(db: Db, clubId: string, userId: string, messageId: string | null): void {
  const now = Date.now();
  db.exec(
    `INSERT INTO chat_reads (club_id, user_id, last_read_at, last_read_message_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (club_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at, last_read_message_id = excluded.last_read_message_id
     WHERE excluded.last_read_at >= chat_reads.last_read_at`,
    [clubId, userId, now, messageId],
  );
}

/** Unread messages in the club's chat: anything after the member's read cursor, not written by them. */
export function unreadChatCount(db: Db, clubId: string, userId: string): number {
  const read = chatReadOf(db, clubId, userId);
  const since = read?.last_read_at ?? 0;
  return Number(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_messages WHERE club_id = ? AND created_at > ? AND user_id != ? AND deleted_at IS NULL', [clubId, since, userId])
      ?.n ?? 0,
  );
}

/** Do Not Disturb for chat/mentions (D173): no row yet means off, the default everyone starts at. */
export function chatDndFor(db: Db, userId: string): boolean {
  return db.get<{ enabled: number }>('SELECT enabled FROM chat_dnd WHERE user_id = ?', [userId])?.enabled === 1;
}

export function setChatDnd(db: Db, userId: string, enabled: boolean): void {
  db.exec(
    `INSERT INTO chat_dnd (user_id, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    [userId, enabled ? 1 : 0, Date.now()],
  );
}
