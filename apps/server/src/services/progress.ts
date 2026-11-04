import {
  type BookProgress,
  type Locator,
  type ProgressUpdateBody,
  type ProgressUpdateResult,
  type RevealedComment,
  type Span,
  locatorToM,
  locatorToT,
  normalizeRanges,
  rangesCoverage,
  rangesFinished,
  rangesFurthest,
  totalMeasure,
} from '@bookclub/shared';
import { type Db } from '../db/db';
import { badRequest } from '../lib/errors';
import { toJson } from '../lib/json';
import { type BookRow, type EditionRow, bookChapters, editionTimeline } from '../repos/books';
import { mediaForComments } from '../repos/comment-media';
import { commentsForBook } from '../repos/comments';
import { bookAudioControls, bookPlayback } from '../repos/playback';
import { type ProgressRow, type Reading, progressFor, readRanges, readingOf, saveEditionRanges, saveProgress, toMyProgress } from '../repos/progress';
import { memberProgressList } from './books';
import { addReadSpans, gateFor, joinGap } from './gating';
import { placeLabel } from './labels';

function timelineOf(edition: EditionRow) {
  const timeline = editionTimeline(edition);
  if (!timeline) throw badRequest('That edition is not ready yet.');
  return timeline;
}

function tFor(edition: EditionRow, locator: Locator): number {
  const timeline = timelineOf(edition);
  if (timeline.geometry.kind !== locator.kind) throw badRequest(`A ${locator.kind} position does not belong to this ${edition.kind} edition.`);
  return locatorToT(timeline, locator);
}

/** Where a position is in its edition's own measure (after tFor has checked it belongs there). */
function measureFor(edition: EditionRow, locator: Locator): number {
  return locatorToM(timelineOf(edition).geometry, locator);
}

/**
 * Add what was read in an edition, in its own measure, to what was read there before: no change
 * of its sync map can move it, and notes made in that edition open exactly where it reaches them.
 */
function readIn(db: Db, userId: string, book: BookRow, edition: EditionRow, reading: Reading, spans: readonly Span[]): Reading {
  if (spans.length === 0) return reading;
  const geometry = timelineOf(edition).geometry;
  const total = totalMeasure(geometry);
  const ranges = addReadSpans(reading.byEdition.get(edition.id) ?? [], spans, total, joinGap(geometry, total));
  saveEditionRanges(db, userId, book.id, edition.id, ranges);
  return { ...reading, byEdition: new Map(reading.byEdition).set(edition.id, ranges) };
}

/** The notes that opened for a member: closed to them before, open now. */
function newlyOpen(db: Db, book: BookRow, userId: string, before: Reading, after: Reading): RevealedComment[] {
  if (after === before) return [];
  const gate = gateFor(db, book);
  const comments = commentsForBook(db, book.id);
  const media = mediaForComments(db, comments.map((c) => c.id));
  const revealed: RevealedComment[] = [];
  for (const c of comments) {
    if (c.user_id === userId || gate.isOpen(c, userId, before)) continue;
    const view = gate.view(c, userId, after, media.get(c.id) ?? []);
    if (!view.hidden) revealed.push(view);
  }
  return revealed;
}

/** How far ahead of the server a device's clock may run. */
const CLOCK_SKEW_MS = 5 * 60_000;

export interface ProgressOutcome extends ProgressUpdateResult {
  /** True when the saved position moved (others should hear about it). */
  readonly changed: boolean;
}

/**
 * Merge one progress report:
 * - read ranges are unioned (order-independent, so offline replays converge), on the book's
 *   timeline and in the edition's own measure;
 * - the position is last-writer-wins by the client's timestamp;
 * - comments the new ranges open are returned, now revealed.
 */
export function applyProgress(db: Db, userId: string, book: BookRow, edition: EditionRow, body: ProgressUpdateBody): ProgressOutcome {
  return db.tx(() => {
    const existing = progressFor(db, userId, book.id);
    const before = readRanges(existing);
    const spans: Span[] = body.readSpans.map(({ from, to }) => [tFor(edition, from), tFor(edition, to)] as const);
    const after = normalizeRanges([...before, ...spans]);
    const t = tFor(edition, body.locator);
    // A device whose clock runs fast must not freeze the position: no report is later than now.
    const at = Math.min(body.at, Date.now() + CLOCK_SKEW_MS);
    // Strictly newer (D196): a report of the same moment is the place already kept, as another
    // format says it (a reader opened at the narrator's place reports its page with the time the
    // narrator was there), and must not replace the narrator's own, to the millisecond, with that.
    const newer = !existing || at > existing.client_at;
    const chapters = bookChapters(book);
    const finishedNow = rangesFinished(after);
    const row: Omit<ProgressRow, 'updated_at' | 'unplaced_ranges_json'> = {
      user_id: userId,
      book_id: book.id,
      edition_id: newer ? edition.id : existing.edition_id,
      locator_json: newer ? toJson(body.locator) : existing.locator_json,
      t: newer ? t : existing.t,
      label: newer ? placeLabel(chapters, edition, body.locator, t) : existing.label,
      client_at: newer ? at : existing.client_at,
      read_ranges_json: toJson(after),
      furthest: rangesFurthest(after),
      coverage: rangesCoverage(after),
      finished_at: existing?.finished_at ?? (finishedNow ? Date.now() : null),
    };
    saveProgress(db, row);
    const reading = readingOf(db, userId, book.id, existing ?? null);
    const now = readIn(db, userId, book, edition, reading, body.readSpans.map(({ from, to }) => [measureFor(edition, from), measureFor(edition, to)] as const));
    const saved = progressFor(db, userId, book.id)!;
    const changed = !existing || newer || before.length !== after.length || rangesFurthest(before) !== rangesFurthest(after);
    return { mine: toMyProgress(saved), revealed: newlyOpen(db, book, userId, reading, now), changed };
  });
}

/** "I've already read up to here": adds [0, t] to the member's read ranges, in this edition. */
export function readUpTo(db: Db, userId: string, book: BookRow, edition: EditionRow, locator: Locator): ProgressOutcome {
  const t = tFor(edition, locator);
  return db.tx(() => {
    const existing = progressFor(db, userId, book.id);
    const before = readRanges(existing);
    const after = normalizeRanges([...before, [0, t]]);
    const chapters = bookChapters(book);
    // Positions are ordered by the devices' own clocks (D20): this one stays in that order, just
    // after the last report, rather than taking the server's time and outranking the device.
    saveProgress(db, {
      user_id: userId,
      book_id: book.id,
      edition_id: edition.id,
      locator_json: toJson(locator),
      t,
      label: placeLabel(chapters, edition, locator, t),
      client_at: (existing?.client_at ?? 0) + 1,
      read_ranges_json: toJson(after),
      furthest: rangesFurthest(after),
      coverage: rangesCoverage(after),
      finished_at: existing?.finished_at ?? (rangesFinished(after) ? Date.now() : null),
    });
    const reading = readingOf(db, userId, book.id, existing ?? null);
    const now = readIn(db, userId, book, edition, reading, [[0, measureFor(edition, locator)]]);
    const saved = progressFor(db, userId, book.id)!;
    return { mine: toMyProgress(saved), revealed: newlyOpen(db, book, userId, reading, now), changed: true };
  });
}

export function bookProgress(db: Db, userId: string, book: BookRow): BookProgress {
  const mine = progressFor(db, userId, book.id);
  // Your own speed for this book (D195), with your own place: the player opens at both at once;
  // and whether its audiobook's controls are shown in it (D197), which the reader needs as it opens.
  return { mine: mine ? toMyProgress(mine) : null, members: memberProgressList(db, book), playback: bookPlayback(db, userId, book.id), audioControls: bookAudioControls(db, userId, book.id) };
}

export { tFor };
