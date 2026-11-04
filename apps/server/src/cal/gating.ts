import { rangesCover, type Span } from '@bookclub/shared';
import { type Db } from '../db/db';
import { type BookRow, bookById } from '../repos/books';
import { progressFor, readingOf } from '../repos/progress';
import { gateFor } from '../services/gating';
import { booksInSeries } from './store';
import { type CalChunkRow } from './types';

/**
 * Cal's spoiler gate (D162): spoiler-safe by default, configurable. Book search returns a chunk
 * only when the asker has read every word it holds — the very rule the reader and the comment
 * gate use (services/gating.ts), reused here through Gate.readSpans — and a book later in a
 * series the asker has never opened is left out of the candidate set entirely, before full-text
 * or vector search even runs on it, so it can never surface by a stray keyword match either.
 * "Cal may use the whole series" (a standing per-user setting, passed in as `wholeSeries`; since
 * D183 there is no per-question override) lifts both rules for every book of that series; a
 * standalone book outside any series is never affected by it.
 */
export class CalGate {
  private readonly startedSeries = new Map<string, boolean>();
  private readonly readSpansCache = new Map<string, readonly Span[]>();

  constructor(
    private readonly db: Db,
    private readonly userId: string,
    private readonly wholeSeries: boolean,
  ) {}

  /** Whether a book is in the asker's candidate set at all (before any position filtering). */
  bookIncluded(book: BookRow): boolean {
    if (!book.series_id) return true;
    if (this.wholeSeries) return true;
    return this.hasStarted(book.id);
  }

  /** Whether a book's position filter should be skipped entirely (the series override, D162). */
  skipsPositionFilter(book: BookRow): boolean {
    return this.wholeSeries && book.series_id !== null;
  }

  /** Whether `chunk` falls inside what the asker has read of its book (services/gating.ts's own rule). */
  chunkReadable(book: BookRow, chunk: Pick<CalChunkRow, 't_start' | 't_end'>): boolean {
    if (chunk.t_start === null) return false;
    if (this.skipsPositionFilter(book)) return true;
    const spans = this.spansFor(book);
    const end = chunk.t_end ?? chunk.t_start;
    return rangesCover(spans, chunk.t_start, end);
  }

  private hasStarted(bookId: string): boolean {
    let started = this.startedSeries.get(bookId);
    if (started === undefined) {
      started = progressFor(this.db, this.userId, bookId) !== undefined;
      this.startedSeries.set(bookId, started);
    }
    return started;
  }

  private spansFor(book: BookRow): readonly Span[] {
    let spans = this.readSpansCache.get(book.id);
    if (!spans) {
      const gate = gateFor(this.db, book);
      const reading = readingOf(this.db, this.userId, book.id);
      spans = gate.readSpans(reading);
      this.readSpansCache.set(book.id, spans);
    }
    return spans;
  }
}

/**
 * Where a user stands in a series (for whats_my_place and for explaining to a user why a book is
 * missing from search): the furthest book, by series order, they have any progress in.
 */
export function seriesProgress(db: Db, userId: string, seriesId: string): { bookId: string; title: string } | null {
  const books = booksInSeries(db, seriesId);
  let furthest: { bookId: string; title: string; order: number } | null = null;
  for (const b of books) {
    if (progressFor(db, userId, b.id) === undefined) continue;
    const order = b.series_order ?? Number.POSITIVE_INFINITY;
    if (!furthest || order > furthest.order) furthest = { bookId: b.id, title: b.title, order };
  }
  return furthest ? { bookId: furthest.bookId, title: furthest.title } : null;
}

export { bookById };
