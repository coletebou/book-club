import { type Db } from '../db/db';

/** Where the club will talk next about a book (D53). */
export interface MeetingRow {
  book_id: string;
  t: number;
  on_day: string | null;
  set_by: string;
  set_at: number;
  set_by_name: string;
}

export function meetingFor(db: Db, bookId: string): MeetingRow | undefined {
  return db.get<MeetingRow>('SELECT m.*, u.display_name AS set_by_name FROM meeting_points m JOIN users u ON u.id = m.set_by WHERE m.book_id = ?', [bookId]);
}

export function setMeeting(db: Db, bookId: string, userId: string, t: number, onDay: string | null): void {
  db.exec(
    `INSERT INTO meeting_points (book_id, t, on_day, set_by, set_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET t = excluded.t, on_day = excluded.on_day, set_by = excluded.set_by, set_at = excluded.set_at`,
    [bookId, t, onDay, userId, Date.now()],
  );
}

export function clearMeeting(db: Db, bookId: string): boolean {
  return db.exec('DELETE FROM meeting_points WHERE book_id = ?', [bookId]).changes > 0;
}
