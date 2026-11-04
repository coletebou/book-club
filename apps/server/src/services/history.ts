import { type HistoryEntry, type HistoryList, type Locator, type ProgressUpdateBody, locatorToM, locatorToT } from '@bookclub/shared';
import { type Db } from '../db/db';
import { newId } from '../lib/crypto';
import { fromJson, toJson } from '../lib/json';
import { type BookRow, type EditionRow, bookById, editionTimeline } from '../repos/books';
import { coverUrl } from './books';

/**
 * Your own reading and listening history (D191): each sitting, on one device, in one edition, with
 * when, for how long and from where to where. Recorded from the reports the reader and the player
 * already send (`PUT /api/books/:id/progress`), so nothing new is measured on the device; coalesced
 * as it arrives, and once more when read back, so reports that come late or out of order (kept
 * offline, D20) still make one sitting. Shown only to the person it is about.
 *
 * The rules (`continues`, `fold`, `merge`, `worthShowing`) are pure, and unit-tested.
 */

/** Longer than this with nothing read or heard ends a sitting: the next stretch starts another. */
export const SITTING_GAP_MS = 10 * 60_000;

/** The most a page counts as read for, however long it stayed open (a phone put down open). */
export const PAGE_DWELL_CAP_MS = 5 * 60_000;

/** Less than this, read or heard, is not a sitting worth a line (the book opened and closed again). */
export const MIN_SITTING_MS = 20_000;

/**
 * How far from where a sitting had got the next stretch may start and still continue it, in the
 * edition's own measure: a skip back or ahead, a page or two flipped; a chapter chosen from the
 * contents (a look, then reading there) starts another sitting.
 */
export function jumpLimit(kind: HistoryEntry['kind']): number {
  return kind === 'audio' ? 90_000 : kind === 'pdf' ? 2 : 4_000;
}

/** One stretch read or heard: where (in the edition's measure and as locators), when, and the pages it showed. */
export interface Piece {
  readonly fromM: number;
  readonly toM: number;
  readonly from: Locator;
  readonly to: Locator;
  readonly fromT: number;
  readonly toT: number;
  readonly since: number;
  readonly at: number;
  readonly pages: readonly [number, number] | null;
}

/** A sitting as it is kept. */
export interface Sitting {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly activeMs: number;
  readonly fromM: number;
  readonly toM: number;
  readonly lastM: number;
  readonly from: Locator;
  readonly to: Locator;
  readonly fromT: number;
  readonly toT: number;
  readonly fromPage: number | null;
  readonly toPage: number | null;
  /**
   * When it was read or heard: disjoint, sorted intervals of the device's clock (an instant, for a
   * page shown). The time spent is worked out from these, so reports that arrive in any order add
   * up to the same (`activeOf`).
   */
  readonly times: readonly (readonly [number, number])[];
}

/** The most intervals a sitting keeps: past it, the two closest are joined (the time spent barely moves). */
const MAX_TIMES = 400;

/** Pieces of listening this close count as one stretch heard (a pause and play, as D65). */
const LISTENING_JOIN_MS = 2_000;

/** Add an interval to a sitting's times, joining those that touch or come within `join` of each other. */
export function addTime(times: readonly (readonly [number, number])[], interval: readonly [number, number], join: number): [number, number][] {
  const all = [...times, interval].map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of all) {
    const last = out.at(-1);
    if (last && a - last[1] <= join) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  while (out.length > MAX_TIMES) {
    let k = 0;
    for (let i = 1; i < out.length - 1; i++) if (out[i + 1]![0] - out[i]![1] < out[k + 1]![0] - out[k]![1]) k = i;
    out.splice(k, 2, [out[k]![0], out[k + 1]![1]]);
  }
  return out;
}

/**
 * The time spent in a sitting, from its times. Listening: the time heard, pauses not counted.
 * Reading: a page is reported as it is shown, so the time between one report and the next is the
 * time that page was read; a page left open longer than a cap (a phone put down) counts the cap.
 */
export function activeOf(times: readonly (readonly [number, number])[], kind: HistoryEntry['kind']): number {
  let total = 0;
  for (const [a, b] of times) total += b - a;
  if (kind !== 'audio' && times.length > 1) total += (times.length - 1) * PAGE_DWELL_CAP_MS;
  return total;
}

const joinOf = (kind: HistoryEntry['kind']) => (kind === 'audio' ? LISTENING_JOIN_MS : PAGE_DWELL_CAP_MS);

/** Whether a stretch continues a sitting: near it in time, and near where it had got to. */
export function continues(s: Sitting, p: Piece, kind: HistoryEntry['kind']): boolean {
  const jump = jumpLimit(kind);
  return p.since <= s.endedAt + SITTING_GAP_MS && p.at >= s.startedAt - SITTING_GAP_MS && p.fromM >= s.fromM - jump && p.fromM <= Math.max(s.lastM, s.toM) + jump;
}

/** A sitting with a stretch added to it, or a new sitting of one stretch. */
export function fold(s: Sitting | null, p: Piece, kind: HistoryEntry['kind']): Sitting {
  const times = addTime(s?.times ?? [], [p.since, p.at], joinOf(kind));
  if (!s) {
    return {
      startedAt: p.since,
      endedAt: p.at,
      activeMs: activeOf(times, kind),
      fromM: p.fromM,
      toM: p.toM,
      lastM: p.toM,
      from: p.from,
      to: p.to,
      fromT: p.fromT,
      toT: p.toT,
      fromPage: p.pages?.[0] ?? null,
      toPage: p.pages?.[1] ?? null,
      times,
    };
  }
  const earlier = p.fromM < s.fromM;
  const further = p.toM > s.toM;
  const later = p.at >= s.endedAt;
  return {
    startedAt: Math.min(s.startedAt, p.since),
    endedAt: Math.max(s.endedAt, p.at),
    activeMs: activeOf(times, kind),
    fromM: earlier ? p.fromM : s.fromM,
    toM: further ? p.toM : s.toM,
    lastM: later ? p.toM : s.lastM,
    from: earlier ? p.from : s.from,
    to: further ? p.to : s.to,
    fromT: earlier ? p.fromT : s.fromT,
    toT: further ? p.toT : s.toT,
    // A page number only from the stretch that is that end: a later page never stands in for an
    // earlier one whose number was not known yet (the pages still being counted).
    fromPage: earlier ? (p.pages?.[0] ?? null) : p.fromM === s.fromM ? (s.fromPage ?? p.pages?.[0] ?? null) : (s.fromPage ?? pagesBefore(s, p)),
    toPage: further ? (p.pages?.[1] ?? null) : p.toM === s.toM ? (s.toPage ?? p.pages?.[1] ?? null) : s.toPage,
    times,
  };
}

/**
 * The first page of a sitting whose own number was not known (the device was still counting its
 * pages as it opened the book), from the first numbered page that reads straight on from it: as
 * many pages before that one as pages of its size fit between the start and it.
 */
function pagesBefore(s: Sitting, p: Piece): number | null {
  if (s.toPage !== null || !p.pages || Math.abs(p.fromM - s.toM) > 1 || p.toM <= p.fromM) return null;
  return Math.max(1, p.pages[0] - Math.max(1, Math.round((s.toM - s.fromM) / (p.toM - p.fromM))));
}

/** Two sittings that turn out to be one (reports kept offline arrived after the next ones). */
export function mergeable(a: Sitting, b: Sitting, kind: HistoryEntry['kind']): boolean {
  const [first, second] = a.startedAt <= b.startedAt ? [a, b] : [b, a];
  const jump = jumpLimit(kind);
  return second.startedAt <= first.endedAt + SITTING_GAP_MS && second.fromM >= first.fromM - jump && second.fromM <= Math.max(first.lastM, first.toM) + jump;
}

export function merge(a: Sitting, b: Sitting, kind: HistoryEntry['kind']): Sitting {
  const [first, second] = a.startedAt <= b.startedAt ? [a, b] : [b, a];
  const earlier = second.fromM < first.fromM;
  const further = second.toM > first.toM;
  let times = [...first.times].map(([x, y]) => [x, y] as [number, number]);
  for (const t of second.times) times = addTime(times, t, joinOf(kind));
  return {
    startedAt: first.startedAt,
    endedAt: Math.max(first.endedAt, second.endedAt),
    activeMs: activeOf(times, kind),
    fromM: earlier ? second.fromM : first.fromM,
    toM: further ? second.toM : first.toM,
    lastM: second.endedAt >= first.endedAt ? second.lastM : first.lastM,
    from: earlier ? second.from : first.from,
    to: further ? second.to : first.to,
    fromT: earlier ? second.fromT : first.fromT,
    toT: further ? second.toT : first.toT,
    fromPage: earlier ? second.fromPage : first.fromPage,
    toPage: further ? second.toPage : first.toPage,
    times,
  };
}

/** Whether a sitting is worth a line: read or heard for long enough, or several pages turned through. */
export function worthShowing(s: Sitting, kind: HistoryEntry['kind']): boolean {
  if (s.activeMs >= MIN_SITTING_MS) return true;
  if (kind === 'audio') return s.toM - s.fromM >= MIN_SITTING_MS;
  return s.fromPage !== null && s.toPage !== null && s.toPage - s.fromPage >= 2;
}

/**
 * A coarse name for the device a report came from, from the browser's own description of itself:
 * enough to tell "on my phone" from "on the laptop", nothing that identifies it.
 */
export function deviceOf(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const app = /BookClubApp\//.test(ua);
  const kind = /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))
    ? 'iPad'
    : /iPhone|iPod/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'Browser';
  return app ? `${kind} app` : kind;
}

// ---------------------------------------------------------------------------------------------
// Keeping it.

interface SittingRow {
  id: string;
  user_id: string;
  book_id: string;
  edition_id: string;
  kind: HistoryEntry['kind'];
  device: string;
  started_at: number;
  ended_at: number;
  active_ms: number;
  from_m: number;
  to_m: number;
  last_m: number;
  from_json: string;
  to_json: string;
  from_t: number;
  to_t: number;
  from_page: number | null;
  to_page: number | null;
  times_json: string;
}

function sittingOf(row: SittingRow): Sitting {
  return {
    startedAt: row.started_at,
    endedAt: row.ended_at,
    activeMs: row.active_ms,
    fromM: row.from_m,
    toM: row.to_m,
    lastM: row.last_m,
    from: fromJson<Locator>(row.from_json, { kind: 'audio', track: 0, ms: 0 }),
    to: fromJson<Locator>(row.to_json, { kind: 'audio', track: 0, ms: 0 }),
    fromT: row.from_t,
    toT: row.to_t,
    fromPage: row.from_page,
    toPage: row.to_page,
    times: fromJson<[number, number][]>(row.times_json, [[row.started_at, row.ended_at]]),
  };
}

function save(db: Db, id: string, key: { userId: string; bookId: string; editionId: string; kind: HistoryEntry['kind']; device: string }, s: Sitting): void {
  db.exec(
    `INSERT INTO reading_sessions (id, user_id, book_id, edition_id, kind, device, started_at, ended_at, active_ms, from_m, to_m, last_m, from_json, to_json, from_t, to_t, from_page, to_page, times_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at, active_ms = excluded.active_ms,
       from_m = excluded.from_m, to_m = excluded.to_m, last_m = excluded.last_m, from_json = excluded.from_json, to_json = excluded.to_json,
       from_t = excluded.from_t, to_t = excluded.to_t, from_page = excluded.from_page, to_page = excluded.to_page, times_json = excluded.times_json, updated_at = excluded.updated_at`,
    [id, key.userId, key.bookId, key.editionId, key.kind, key.device, s.startedAt, Math.round(s.endedAt), Math.round(s.activeMs), s.fromM, s.toM, s.lastM, toJson(s.from), toJson(s.to), s.fromT, s.toT, s.fromPage, s.toPage, toJson(s.times), Date.now()],
  );
}

/** How far ahead of the server a device's clock may run (as for positions, D20). */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Add a progress report's stretches to your history: each to the sitting it continues (same
 * edition and device, near in time and place), else as a new one. A look reports no stretches, so
 * it is never history; "I've read up to here" is not a sitting either (it is not reported here).
 */
export function recordHistory(db: Db, userId: string, book: BookRow, edition: EditionRow, device: string, body: ProgressUpdateBody): void {
  const timeline = editionTimeline(edition);
  if (!timeline || body.readSpans.length === 0) return;
  const kind = edition.kind;
  const limit = Date.now() + CLOCK_SKEW_MS;
  const pieces: Piece[] = body.readSpans
    .filter((span) => span.from.kind === timeline.geometry.kind && span.to.kind === timeline.geometry.kind)
    .map((span) => {
      const fromM = locatorToM(timeline.geometry, span.from);
      const toM = locatorToM(timeline.geometry, span.to);
      const at = Math.min(span.at ?? body.at, limit);
      // Listening is a stretch of time; with no `since` (an older client), as long as it lasted.
      const since = Math.min(at, span.since ?? (kind === 'audio' ? at - Math.max(0, toM - fromM) : at));
      return { fromM, toM, from: span.from, to: span.to, fromT: locatorToT(timeline, span.from), toT: locatorToT(timeline, span.to), since, at, pages: span.pages ?? null };
    })
    .filter((p) => p.toM >= p.fromM)
    .sort((a, b) => a.since - b.since);
  if (pieces.length === 0) return;
  const key = { userId, bookId: book.id, editionId: edition.id, kind, device };
  db.tx(() => {
    for (const p of pieces) {
      const candidates = db.all<SittingRow>(
        `SELECT * FROM reading_sessions WHERE user_id = ? AND book_id = ? AND edition_id = ? AND device = ? AND ended_at >= ? AND started_at <= ? ORDER BY ended_at DESC LIMIT 5`,
        [userId, book.id, edition.id, device, p.since - SITTING_GAP_MS, p.at + SITTING_GAP_MS],
      );
      const row = candidates.find((r) => continues(sittingOf(r), p, kind));
      save(db, row?.id ?? newId(), key, fold(row ? sittingOf(row) : null, p, kind));
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Reading it back.

/** The most entries one page of history holds. */
export const HISTORY_PAGE = 200;

/**
 * Your history, newest first: in one book, or across every book you can still open (a club you
 * left, a book removed, D179, takes its history out of sight with it). Sittings that turn out to
 * be one are joined, and those too short to be worth a line are left out.
 */
export function historyFor(db: Db, userId: string, options: { bookId?: string; before?: number; limit?: number } = {}): HistoryList {
  const limit = Math.min(HISTORY_PAGE, Math.max(1, options.limit ?? HISTORY_PAGE));
  const params: (string | number)[] = [userId, userId];
  let where = '';
  if (options.bookId) {
    where += ' AND s.book_id = ?';
    params.push(options.bookId);
  }
  if (options.before !== undefined) {
    where += ' AND s.ended_at < ?';
    params.push(options.before);
  }
  // One more than a page, and the sittings it may join with: what is cut at the page's end is read again with the next.
  params.push(limit * 2 + 1);
  const rows = db.all<SittingRow>(
    `SELECT s.*
       FROM reading_sessions s
       JOIN books b ON b.id = s.book_id AND b.deleted_at IS NULL
       JOIN clubs c ON c.id = b.club_id AND c.deleted_at IS NULL
       JOIN memberships m ON m.club_id = b.club_id AND m.user_id = ?
      WHERE s.user_id = ?${where}
      ORDER BY s.ended_at DESC
      LIMIT ?`,
    params,
  );
  // Join sittings of the same edition and device that turn out to be one.
  const groups = new Map<string, { row: (typeof rows)[number]; sitting: Sitting }[]>();
  for (const row of rows) {
    const k = `${row.book_id}|${row.edition_id}|${row.device}`;
    const list = groups.get(k) ?? [];
    const sitting = sittingOf(row);
    const near = list.find((g) => mergeable(g.sitting, sitting, row.kind));
    if (near) near.sitting = merge(near.sitting, sitting, row.kind);
    else list.push({ row, sitting });
    groups.set(k, list);
  }
  const joined = [...groups.values()].flat().sort((a, b) => b.sitting.endedAt - a.sitting.endedAt);
  const more = rows.length > limit * 2;
  const shown = joined.filter((g) => worthShowing(g.sitting, g.row.kind)).slice(0, limit);
  const entries: HistoryEntry[] = shown.map(({ row, sitting: s }) => ({
    id: row.id,
    bookId: row.book_id,
    editionId: row.edition_id,
    kind: row.kind,
    device: row.device,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    activeMs: Math.round(s.activeMs),
    from: s.from,
    to: s.to,
    fromT: s.fromT,
    toT: s.toT,
    pages: s.fromPage !== null && s.toPage !== null ? { from: s.fromPage, to: Math.max(s.fromPage, s.toPage) } : null,
  }));
  const books = new Map<string, HistoryList['books'][number]>();
  for (const { row } of shown) {
    const book = books.has(row.book_id) ? null : bookById(db, row.book_id);
    if (book) books.set(book.id, { id: book.id, clubId: book.club_id, title: book.title, author: book.author, coverUrl: coverUrl(book) });
  }
  const oldest = entries.at(-1);
  return { entries, books: [...books.values()], next: (more || shown.length === limit) && oldest ? oldest.endedAt : null };
}

/** Forget one of your sittings (and any it was joined with when shown). Whether there was one. */
export function forgetSitting(db: Db, userId: string, id: string): boolean {
  const row = db.get<SittingRow>('SELECT * FROM reading_sessions WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) return false;
  const sitting = sittingOf(row);
  db.tx(() => {
    // Those it was shown joined with go too: a line forgotten must not come back in pieces.
    const near = db.all<SittingRow>(
      'SELECT * FROM reading_sessions WHERE user_id = ? AND book_id = ? AND edition_id = ? AND device = ? AND ended_at >= ? AND started_at <= ?',
      [userId, row.book_id, row.edition_id, row.device, row.started_at - SITTING_GAP_MS, row.ended_at + SITTING_GAP_MS],
    );
    for (const other of near) if (other.id === id || mergeable(sitting, sittingOf(other), row.kind)) db.exec('DELETE FROM reading_sessions WHERE id = ?', [other.id]);
  });
  return true;
}

/** Forget all your history of one book. How many sittings went. */
export function forgetBookHistory(db: Db, userId: string, bookId: string): number {
  return db.exec('DELETE FROM reading_sessions WHERE user_id = ? AND book_id = ?', [userId, bookId]).changes;
}
