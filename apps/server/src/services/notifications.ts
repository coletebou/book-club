import { type NoteMediaKind, type NotificationList, type NotificationView, type RevealedComment, chapterIndexAt, memberColor, slotColor } from '@bookclub/shared';
import { type AppContext } from '../context';
import { type Db } from '../db/db';
import { newId } from '../lib/crypto';
import { isoRequired } from '../lib/json';
import { type BookRow, bookById, bookChapters } from '../repos/books';
import { type ChatMessageWithAuthor, chatDndFor } from '../repos/chat';
import { type CommentWithAuthor, repliesTo } from '../repos/comments';
import { type Reading, readingOf } from '../repos/progress';
import { type Gate, type Gated, gateFor } from './gating';
import { chapterLabel } from './labels';
import { pushPayloadFor, pushToUser } from './push';

/**
 * Notifications (D49, D152): the moments a friend's reading or writing touches yours. Someone
 * answered your note (or a conversation you are in); a friend got to your note (it opened for
 * them); someone @-mentioned you in a club's chat. Kept per person, pushed to their open devices,
 * never carrying anything they could not already read: a reply's words come once they are open to
 * you, by its place and by where its writer had read to (D69); a mention inside a spoiler-fenced
 * chat message (D150) waits the very same way, by the chat gate instead of the book's note gate.
 *
 * "Got to it" notifications are batched per friend, per book, per chapter (D145): catching up a
 * whole chapter at once (an evening offline, a long drive) opens several of a friend's notes in
 * one progress update, and used to make one notification per note. While the batch stays unread,
 * reaching another of that friend's notes in the same chapter bumps it in place (`count`, the
 * latest note's id) instead of adding a second; reading it frees the key, so a later note in the
 * same chapter, reached another day, is its own, new notification.
 */

interface NotificationRow {
  id: string;
  kind: 'reply' | 'reached' | 'mention';
  book_id: string | null;
  book_title: string | null;
  comment_id: string | null;
  parent_id: string | null;
  user_id: string;
  author_id: string | null;
  edition_id: string | null;
  locator_json: string | null;
  end_locator_json: string | null;
  t: number | null;
  end_t: number | null;
  horizon_edition_id: string | null;
  horizon_locator_json: string | null;
  horizon_t: number | null;
  chapters_json: string | null;
  text: string | null;
  media_kind: NoteMediaKind | null;
  count: number;
  actor_name: string;
  actor_slot: number | null;
  actor_id: string;
  created_at: number;
  read_at: number | null;
  club_id: string | null;
  club_name: string | null;
  chat_message_id: string | null;
  chat_text: string | null;
  chat_book_id: string | null;
  chat_spoiler_t: number | null;
  chat_spoiler_edition_id: string | null;
}

const SELECT = `SELECT n.id, n.kind, n.book_id, b.title AS book_title, n.comment_id, c.parent_id, n.user_id, c.user_id AS author_id,
       c.edition_id, c.locator_json, c.end_locator_json, c.t, c.end_t, c.horizon_edition_id, c.horizon_locator_json, c.horizon_t, b.chapters_json, c.text,
       (SELECT med.kind FROM comment_media med WHERE med.comment_id = c.id ORDER BY med.idx LIMIT 1) AS media_kind, n.count,
       u.display_name AS actor_name, m.color AS actor_slot, n.actor_id, n.created_at, n.read_at,
       n.club_id, cl.name AS club_name, n.chat_message_id, cm.text AS chat_text, cm.book_id AS chat_book_id, cm.spoiler_t AS chat_spoiler_t, cm.spoiler_edition_id AS chat_spoiler_edition_id
  FROM notifications n
  LEFT JOIN comments c ON c.id = n.comment_id AND c.deleted_at IS NULL
  LEFT JOIN books b ON b.id = n.book_id
  LEFT JOIN clubs cl ON cl.id = n.club_id
  LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id AND cm.deleted_at IS NULL
  JOIN users u ON u.id = n.actor_id
  LEFT JOIN memberships me ON me.club_id = COALESCE(b.club_id, n.club_id) AND me.user_id = n.user_id
  LEFT JOIN memberships m ON m.club_id = COALESCE(b.club_id, n.club_id) AND m.user_id = n.actor_id`;

/** What a notification's reader may know of the reply (or mentioning message) it is about. */
interface Judged {
  readonly open: boolean;
  /** Where its writer had read to (D69), or the chat spoiler fence (D150), until it opens. */
  readonly horizon: string | null;
}

interface BookContext {
  readonly book: BookRow;
  readonly gate: Gate;
  readonly reading: Reading;
}

/**
 * Whether a reply, or an @-mention inside a spoiler-fenced chat message, is open to its reader —
 * in the book as everywhere: each book's gate and their reading of it are looked up once per list.
 */
function judge(db: Db): (row: NotificationRow) => Judged {
  const books = new Map<string, BookContext | null>();
  const contextFor = (userId: string, bookId: string): BookContext | null => {
    const key = `${userId} ${bookId}`;
    if (!books.has(key)) {
      const book = bookById(db, bookId);
      books.set(key, book ? { book, gate: gateFor(db, book), reading: readingOf(db, userId, bookId) } : null);
    }
    return books.get(key) ?? null;
  };
  return (row) => {
    if (row.kind === 'mention') {
      if (!row.chat_book_id || row.chat_spoiler_t === null) return { open: true, horizon: null };
      const seen = contextFor(row.user_id, row.chat_book_id);
      if (!seen) return { open: false, horizon: null };
      const fence: Gated = {
        user_id: row.actor_id,
        edition_id: row.chat_spoiler_edition_id ?? seen.book.reference_edition_id ?? '',
        locator_json: '',
        end_locator_json: null,
        t: row.chat_spoiler_t,
        end_t: null,
      };
      const open = seen.gate.isOpen(fence, row.user_id, seen.reading);
      return { open, horizon: open ? null : chapterLabel(bookChapters(seen.book), row.chat_spoiler_t) };
    }
    if (!row.book_id || row.author_id === null) return { open: false, horizon: null };
    const seen = contextFor(row.user_id, row.book_id);
    if (!seen) return { open: false, horizon: null };
    const reply: Gated = {
      user_id: row.author_id,
      edition_id: row.edition_id!,
      locator_json: row.locator_json!,
      end_locator_json: row.end_locator_json,
      t: row.t!,
      end_t: row.end_t,
      horizon_edition_id: row.horizon_edition_id,
      horizon_locator_json: row.horizon_locator_json,
      horizon_t: row.horizon_t,
    };
    const access = seen.gate.access(reply, row.user_id, seen.reading);
    return { open: access === 'open', horizon: access === 'held' ? seen.gate.horizonLabel(reply) : null };
  };
}

function toView(row: NotificationRow, judged: (row: NotificationRow) => Judged): NotificationView {
  if (row.kind === 'mention') {
    const mention = row.chat_text != null ? judged(row) : null;
    return {
      id: row.id,
      kind: 'mention',
      bookId: null,
      bookTitle: null,
      commentId: null,
      noteId: null,
      clubId: row.club_id,
      clubName: row.club_name,
      chatMessageId: row.chat_message_id,
      actorName: row.actor_name,
      actorColor: row.actor_slot === null ? memberColor(row.actor_id) : slotColor(row.actor_slot),
      where: row.club_name ?? 'Chat',
      // A mention's words only once they are open (D150): behind its own chat message's spoiler fence, if any.
      text: mention?.open && row.chat_text ? row.chat_text.slice(0, 140) : null,
      horizon: mention?.horizon ?? null,
      createdAt: isoRequired(row.created_at),
      read: row.read_at !== null,
    };
  }
  const chapters = bookChapters({ chapters_json: row.chapters_json ?? '[]' } as BookRow);
  const reply = row.kind === 'reply' && row.text ? judged(row) : null;
  return {
    id: row.id,
    kind: row.kind,
    bookId: row.book_id,
    bookTitle: row.book_title,
    commentId: row.comment_id,
    noteId: row.parent_id ?? row.comment_id,
    clubId: null,
    clubName: null,
    chatMessageId: null,
    actorName: row.actor_name,
    actorColor: row.actor_slot === null ? memberColor(row.actor_id) : slotColor(row.actor_slot),
    where: chapterLabel(chapters, row.t ?? 0),
    // A reply's words only for someone who may read them (D12, D69), as in the book itself.
    text: reply?.open && row.text ? row.text.slice(0, 140) : null,
    horizon: reply?.horizon ?? null,
    // A reply carrying no words of its own, only media (D140): what kind, never its bytes (as
    // spoiler-free as the reaction emoji the bell already shows unconditionally).
    mediaKind: row.kind === 'reply' && !row.text && row.media_kind ? row.media_kind : null,
    count: row.count,
    createdAt: isoRequired(row.created_at),
    read: row.read_at !== null,
  };
}

/** Someone's latest notifications (from clubs they are still in), and how many are unread. */
/**
 * Still live: the recipient is still a member of the club it came from (directly, or through its
 * book), and, for a reply or a reached note, the comment it is about still exists. `SELECT`'s
 * joins to both are `LEFT` (a mention has no comment; `me`'s only job here is this check, so
 * nothing of its columns is selected), so both must be asserted explicitly instead of relying on
 * an `INNER JOIN` to drop a stale row by itself.
 */
// A removed book's or a disbanded club's notifications (D179) go with it.
const LIVE = `me.user_id IS NOT NULL AND (n.kind = 'mention' OR c.id IS NOT NULL) AND (b.id IS NULL OR b.deleted_at IS NULL) AND (cl.id IS NULL OR cl.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM clubs dc JOIN books db ON db.club_id = dc.id WHERE db.id = n.book_id AND dc.deleted_at IS NOT NULL)`;

export function notificationsFor(db: Db, userId: string, limit = 50): NotificationList {
  const judged = judge(db);
  const items = db.all<NotificationRow>(`${SELECT} WHERE n.user_id = ? AND ${LIVE} ORDER BY n.created_at DESC, n.id LIMIT ?`, [userId, limit]).map((row) => toView(row, judged));
  const unread = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${SELECT} WHERE n.user_id = ? AND n.read_at IS NULL AND ${LIVE})`, [userId])?.n ?? 0);
  return { unread, items };
}

export function markRead(db: Db, userId: string, ids?: readonly string[]): void {
  const now = Date.now();
  if (!ids) {
    db.exec('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now, userId]);
    return;
  }
  for (const id of ids) db.exec('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', [now, id, userId]);
}

/** Push one notification, freshly made or bumped, to its reader's open devices. */
/**
 * Send a notification to its person: live to every page they have open, and (`alert`) as a push
 * to the iOS app for whoever has it closed (D134), so the app need not be running. A batched
 * "reached" notification bumped in place (D145) updates the open pages without buzzing the phone
 * again: one buzz per friend per chapter, not one per note.
 *
 * A mention is always sent live (D173): the bell's badge and list still gain it, so turning Do
 * Not Disturb back off shows what was missed. Only the push (and, client-side, the in-app toast
 * that same `notification:new` triggers) is held back while DND is on — a reply or "got to your
 * note" is a different, unrelated workstream and is never muted by it.
 */
function deliver(ctx: AppContext, id: string, alert: boolean): void {
  const row = ctx.db.get<NotificationRow>(`${SELECT} WHERE n.id = ?`, [id]);
  if (!row) return;
  const view = toView(row, judge(ctx.db));
  ctx.hub.sendToUser(row.user_id, { type: 'notification:new', notification: view });
  const muted = row.kind === 'mention' && chatDndFor(ctx.db, row.user_id);
  if (alert && !muted) void pushToUser(ctx, row.user_id, pushPayloadFor(id, view));
}

function create(ctx: AppContext, userId: string, kind: 'reply', book: BookRow, commentId: string, actorId: string): void {
  const id = newId();
  const inserted = ctx.db.exec(
    'INSERT OR IGNORE INTO notifications (id, user_id, kind, book_id, comment_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, userId, kind, book.id, commentId, actorId, Date.now()],
  ).changes;
  if (inserted) deliver(ctx, id, true);
}

/** A reply: its note's author and everyone else who answered it hear about it (not the replier). */
export function notifyReply(ctx: AppContext, book: BookRow, root: CommentWithAuthor, reply: CommentWithAuthor): void {
  const people = new Set([root.user_id, ...repliesTo(ctx.db, root.id).map((r) => r.user_id)]);
  people.delete(reply.user_id);
  for (const userId of people) create(ctx, userId, 'reply', book, reply.id, reply.user_id);
}

/**
 * Notes a friend has just got to: each one's author hears that they did, batched per friend per
 * chapter so that catching up a whole chapter at once says it once (D145, no notification storm).
 */
export function notifyReached(ctx: AppContext, book: BookRow, readerId: string, revealed: readonly RevealedComment[]): void {
  const chapters = bookChapters(book);
  const now = Date.now();
  // One push per notification touched, however many of a friend's notes this one update opened
  // in the same chapter: a long-offline catch-up must not toast (or socket-push) once per note.
  const touched = new Map<string, boolean>(); // id -> whether it is new (alerts) or a bump (does not)
  for (const c of revealed) {
    if (c.userId === readerId || c.parentId) continue;
    const chapterIndex = chapterIndexAt(chapters, c.t);
    const existing = ctx.db.get<{ id: string }>(
      `SELECT id FROM notifications WHERE user_id = ? AND actor_id = ? AND book_id = ? AND kind = 'reached' AND chapter_index = ? AND read_at IS NULL`,
      [c.userId, readerId, book.id, chapterIndex],
    );
    if (existing) {
      ctx.db.exec('UPDATE notifications SET comment_id = ?, created_at = ?, count = count + 1 WHERE id = ?', [c.id, now, existing.id]);
      if (!touched.has(existing.id)) touched.set(existing.id, false);
      continue;
    }
    const id = newId();
    ctx.db.exec(
      `INSERT INTO notifications (id, user_id, kind, book_id, comment_id, actor_id, created_at, chapter_index, count) VALUES (?, ?, 'reached', ?, ?, ?, ?, ?, 1)`,
      [id, c.userId, book.id, c.id, readerId, now, chapterIndex],
    );
    touched.set(id, true);
  }
  for (const [id, fresh] of touched) deliver(ctx, id, fresh);
}

/** @-mentions in a club chat message (D152): everyone it names, once per message, not its writer. */
export function createMentionNotifications(ctx: AppContext, clubId: string, mentionedUserIds: readonly string[], message: ChatMessageWithAuthor): void {
  for (const userId of mentionedUserIds) {
    const id = newId();
    const inserted = ctx.db.exec(
      'INSERT OR IGNORE INTO notifications (id, user_id, kind, club_id, chat_message_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, userId, 'mention', clubId, message.id, message.user_id, Date.now()],
    ).changes;
    if (inserted) deliver(ctx, id, true);
  }
}
