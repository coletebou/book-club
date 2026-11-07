import { type MeetupPlaceKind, type RsvpAnswer } from '@bookclub/shared';
import { type Db } from '../db/db';

/** Where the club will talk next about a book (D53), and, as a meet-up, when and where (D206). */
export interface MeetingRow {
  book_id: string;
  t: number;
  on_day: string | null;
  starts_at: number | null;
  tz: string | null;
  minutes: number | null;
  place_kind: MeetupPlaceKind | null;
  place: string | null;
  set_by: string;
  set_at: number;
  set_by_name: string;
}

export interface MeetingFields {
  readonly t: number;
  readonly onDay: string | null;
  readonly startsAt?: number | null;
  readonly tz?: string | null;
  readonly minutes?: number | null;
  readonly placeKind?: MeetupPlaceKind | null;
  readonly place?: string | null;
}

export function meetingFor(db: Db, bookId: string): MeetingRow | undefined {
  return db.get<MeetingRow>('SELECT m.*, u.display_name AS set_by_name FROM meeting_points m JOIN users u ON u.id = m.set_by WHERE m.book_id = ?', [bookId]);
}

/** Set or move it: a whole new state, so what the form left out (a time, a place) is cleared. */
export function setMeeting(db: Db, bookId: string, userId: string, fields: MeetingFields): void {
  db.exec(
    `INSERT INTO meeting_points (book_id, t, on_day, starts_at, tz, minutes, place_kind, place, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET t = excluded.t, on_day = excluded.on_day, starts_at = excluded.starts_at, tz = excluded.tz,
       minutes = excluded.minutes, place_kind = excluded.place_kind, place = excluded.place, set_by = excluded.set_by, set_at = excluded.set_at`,
    [bookId, fields.t, fields.onDay, fields.startsAt ?? null, fields.tz ?? null, fields.minutes ?? null, fields.placeKind ?? null, fields.place ?? null, userId, Date.now()],
  );
}

export function clearMeeting(db: Db, bookId: string): boolean {
  return db.exec('DELETE FROM meeting_points WHERE book_id = ?', [bookId]).changes > 0;
}

/** The occasion answers are given for (D206): the time, else the day; null when there is neither. */
export function occasionOf(row: Pick<MeetingRow, 'starts_at' | 'on_day'>): string | null {
  if (row.starts_at !== null) return `at:${row.starts_at}`;
  if (row.on_day !== null) return `day:${row.on_day}`;
  return null;
}

export interface RsvpRow {
  user_id: string;
  display_name: string;
  answer: RsvpAnswer;
}

/** The answers for an occasion from people still in the book's club, in the order they came. */
export function rsvpsFor(db: Db, bookId: string, occasion: string): RsvpRow[] {
  return db.all<RsvpRow>(
    `SELECT r.user_id, u.display_name, r.answer FROM meeting_rsvps r
       JOIN users u ON u.id = r.user_id
       JOIN books b ON b.id = r.book_id
       JOIN memberships m ON m.club_id = b.club_id AND m.user_id = r.user_id
      WHERE r.book_id = ? AND r.occasion = ? ORDER BY r.answered_at, r.user_id`,
    [bookId, occasion],
  );
}

/** Answer (or, with null, take an answer back) for the meeting's occasion as it stands. */
export function setRsvp(db: Db, bookId: string, userId: string, occasion: string, answer: RsvpAnswer | null): void {
  if (answer === null) {
    db.exec('DELETE FROM meeting_rsvps WHERE book_id = ? AND user_id = ?', [bookId, userId]);
    return;
  }
  db.exec(
    `INSERT INTO meeting_rsvps (book_id, user_id, answer, occasion, answered_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(book_id, user_id) DO UPDATE SET answer = excluded.answer, occasion = excluded.occasion, answered_at = excluded.answered_at`,
    [bookId, userId, answer, occasion, Date.now()],
  );
}

/* Calendar feeds (D207) ---------------------------------------------------------------------- */

export function calendarFeedOf(db: Db, userId: string): { created_at: number } | undefined {
  return db.get<{ created_at: number }>('SELECT created_at FROM calendar_feeds WHERE user_id = ?', [userId]);
}

/** A new feed address for someone: any earlier one stops working. */
export function replaceCalendarFeed(db: Db, userId: string, tokenHash: string): void {
  db.exec(
    'INSERT INTO calendar_feeds (user_id, token_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at',
    [userId, tokenHash, Date.now()],
  );
}

export function removeCalendarFeed(db: Db, userId: string): void {
  db.exec('DELETE FROM calendar_feeds WHERE user_id = ?', [userId]);
}

/** Whose feed a token's hash opens: only an account that is still allowed in. */
export function calendarFeedUser(db: Db, tokenHash: string): string | undefined {
  return db.get<{ user_id: string }>(
    'SELECT f.user_id FROM calendar_feeds f JOIN users u ON u.id = f.user_id WHERE f.token_hash = ? AND u.disabled_at IS NULL',
    [tokenHash],
  )?.user_id;
}

export interface FeedMeetingRow extends MeetingRow {
  club_id: string;
  club_name: string;
  book_title: string;
  chapters_json: string;
}

/**
 * The meet-ups with a day, in every club someone is in (and of books still there), from a month
 * ago on: what their calendar shows.
 */
export function meetingsForFeed(db: Db, userId: string, sinceDay: string): FeedMeetingRow[] {
  return db.all<FeedMeetingRow>(
    `SELECT m.*, u.display_name AS set_by_name, c.id AS club_id, c.name AS club_name, b.title AS book_title, b.chapters_json
       FROM meeting_points m
       JOIN books b ON b.id = m.book_id AND b.deleted_at IS NULL
       JOIN clubs c ON c.id = b.club_id AND c.deleted_at IS NULL
       JOIN memberships me ON me.club_id = c.id AND me.user_id = ?
       JOIN users u ON u.id = m.set_by
      WHERE m.on_day IS NOT NULL AND m.on_day >= ?
      ORDER BY m.on_day, m.starts_at`,
    [userId, sinceDay],
  );
}
