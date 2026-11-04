import { type Locator, type MyProgress, type Span, type SyncMap, mToT, normalizeRanges } from '@bookclub/shared';
import { type Db } from '../db/db';
import { fromJson, toJson } from '../lib/json';

export interface ProgressRow {
  user_id: string;
  book_id: string;
  edition_id: string | null;
  locator_json: string | null;
  t: number;
  label: string;
  client_at: number;
  read_ranges_json: string;
  furthest: number;
  coverage: number;
  finished_at: number | null;
  /** What was read before ranges were kept per edition (migration 008), on the timeline. */
  unplaced_ranges_json: string;
  updated_at: number;
}

/**
 * What a member has read of a book, as spoiler gating weighs it: what they read in each edition,
 * in that edition's own measure (its characters, pages or milliseconds), and what they had read
 * before the server kept that, on the book's timeline, in a format it no longer knows.
 */
export interface Reading {
  readonly byEdition: ReadonlyMap<string, readonly Span[]>;
  readonly unplaced: readonly Span[];
}

export function progressFor(db: Db, userId: string, bookId: string): ProgressRow | undefined {
  return db.get<ProgressRow>('SELECT * FROM progress WHERE user_id = ? AND book_id = ?', [userId, bookId]);
}

export function progressForBook(db: Db, bookId: string): ProgressRow[] {
  return db.all<ProgressRow>('SELECT * FROM progress WHERE book_id = ?', [bookId]);
}

export function readRanges(row: ProgressRow | undefined): Span[] {
  return row ? fromJson<Span[]>(row.read_ranges_json, []) : [];
}

/** A member's reading of a book, edition by edition (`row`: their progress row when at hand, null for none). */
export function readingOf(db: Db, userId: string, bookId: string, row: ProgressRow | null = progressFor(db, userId, bookId) ?? null): Reading {
  const byEdition = new Map<string, Span[]>();
  for (const r of db.all<{ edition_id: string; read_ranges_json: string }>('SELECT edition_id, read_ranges_json FROM edition_progress WHERE user_id = ? AND book_id = ?', [
    userId,
    bookId,
  ])) {
    byEdition.set(r.edition_id, fromJson<Span[]>(r.read_ranges_json, []));
  }
  return { byEdition, unplaced: row ? fromJson<Span[]>(row.unplaced_ranges_json, []) : [] };
}

/**
 * An edition about to go: what members read in it stays read, as reading in a format no longer
 * known (placed on the timeline through its map, counted with the margins of D63), so the notes it
 * opened for them do not close again.
 */
export function foldEditionReading(db: Db, editionId: string, sync: SyncMap): void {
  for (const r of db.all<{ user_id: string; book_id: string; read_ranges_json: string }>('SELECT user_id, book_id, read_ranges_json FROM edition_progress WHERE edition_id = ?', [editionId])) {
    const spans = fromJson<Span[]>(r.read_ranges_json, []).map(([a, b]): Span => [mToT(sync, a), mToT(sync, b)]);
    const row = progressFor(db, r.user_id, r.book_id);
    if (!row || spans.length === 0) continue;
    const kept = normalizeRanges([...fromJson<Span[]>(row.unplaced_ranges_json, []), ...spans]);
    db.exec('UPDATE progress SET unplaced_ranges_json = ? WHERE user_id = ? AND book_id = ?', [toJson(kept), r.user_id, r.book_id]);
  }
}

/** What a member has read in one edition, in its own measure. */
export function saveEditionRanges(db: Db, userId: string, bookId: string, editionId: string, ranges: readonly Span[]): void {
  db.exec(
    `INSERT INTO edition_progress (user_id, book_id, edition_id, read_ranges_json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id, edition_id) DO UPDATE SET read_ranges_json = excluded.read_ranges_json, updated_at = excluded.updated_at`,
    [userId, bookId, editionId, toJson(ranges), Date.now()],
  );
}

export function saveProgress(db: Db, row: Omit<ProgressRow, 'updated_at' | 'unplaced_ranges_json'>): void {
  db.exec(
    `INSERT INTO progress (user_id, book_id, edition_id, locator_json, t, label, client_at, read_ranges_json, furthest, coverage, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id) DO UPDATE SET
       edition_id = excluded.edition_id, locator_json = excluded.locator_json, t = excluded.t, label = excluded.label,
       client_at = excluded.client_at, read_ranges_json = excluded.read_ranges_json, furthest = excluded.furthest,
       coverage = excluded.coverage, finished_at = excluded.finished_at, updated_at = excluded.updated_at`,
    [
      row.user_id,
      row.book_id,
      row.edition_id,
      row.locator_json,
      row.t,
      row.label,
      row.client_at,
      row.read_ranges_json,
      row.furthest,
      row.coverage,
      row.finished_at,
      Date.now(),
    ],
  );
}

export function toMyProgress(row: ProgressRow): MyProgress {
  return {
    editionId: row.edition_id,
    locator: row.locator_json ? fromJson<Locator>(row.locator_json, { kind: 'epub', section: 0, offset: 0 }) : null,
    t: row.t,
    label: row.label,
    readRanges: readRanges(row).map(([a, b]) => [a, b] as [number, number]),
    furthest: row.furthest,
    finished: row.finished_at !== null,
    at: row.client_at,
  };
}

export { toJson };
