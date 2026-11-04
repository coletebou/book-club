import {
  type BookDetail,
  type BookProgress,
  type CommentView,
  type Edition,
  type EditionTimeline,
  type Locator,
  locatorToM,
  locatorToT,
  mToLocator,
  tToLocator,
} from '@bookclub/shared';
import type { LocalPosition } from '../lib/db';

export function timelineOf(edition: Edition): EditionTimeline | null {
  return edition.geometry && edition.sync ? { geometry: edition.geometry, sync: edition.sync } : null;
}

export function tOf(edition: Edition, locator: Locator): number {
  const tl = timelineOf(edition);
  return tl && tl.geometry.kind === locator.kind ? locatorToT(tl, locator) : 0;
}

export interface StartPosition {
  readonly locator: Locator | null;
  readonly source: 'link' | 'server' | 'device' | 'other-format' | 'beginning';
  /**
   * When the place opened at was saved (the device's clock, as `MyProgress.at`), or null when
   * nothing was: a reader that opens there and reports the page is still at the place saved then,
   * and says so with that time, so that its copy of the place never outranks the save it came from
   * (D196: the narrator's exact place is not replaced by the page it was translated to).
   */
  readonly at: number | null;
  /** Opened at a link: where you would otherwise have opened (to come back to). */
  readonly resume?: Locator | null;
  /** Opened at a link: when that place to come back to was saved. */
  readonly resumeAt?: number | null;
}

/**
 * Where to open an edition. A deep link wins (a comment's place), then the newest of the saved
 * positions (server or this device). A position saved in another format is translated through
 * the timeline, so the listener who opens the EPUB lands on the matching page.
 */
export function startPosition(
  book: BookDetail,
  edition: Edition,
  progress: BookProgress | undefined,
  local: LocalPosition | undefined,
  linkT: number | null,
): StartPosition {
  const tl = timelineOf(edition);
  if (!tl) return { locator: null, source: 'beginning', at: null };
  if (linkT !== null && Number.isFinite(linkT)) {
    const otherwise = startPosition(book, edition, progress, local, null);
    return { locator: tToLocator(tl, Math.max(0, Math.min(1, linkT))), source: 'link', at: null, resume: otherwise.locator, resumeAt: otherwise.at };
  }
  const mine = progress?.mine;
  const candidates: { at: number; editionId: string; locator: Locator; t: number; source: StartPosition['source'] }[] = [];
  if (mine?.locator && mine.editionId) candidates.push({ at: mine.at, editionId: mine.editionId, locator: mine.locator, t: mine.t, source: 'server' });
  if (local && local.bookId === book.id) {
    const ed = book.editions.find((e) => e.id === local.editionId);
    candidates.push({ at: local.at, editionId: local.editionId, locator: local.locator, t: ed ? tOf(ed, local.locator) : 0, source: 'device' });
  }
  // Newest first; on a tie the server's copy, pushed first, stays first (the sort is stable).
  candidates.sort((a, b) => b.at - a.at);
  const best = candidates[0];
  if (!best) return { locator: null, source: 'beginning', at: null };
  if (best.editionId === edition.id && best.locator.kind === tl.geometry.kind) return { locator: best.locator, source: best.source, at: best.at };
  return { locator: translatePlace(book, edition, best) ?? tToLocator(tl, best.t), source: 'other-format', at: best.at };
}

/**
 * A place saved in one format, opened in another: through the timeline, and at a chapter's very
 * start at that format's own start of it (FR142, D93). The place is known by its edition and
 * locator, or, as the club's progress tells it, by its format alone and its t.
 */
export function translatePlace(
  book: BookDetail,
  to: Edition,
  place: { readonly t: number; readonly editionId?: string; readonly kind?: Edition['kind'] | null; readonly locator?: Locator },
): Locator | null {
  const tl = timelineOf(to);
  if (!tl) return null;
  // A place in this very edition is that place, to the millisecond or the character: never sent
  // through the timeline and back, which on a stretch of the edition that the book's text does not
  // have (an audiobook's opening announcement, its closing words) lands at that stretch's start, a
  // track's first second (D196).
  if (place.editionId === to.id && place.locator?.kind === tl.geometry.kind) return place.locator;
  const translated = tToLocator(tl, place.t);
  const from = book.editions.find((e) => e.id === place.editionId) ?? (place.kind ? book.editions.find((e) => e.kind === place.kind && timelineOf(e)) : undefined);
  if (!from || from.id === to.id) return translated;
  const fromTl = timelineOf(from);
  const locator = place.locator ?? (fromTl ? tToLocator(fromTl, place.t) : null);
  return (locator && atChapterStart(from, locator, translated, to)) ?? translated;
}

/**
 * How near its own start of a chapter a place counts as at it, in each format's measure (D93): in
 * characters, pages or milliseconds, before the start and after it. Before, little: a page that
 * opens a few lines above a chapter's heading, the top of a PDF page whose first lines are its
 * heading, a second of the track before; going on to the chapter skips no more than that. After,
 * the chapter's first page, or its track's first minute (LibriVox's preamble before the narrator
 * reads the chapter's heading runs to half of one), which never moves a place back: a place is
 * moved only where it would otherwise open before the chapter.
 */
const AT_START: Record<Locator['kind'], { readonly before: number; readonly after: number }> = {
  epub: { before: 300, after: 1_500 },
  pdf: { before: 0.25, after: 1 },
  audio: { before: 1_000, after: 60_000 },
};

/**
 * The chapter whose very start a place is at, in its own edition's measure, or null: of those near
 * enough, the one starting last (a short chapter's first page is near the one before's start too).
 */
function chapterStartedAt(edition: Edition, locator: Locator): number | null {
  if (!edition.geometry || edition.geometry.kind !== locator.kind) return null;
  const m = locatorToM(edition.geometry, locator);
  const near = AT_START[locator.kind];
  let found: { chapter: number; m: number } | null = null;
  for (const [u, unit] of edition.units.entries()) {
    const chapter = edition.alignment.unitToChapter[u];
    if (chapter == null || unit.m - m > near.before || m - unit.m > near.after) continue;
    if (!found || unit.m > found.m) found = { chapter, m: unit.m };
  }
  return found?.chapter ?? null;
}

/**
 * A place at a chapter's very start, opened in another format, opens at that format's own start of
 * the chapter where translating it would land before it (FR142, D93). A chapter's first words sit a
 * hair apart in each format's map: the EPUB's at its heading, a lined-up PDF's at its page's first
 * printed line, a transcribed audiobook's at the first word the recogniser matched, after "Chapter
 * six". Alice's chapter VI starts at 0.4034334, 0.4034375 and 0.4035086: from the EPUB's first page
 * of it, the PDF opened on chapter V's last page and the audiobook played its last seconds.
 */
function atChapterStart(from: Edition, locator: Locator, translated: Locator, to: Edition): Locator | null {
  const chapter = chapterStartedAt(from, locator);
  const u = chapter === null ? -1 : to.alignment.unitToChapter.indexOf(chapter);
  if (u === -1 || !to.geometry || to.geometry.kind !== translated.kind) return null;
  // Compared in the format's own measure: a lined-up PDF's title page and its chapter I's first page
  // are both at the story's start on the timeline, and translating takes the first.
  const start = to.units[u]!.m;
  return locatorToM(to.geometry, translated) < start ? mToLocator(to.geometry, start) : null;
}

/**
 * A note's or reply's place in `edition`: its own locator where it was made there, else through
 * the timeline, snapped forward past a chapter's very start exactly as a reader's own saved place
 * is (FR142, D93). Without the snap, a note made right at a chapter's start in another format (the
 * player, a note that followed a cross-format reader there) can translate to a hair before that
 * chapter in this one — inside the section already read past, never the one on screen — so its
 * marker never shows on the page while the club bar, which only ever needs `t`, still places it
 * in the right chapter.
 */
export function commentLocatorIn(book: BookDetail, edition: Edition, comment: Pick<CommentView, 't' | 'editionId' | 'kind' | 'locator'>): Locator | null {
  if (comment.editionId === edition.id && comment.locator.kind === edition.kind) return comment.locator;
  return translatePlace(book, edition, comment);
}
