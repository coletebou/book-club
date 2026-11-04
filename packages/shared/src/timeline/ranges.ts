/**
 * Read ranges: the parts of the book timeline a member has actually had on screen or heard,
 * as a sorted list of disjoint half-open intervals `[start, end)` inside [0, 1].
 *
 * Half-open so that the first character of the next page (which is the exclusive end of the
 * current page) is not "read" yet. The interval that reaches the very end of the book (`end`
 * of 1) includes 1 itself, so a comment on the last moment of the audiobook can be revealed.
 */

export type Span = readonly [start: number, end: number];

/** Spans this close are treated as touching (absorbs floating-point noise between pages). */
export const RANGE_EPSILON = 1e-9;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Clamp, drop empty or invalid spans, sort and merge. */
export function normalizeRanges(spans: readonly Span[]): Span[] {
  const cleaned = spans
    .filter((s) => Number.isFinite(s[0]) && Number.isFinite(s[1]))
    .map((s): Span => {
      const a = clamp01(Math.min(s[0], s[1]));
      const b = clamp01(Math.max(s[0], s[1]));
      return [a, b];
    })
    .filter((s) => s[1] - s[0] > 0)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of cleaned) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + RANGE_EPSILON) {
      if (b > last[1]) last[1] = b;
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

export function addSpan(ranges: readonly Span[], span: Span): Span[] {
  return normalizeRanges([...ranges, span]);
}

export function unionRanges(a: readonly Span[], b: readonly Span[]): Span[] {
  return normalizeRanges([...a, ...b]);
}

/** Whether timeline position `t` has been read. */
export function rangesContain(ranges: readonly Span[], t: number): boolean {
  if (!Number.isFinite(t)) return false;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (t < a) hi = mid - 1;
    else if (t < b || (b >= 1 && t <= 1)) return true;
    else lo = mid + 1;
  }
  return false;
}

/**
 * Whether the whole passage `[from, to)` has been read in one stretch: a note quoting two
 * sentences, the second on a page not yet turned to, is not read yet.
 */
export function rangesCover(ranges: readonly Span[], from: number, to: number): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  if (!(to > from)) return rangesContain(ranges, from);
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (from < a) hi = mid - 1;
    else if (from < b || (b >= 1 && from <= 1)) return to <= b + RANGE_EPSILON || (b >= 1 && to <= 1);
    else lo = mid + 1;
  }
  return false;
}

/** Total fraction of the book read. */
export function rangesCoverage(ranges: readonly Span[]): number {
  return ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
}

/** The furthest point read, or 0. */
export function rangesFurthest(ranges: readonly Span[]): number {
  return ranges.length === 0 ? 0 : ranges[ranges.length - 1]![1];
}

/** How much of the story you must have read, with the ending, for the book to count as finished. */
export const FINISHED_COVERAGE = 0.9;

/**
 * True once the member has read the book: its last part, and nearly all of the rest (a few
 * pages skipped or read on a device that never synced still count). Jumping to the last page
 * is not finishing.
 */
export function rangesFinished(ranges: readonly Span[]): boolean {
  return rangesFurthest(ranges) >= 1 - RANGE_EPSILON && rangesCoverage(ranges) >= FINISHED_COVERAGE - RANGE_EPSILON;
}
