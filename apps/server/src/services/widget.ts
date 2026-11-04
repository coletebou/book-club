import type { WidgetBook, WidgetSnapshot } from '@bookclub/shared';
import { type Db } from '../db/db';
import { bookById, editionById } from '../repos/books';
import { clubById } from '../repos/clubs';
import { coverUrl, meetingView } from './books';

/** How many books a snapshot names: the current one and three more. */
const BOOKS = 4;

/**
 * What the iOS app's widgets show (D188): your own places in the books you can still open, newest
 * first, each with its club's next stop. Nothing of anyone else's reading: a friend's place is on
 * the book page, not on your Home Screen.
 */
export function widgetSnapshot(db: Db, userId: string, now = Date.now()): WidgetSnapshot {
  const rows = db.all<{ book_id: string; edition_id: string | null; t: number; label: string; client_at: number; finished_at: number | null }>(
    `SELECT p.book_id, p.edition_id, p.t, p.label, p.client_at, p.finished_at
       FROM progress p
       JOIN books b ON b.id = p.book_id AND b.deleted_at IS NULL
       JOIN clubs c ON c.id = b.club_id AND c.deleted_at IS NULL
       JOIN memberships m ON m.club_id = b.club_id AND m.user_id = p.user_id
      WHERE p.user_id = ?
      ORDER BY p.client_at DESC
      LIMIT ?`,
    [userId, BOOKS],
  );
  const books: WidgetBook[] = [];
  for (const row of rows) {
    const book = bookById(db, row.book_id);
    const club = book ? clubById(db, book.club_id) : undefined;
    if (!book || !club) continue;
    const kind = row.edition_id ? editionById(db, row.edition_id)?.kind : undefined;
    const meeting = meetingView(db, book);
    const t = Math.min(1, Math.max(0, row.t));
    books.push({
      bookId: book.id,
      clubId: club.id,
      clubName: club.name,
      title: book.title,
      author: book.author,
      coverUrl: coverUrl(book),
      t,
      percent: Math.min(100, Math.floor(t * 100 + 0.005)),
      label: row.label,
      format: kind === 'epub' || kind === 'pdf' || kind === 'audio' ? kind : null,
      finished: row.finished_at !== null,
      at: row.client_at,
      stop: meeting ? { label: meeting.label, on: meeting.on, toGo: Math.max(0, meeting.t - t), reached: t >= meeting.t - 1e-9 } : null,
    });
  }
  return { generatedAt: now, current: books[0] ?? null, others: books.slice(1) };
}
