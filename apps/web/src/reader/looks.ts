/**
 * Looks (D41, D58, D62, D72): going somewhere in the book is not reading there. These decide, the
 * same way in the EPUB and the PDF reader, when reading takes over from a look, and what of it
 * then counts as read.
 */

/** How many pages read on there make a look past where you have read your reading there (D72). */
export const PAGES_TO_READ_ON = 3;

/** Positions this close are one (rounding in the maps between formats). */
const EPS = 1e-9;

/** A page on the book's timeline (0..1): where it starts and where it ends. */
export interface PageSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * A page read during a look: where it starts and ends in its edition's own measure (characters,
 * pages), and as the edition's own places.
 */
export interface SeenPage<L> {
  readonly start: number;
  readonly end: number;
  readonly from: L;
  readonly to: L;
}

/**
 * Whether a page lies past where you have read (D72): it starts more than a page (its own
 * length) beyond the furthest point you have read, so a page you have not read lies between. The
 * page just after that point does not: reading on there is reading on from where you were.
 */
export function pastWhereRead(page: PageSpan, furthest: number): boolean {
  return page.start > furthest + Math.max(0, page.end - page.start) + EPS;
}

/**
 * The pages read during a look, in order and once each, with one more: a page is read once you
 * turn on from it. The same page again, or one starting inside a page read already (the book was
 * laid out again), is not another.
 */
export function readPage<L>(read: readonly SeenPage<L>[], page: SeenPage<L>): readonly SeenPage<L>[] {
  const again = read.some((p) => Math.abs(page.start - p.start) <= EPS || (page.start > p.start && page.start < p.end - EPS));
  return again ? read : [...read, page].sort((a, b) => a.start - b.start);
}

/** The pages read during a look as stretches of touching pages, to count as read. */
export function readRuns<L>(read: readonly SeenPage<L>[]): { from: L; to: L }[] {
  const runs: { from: L; to: L; end: number }[] = [];
  for (const p of read) {
    const last = runs[runs.length - 1];
    if (last && p.start <= last.end + EPS) {
      if (p.end > last.end) {
        last.to = p.to;
        last.end = p.end;
      }
    } else runs.push({ from: p.from, to: p.to, end: p.end });
  }
  return runs.map(({ from, to }) => ({ from, to }));
}

/** A page turned during a look. */
export interface LookTurn {
  /** On to the next page, not back. */
  readonly forward: boolean;
  /** The page turned from, on the book's timeline. */
  readonly from: PageSpan;
  /** The furthest point you have read, on the timeline (your place, if that is further). */
  readonly furthest: number;
  /** The pages read during the look (`readPage`), the one turned from included. */
  readonly pagesRead: number;
  /**
   * Whether the pages turned from and to lie ahead of your place, in the reader's own terms; null
   * with no place to come back to.
   */
  readonly place: { readonly fromAhead: boolean; readonly toAhead: boolean } | null;
}

/**
 * Whether a page turned during a look is reading, so that the look ends there:
 * - past where you have read (D72), only reading on there is, once `PAGES_TO_READ_ON` pages have
 *   been read in the look: a curious peek and a page or two never move your place, and turning
 *   back never is;
 * - ahead of your place, but not past where you have read, any turn is (D62: reading on there);
 * - behind your place, only reading forward through it is (D62: flipping back to find a passage);
 * - with no place to come back to, any page turn is.
 */
export function turnIsReading(turn: LookTurn): boolean {
  if (!turn.place) return true;
  if (pastWhereRead(turn.from, turn.furthest)) return turn.forward && turn.pagesRead >= PAGES_TO_READ_ON;
  return turn.place.fromAhead || (turn.forward && turn.place.toAhead);
}
