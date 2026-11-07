import { type Db } from '../db/db';
import { newId } from '../lib/crypto';
import { toJson } from '../lib/json';
import { type Horizon } from './comments';

/** A question for a meet-up (D209): a friend's, or Cal's (no author, no horizon). */
export interface QuestionRow {
  id: string;
  book_id: string;
  t: number;
  text: string;
  author_id: string | null;
  asked_by: string | null;
  horizon_edition_id: string | null;
  horizon_locator_json: string | null;
  horizon_t: number | null;
  created_at: number;
  deleted_at: number | null;
}

export interface QuestionWithPeople extends QuestionRow {
  author_name: string | null;
  asked_by_name: string | null;
  votes: number;
}

const EPS = 1e-6;

/** The questions still there for a book's stop at `t`, with who wrote or asked for them and their votes. */
export function questionsForStop(db: Db, bookId: string, t: number): QuestionWithPeople[] {
  return db.all<QuestionWithPeople>(
    `SELECT q.*, a.display_name AS author_name, k.display_name AS asked_by_name,
            (SELECT COUNT(*) FROM meetup_question_votes v WHERE v.question_id = q.id) AS votes
       FROM meetup_questions q
       LEFT JOIN users a ON a.id = q.author_id
       LEFT JOIN users k ON k.id = q.asked_by
      WHERE q.book_id = ? AND q.deleted_at IS NULL AND ABS(q.t - ?) < ?
      ORDER BY q.created_at, q.id`,
    [bookId, t, EPS],
  );
}

export function questionById(db: Db, id: string): QuestionRow | undefined {
  return db.get<QuestionRow>('SELECT * FROM meetup_questions WHERE id = ? AND deleted_at IS NULL', [id]);
}

export function votedBy(db: Db, userId: string, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db.all<{ question_id: string }>(
    `SELECT question_id FROM meetup_question_votes WHERE user_id = ? AND question_id IN (${ids.map(() => '?').join(', ')})`,
    [userId, ...ids],
  );
  return new Set(rows.map((r) => r.question_id));
}

export function insertQuestion(
  db: Db,
  input: { bookId: string; t: number; text: string; authorId: string | null; askedBy: string | null; horizon: Horizon | null },
): string {
  const id = newId();
  db.exec(
    `INSERT INTO meetup_questions (id, book_id, t, text, author_id, asked_by, horizon_edition_id, horizon_locator_json, horizon_t, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.bookId, input.t, input.text, input.authorId, input.askedBy, input.horizon?.editionId ?? null, input.horizon ? toJson(input.horizon.locator) : null, input.horizon?.t ?? null, Date.now()],
  );
  return id;
}

/** Removed for everyone: its words go at once (kept marked, as a note is), its votes with it. */
export function removeQuestion(db: Db, id: string): void {
  db.tx(() => {
    db.exec("UPDATE meetup_questions SET deleted_at = ?, text = '' WHERE id = ? AND deleted_at IS NULL", [Date.now(), id]);
    db.exec('DELETE FROM meetup_question_votes WHERE question_id = ?', [id]);
  });
}

export function setVote(db: Db, questionId: string, userId: string, on: boolean): void {
  if (on) db.exec('INSERT OR IGNORE INTO meetup_question_votes (question_id, user_id, created_at) VALUES (?, ?, ?)', [questionId, userId, Date.now()]);
  else db.exec('DELETE FROM meetup_question_votes WHERE question_id = ? AND user_id = ?', [questionId, userId]);
}

/** How many times Cal was asked for questions for a stop since a moment (his asks are rationed, D209). */
export function calAsksSince(db: Db, bookId: string, t: number, since: number): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meetup_question_asks WHERE book_id = ? AND ABS(t - ?) < ? AND asked_at >= ?', [bookId, t, EPS, since])?.n ?? 0);
}

export function recordCalAsk(db: Db, bookId: string, t: number, userId: string): void {
  db.exec('INSERT INTO meetup_question_asks (book_id, t, user_id, asked_at) VALUES (?, ?, ?, ?)', [bookId, t, userId, Date.now()]);
}
