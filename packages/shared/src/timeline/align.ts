import { type Counted, type Numbering, numberedAs, numbersOneChapter, titleSimilarity } from '../text/titles';
import { type SyncMap, type TiePoint, linearSyncMap, syncMapFromTiePoints } from './syncmap';

/** A chapter of the book, from the reference edition: where it starts on the timeline. */
export interface CanonicalChapter {
  readonly title: string;
  readonly t: number;
}

/** A unit of an edition (an audio track, a TOC entry, a PDF outline entry) and where it starts. */
export interface EditionUnit {
  readonly title: string;
  readonly m: number;
}

export type AlignmentMethod = 'count' | 'number' | 'title' | 'manual' | 'none';

export interface Alignment {
  readonly method: AlignmentMethod;
  /** Pairs of unit index → chapter index, increasing in both. */
  readonly pairs: readonly { readonly unit: number; readonly chapter: number }[];
}

/**
 * Most units an edition keeps: its tracks, the chapters marked inside them, or the entries of its
 * table of contents or outline. A long novel has a few hundred chapters; this leaves room for a
 * collected works while keeping what follows (matching, every answer about the book) small.
 */
export const MAX_EDITION_UNITS = 2000;

/**
 * Most unit and chapter pairs the title match weighs: it compares every unit with every chapter,
 * so this is about two hundred a side, a fraction of a second. Past it, titles are not matched.
 */
export const MAX_TITLE_MATCH_CELLS = 40_000;

/**
 * Least share of the book, from the chapter a match starts an edition at to the book's end, that
 * the match must carry the edition across (plausibleSpan, D73).
 */
export const MIN_MATCHED_SPAN = 0.9;

/** Most of the book its front matter (a title page, notes, the contents) may take: a tenth (D74). */
export const FRONT_MATTER_MAX = 0.1;

/** A chapter shorter than this share of the book's median chapter is short (frontMatterCount). */
const SHORT_CHAPTER = 0.25;

type Numbered = Numbering | null;

/**
 * How many of the book's first chapters are front matter rather than story (D74): those before the
 * first chapter its title numbers ("CHAPTER I.", "Chapter 1", "01"); in a book none of whose
 * chapters is numbered so, the short ones it opens with (each under a quarter of its median
 * chapter). Either way the story must start within the first tenth of the book, and a number
 * past the count of chapters (a year: "Copyright 2015") numbers no chapter of it. The Gutenberg
 * Alice opens with its title page, an edition's note and its contents, 538 characters in all
 * before CHAPTER I: three. An edition recorded or printed chapter by chapter has none of them.
 */
export function frontMatterCount(chapters: readonly CanonicalChapter[], numbers: readonly Numbered[] = chapters.map((c) => numberedAs(c.title))): number {
  const count = chapters.length;
  const numbered = (i: number) => {
    const x = numbers[i];
    return x?.counts === 'chapter' && x.n <= count;
  };
  const startsStory = (i: number) => chapters[i]!.t <= FRONT_MATTER_MAX;
  let first = 0;
  while (first < count && !numbered(first)) first++;
  if (first < count && startsStory(first)) return first;
  // No numbered chapter starts the story: the short ones the book opens with, up to its first numbered one.
  const lengths = chapters.map((c, i) => (i + 1 < count ? chapters[i + 1]!.t : 1) - c.t);
  const median = [...lengths].sort((a, b) => a - b)[Math.floor(count / 2)] ?? 0;
  let k = 0;
  while (k + 1 < Math.min(count, first + 1) && lengths[k]! < SHORT_CHAPTER * median && startsStory(k + 1)) k++;
  return k;
}

/** A title's number as the number match pairs it: a chapter's with a chapter's, a part's with a part's. */
const keyOf = (x: Numbered): string | null => (x === null ? null : `${x.counts}:${x.n}`);

/** What a recording is cut into regardless of its chapters: its parts, its discs, a tape's sides (D73). */
const CUTS: ReadonlySet<Counted> = new Set(['part', 'disc', 'side']);

/**
 * Of the titles in the same place on both sides that number the same kind of thing, the share whose
 * numbers agree; the units in order from the book's chapter `from` on. A unit that numbers a cut
 * of the recording where the book has a numbered chapter disagrees with it ("Part 3" against
 * "CHAPTER III."). Other kinds say nothing of each other: a track may hold a chapter or not, and a
 * book's own "BOOK I" or "PART ONE" may be what a file numbered "01" holds.
 */
function numbersAgree(chapterNumbers: readonly Numbered[], unitNumbers: readonly Numbered[], from = 0): number {
  let compared = 0;
  let disagree = 0;
  for (let i = 0; i < unitNumbers.length; i++) {
    const a = chapterNumbers[from + i] ?? null;
    const b = unitNumbers[i] ?? null;
    if (a === null || b === null) continue;
    const cut = a.counts === 'chapter' && CUTS.has(b.counts);
    if (a.counts !== b.counts && !cut) continue;
    compared++;
    if (cut || a.n !== b.n) disagree++;
  }
  return compared === 0 ? 1 : 1 - disagree / compared;
}

/** The first value of an increasing list that is greater than `after`. */
function firstAfter(list: readonly number[], after: number): number | undefined {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! > after) hi = mid;
    else lo = mid + 1;
  }
  return list[lo];
}

/**
 * Each numbered unit, in order, with the next chapter of the same number counting the same thing:
 * "Chapter 3" or "03" starts "CHAPTER III", but "Part 3" only a "Part III" of the book (D73).
 */
function matchByNumber(chapterNumbers: readonly Numbered[], unitNumbers: readonly Numbered[]) {
  // Where each number occurs among the chapters, so a unit finds its chapter without a scan.
  const chaptersNumbered = new Map<string, number[]>();
  chapterNumbers.forEach((x, c) => {
    const key = keyOf(x);
    if (key === null) return;
    const list = chaptersNumbered.get(key);
    if (list) list.push(c);
    else chaptersNumbered.set(key, [c]);
  });
  const pairs: { unit: number; chapter: number }[] = [];
  let lastChapter = -1;
  unitNumbers.forEach((x, u) => {
    const key = keyOf(x);
    const list = key === null ? undefined : chaptersNumbered.get(key);
    const chapter = list ? firstAfter(list, lastChapter) : undefined;
    if (chapter === undefined) return;
    pairs.push({ unit: u, chapter });
    lastChapter = chapter;
  });
  return pairs;
}

/**
 * Whether an edition numbers on past the last chapter its numbers were matched to: a unit after
 * the last pair counting the same thing with a higher number than that pair's. Its numbers are
 * then its own, not the book's (thirteen numbered parts of a twelve-chapter book: the thirteenth
 * would be heard inside chapter XII, and each part before it placed up to a part too far on).
 */
function numbersRunOn(unitNumbers: readonly Numbered[], pairs: readonly { readonly unit: number }[]): boolean {
  const last = pairs[pairs.length - 1];
  const held = last ? unitNumbers[last.unit] : null;
  if (!last || !held) return false;
  for (let u = last.unit + 1; u < unitNumbers.length; u++) {
    const x = unitNumbers[u];
    if (x && x.counts === held.counts && x.n > held.through) return true;
  }
  return false;
}

/**
 * The last chapter a matched unit holds: the one it is matched to, or, for a unit that names a
 * range of them ("Chapters 11-12"), the last of the range, when the chapters that follow are
 * numbered on to it.
 */
function lastChapterHeld(chapters: readonly CanonicalChapter[], units: readonly EditionUnit[], pair: { readonly unit: number; readonly chapter: number }): number {
  const held = units[pair.unit] ? numberedAs(units[pair.unit]!.title) : null;
  const own = chapters[pair.chapter] ? numberedAs(chapters[pair.chapter]!.title) : null;
  if (!held || !own || held.through === held.n || own.counts !== held.counts || own.n !== held.n) return pair.chapter;
  let c = pair.chapter;
  for (let n = held.n + 1; n <= held.through && c + 1 < chapters.length; n++) {
    const next = numberedAs(chapters[c + 1]!.title);
    if (!next || next.counts !== held.counts || next.n !== n) break;
    c++;
  }
  return c;
}

/**
 * Where on the timeline a match leaves an edition's story: at the end of the last chapter its last
 * matched unit holds (the next chapter's start, or the end of the book).
 */
function matchEnd(chapters: readonly CanonicalChapter[], units: readonly EditionUnit[], alignment: Alignment): number {
  const last = alignment.pairs[alignment.pairs.length - 1];
  if (!last) return 1;
  const through = lastChapterHeld(chapters, units, last);
  return through + 1 < chapters.length ? chapters[through + 1]!.t : 1;
}

/**
 * Monotone matching maximising total title similarity (similarities below 0.5 never match). It
 * weighs every pair, so past MAX_TITLE_MATCH_CELLS pairs it is not tried and nothing matches. A
 * title that only numbers its chapter ("Chapter II", "07") names nothing to pair by: its number is
 * the number match's, with that match's checks (D73), never a title's word shared by chance. The
 * Time Machine's LibriVox files "Chapter II" and "Chapter 13" count its tracks, not its chapters,
 * and "II. The Machine" is in the first (FR164, D115).
 */
function matchByTitle(chapters: readonly CanonicalChapter[], units: readonly EditionUnit[]) {
  const n = units.length;
  const k = chapters.length;
  if (n * k > MAX_TITLE_MATCH_CELLS) return [];
  const w = k + 1;
  const score = new Float64Array((n + 1) * w);
  const sims = new Float64Array(n * k);
  const unitNamed = units.map((u) => !numbersOneChapter(u.title));
  const chapterNamed = chapters.map((c) => !numbersOneChapter(c.title));
  for (let u = n - 1; u >= 0; u--) {
    for (let c = k - 1; c >= 0; c--) {
      const raw = unitNamed[u] && chapterNamed[c] ? titleSimilarity(units[u]!.title, chapters[c]!.title) : 0;
      const s = raw >= 0.5 ? raw : 0;
      sims[u * k + c] = s;
      score[u * w + c] = Math.max(score[(u + 1) * w + c]!, score[u * w + c + 1]!, s > 0 ? s + score[(u + 1) * w + c + 1]! : 0);
    }
  }
  const pairs: { unit: number; chapter: number }[] = [];
  let u = 0;
  let c = 0;
  while (u < n && c < k) {
    const s = sims[u * k + c]!;
    if (s > 0 && score[u * w + c] === s + score[(u + 1) * w + c + 1]!) {
      pairs.push({ unit: u, chapter: c });
      u++;
      c++;
    } else if (score[u * w + c] === score[(u + 1) * w + c]) u++;
    else c++;
  }
  return pairs;
}

/**
 * Decide which units of an edition start which canonical chapters.
 *
 * 1. Same number of units as chapters (and chapter numbers, where both sides have them, agree):
 *    pair them in order. LibriVox's twelve Alice tracks ↔ the twelve chapters of a book that has
 *    nothing else.
 * 2. Otherwise match on chapter numbers found in the titles or filenames ("Part 3" is no chapter's;
 *    "03" and "Chapter 3" are).
 * 3. Otherwise match on title similarity.
 * 4. Otherwise, as many units as the book has chapters once some of its front matter is left out
 *    (frontMatterCount): pair them in order from there. Twelve files "Track 01" to "Track 12" ↔
 *    the twelve chapters after the Gutenberg Alice's title page, edition's note and contents.
 * 5. Otherwise no chapter tie points: the edition maps linearly onto the timeline, and its units
 *    keep their own names.
 *
 * With the edition's extent known, a match is refused if it implies a wildly uneven pace
 * (plausiblePace), if it leaves the edition short of the book's end (plausibleSpan), or if the
 * edition's numbers run on past the chapters they were matched to.
 */
export function alignUnitsToChapters(
  chapters: readonly CanonicalChapter[],
  units: readonly EditionUnit[],
  range?: number | { readonly start: number; readonly end: number },
): Alignment {
  if (chapters.length === 0 || units.length === 0) return { method: 'none', pairs: [] };
  const plausible = (a: Alignment) => range === undefined || (plausiblePace(chapters, units, a, range) && plausibleSpan(chapters, units, a));
  // Each title's number is read once: the matches below compare them many times.
  const chapterNumbers = chapters.map((c) => numberedAs(c.title));
  const unitNumbers = units.map((u) => numberedAs(u.title));
  /** The units paired in order with the chapters from `from` on, if their numbers agree and the match is plausible. */
  const inOrder = (from: number): Alignment | null => {
    if (chapters.length - from !== units.length || numbersAgree(chapterNumbers, unitNumbers, from) < 0.75) return null;
    const byCount: Alignment = { method: 'count', pairs: units.map((_, i) => ({ unit: i, chapter: from + i })) };
    return plausible(byCount) ? byCount : null;
  };
  const byCount = inOrder(0);
  if (byCount) return byCount;
  const front = frontMatterCount(chapters, chapterNumbers);
  const byNumber: Alignment = { method: 'number', pairs: matchByNumber(chapterNumbers, unitNumbers) };
  // Enough of the units, or of the story's chapters (the front matter numbers none), are paired.
  const enough = byNumber.pairs.length >= Math.max(2, Math.ceil(Math.min(chapters.length - front, units.length) * 0.6));
  if (enough && plausible(byNumber) && (range === undefined || !numbersRunOn(unitNumbers, byNumber.pairs))) return byNumber;
  const byTitle: Alignment = { method: 'title', pairs: matchByTitle(chapters, units) };
  if (byTitle.pairs.length >= 2 && plausible(byTitle)) return byTitle;
  // As many units as the story has chapters, with some of its front matter or all of it left out.
  const from = chapters.length - units.length;
  if (from >= 1 && from <= front) return inOrder(from) ?? { method: 'none', pairs: [] };
  return { method: 'none', pairs: [] };
}

/**
 * The chapter each unit starts when an edition has as many units as the book has chapters, or as
 * it has once some of its front matter is left out (frontMatterCount): the units in order from
 * there. Null when the counts do not allow it. What the owner is offered when matching by hand.
 */
export function chaptersInOrder(chapters: readonly CanonicalChapter[], unitCount: number): number[] | null {
  const from = chapters.length - unitCount;
  if (unitCount === 0 || from < 0 || from > frontMatterCount(chapters)) return null;
  return Array.from({ length: unitCount }, (_, i) => from + i);
}

/**
 * Whether a match carries an edition about as far through the book as the edition goes (D73). Its
 * map (syncMapFromAlignment) puts all of the edition from its first matched unit on between that
 * unit's chapter and the end of the last chapter matched, so the share of the edition the matched
 * units cover is all of it from there; the share of the book the matched chapters cover, from that
 * chapter to the book's end, must be nearly all of it too: at least MIN_MATCHED_SPAN. Read as pace:
 * the text per second the match gives the recording as a whole is at least nine tenths of what
 * covering the rest of the book would take.
 *
 * Stretch by stretch a wrong match can look even. The LibriVox Alice joined and cut into eight
 * 22-minute parts numbered like chapters went on chapters I to VIII, each part about as long as its
 * chapter (plausiblePace kept it), so the trial was heard in chapter VIII: that match spans 0.680 of
 * the book; cut in two, 0.156. The LibriVox Alice by chapter and the tiny fixture span 1.000, as
 * does any match whose last unit starts the book's last chapter; a tenth is left for an ending the
 * edition has no unit of its own for (an unnumbered epilogue or afterword, a last file holding two
 * chapters without saying so: 0.919 in Alice). What lies before the first matched chapter (a title
 * page, a preface the recording skips) is not judged, as plausiblePace does not judge an intro.
 *
 * An edition of only part of the book (its first six chapters) is refused as well: by its matches
 * alone it cannot be told from one cut into parts. It is lined up from start to end, and its owner,
 * told so on the book page, can match it by hand.
 */
export function plausibleSpan(chapters: readonly CanonicalChapter[], units: readonly EditionUnit[], alignment: Alignment): boolean {
  const first = alignment.pairs[0];
  const from = first ? chapters[first.chapter]?.t : undefined;
  if (from === undefined || !(from < 1)) return true;
  return (matchEnd(chapters, units, alignment) - from) / (1 - from) >= MIN_MATCHED_SPAN;
}

/**
 * Pace of a match: edition measure per unit of book timeline, between consecutive tie points.
 * Narration speed and print density vary, but not by a factor of four between chapters of one
 * book; a match that implies that (24 numbered parts read as chapters 1 to 24 of a 12-chapter
 * book) would put half the audiobook into the last chapter, and its listeners deep into spoilers.
 *
 * A stretch shorter than 2 % of the book and 2 % of the edition is too short to judge alone (a
 * title page, a short track). Such stretches are pooled, and judged together once they add up to
 * 2 % of either: chapters squeezed into a moment (eleven chapter marks in the first half-minute of
 * a ten-hour audiobook) cannot slip through by each being short, as they did when only the book's
 * side was measured. What is left unjudged is under 2 % of each side, so a match with fewer than
 * two stretches to compare is a straight line, the map no match would give: it is kept, and a book
 * of one or two chapters stays aligned.
 */
export function plausiblePace(
  chapters: readonly CanonicalChapter[],
  units: readonly EditionUnit[],
  alignment: Alignment,
  range: number | { readonly start: number; readonly end: number },
): boolean {
  return implausibleStretch(chapters, units, alignment, range) === null;
}

/**
 * The stretch of a match that makes its pace implausible (plausiblePace), as the unit it starts
 * at and whether it is heard over too little of the book or too much; null when the pace is
 * plausible. A match the club owner makes by hand is held to this as one found by the server is:
 * A Christmas Carol's last track, matched to the stave its contents listed right before the stave's
 * subtitle, put 17.7 minutes into a few characters, and a friend on the stave's first page read a
 * note made at the end (D77).
 */
export function implausibleStretch(
  chapters: readonly CanonicalChapter[],
  units: readonly EditionUnit[],
  alignment: Alignment,
  range: number | { readonly start: number; readonly end: number },
): { readonly unit: number; readonly squeezed: boolean } | null {
  const { start, end } = typeof range === 'number' ? { start: 0, end: range } : range;
  const { points } = syncMapFromAlignment(chapters, units, alignment, range);
  const enough = (dm: number, dt: number) => dt >= 0.02 || dm >= (end - start) * 0.02;
  // Before the first matched unit (an intro track) the edition sits at that chapter's start by
  // design: that flat stretch is not judged.
  const lead = alignment.pairs[0] ? units[alignment.pairs[0].unit] : undefined;
  const intro = lead !== undefined && lead.m > start && points.length > 1 && points[1]!.t === points[0]!.t;
  /** Each pace, with the point its stretch (or the first of its pooled stretches) starts at. */
  const paces: { pace: number; from: number }[] = [];
  let pooledM = 0;
  let pooledT = 0;
  let pooledFrom = -1;
  for (let i = intro ? 2 : 1; i < points.length; i++) {
    const dt = points[i]!.t - points[i - 1]!.t;
    const dm = points[i]!.m - points[i - 1]!.m;
    if (enough(dm, dt)) {
      paces.push({ pace: dm / dt, from: i - 1 });
      continue;
    }
    if (pooledFrom < 0) pooledFrom = i - 1;
    pooledM += dm;
    pooledT += dt;
    if (enough(pooledM, pooledT)) {
      paces.push({ pace: pooledM / pooledT, from: pooledFrom });
      pooledM = 0;
      pooledT = 0;
      pooledFrom = -1;
    }
  }
  if (paces.length < 2) return null;
  const sorted = paces.map((p) => p.pace).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  // The unit a stretch starts at: the one whose start is its first point (the start of the
  // edition's story is its first matched unit's chapter).
  const unitAt = (point: number) => {
    const m = points[point]!.m;
    const found = units.findIndex((u) => Math.abs(u.m - m) < 1e-9);
    return found >= 0 ? found : (alignment.pairs[0]?.unit ?? 0);
  };
  // Part of the edition mapped onto a single moment has no finite pace: never plausible.
  if (!(Number.isFinite(median) && median > 0)) {
    const off = paces.find((p) => !Number.isFinite(p.pace)) ?? paces[0]!;
    return { unit: unitAt(off.from), squeezed: true };
  }
  if (paces.every((p) => p.pace <= median * 4 && p.pace >= median / 4)) return null;
  // The stretch furthest from the others' pace is named (with two, the one heard over less of the
  // book: the one whose end would reach friends early).
  const mean = Math.exp(paces.reduce((sum, p) => sum + Math.log(p.pace), 0) / paces.length);
  const off = paces.reduce((worst, p) => {
    const d = Math.abs(Math.log(p.pace / mean));
    const w = Math.abs(Math.log(worst.pace / mean));
    return d > w + 1e-9 || (Math.abs(d - w) <= 1e-9 && p.pace > worst.pace) ? p : worst;
  });
  return { unit: unitAt(off.from), squeezed: off.pace > mean };
}

/**
 * The sync map implied by an alignment. Each paired unit start is tied to its chapter start; the
 * end of the edition's story is tied to the end of the last chapter the last paired unit holds
 * (the next chapter's start, or the end of the book): its own chapter, or the last of the range a
 * unit names ("Chapters 11-12"). Unpaired units in between are interpolated. `range` is the part
 * of the edition's measure that holds the story (an EPUB's licence appendix lies outside it); a
 * number means `[0, number]`.
 */
export function syncMapFromAlignment(
  chapters: readonly CanonicalChapter[],
  units: readonly EditionUnit[],
  alignment: Alignment,
  range: number | { readonly start: number; readonly end: number },
): SyncMap {
  const { start, end } = typeof range === 'number' ? { start: 0, end: range } : range;
  if (!(end > start)) return linearSyncMap(0, 1);
  if (alignment.pairs.length === 0) return linearSyncMap(start, end);
  // Anything before the first paired unit (an intro track, a preface) sits at that chapter's start.
  const firstChapter = chapters[alignment.pairs[0]!.chapter];
  const ties: TiePoint[] = [{ m: start, t: firstChapter?.t ?? 0 }];
  for (const { unit, chapter } of alignment.pairs) {
    const u = units[unit];
    const c = chapters[chapter];
    if (u && c && u.m >= start && u.m < end) ties.push({ m: u.m, t: c.t });
  }
  ties.push({ m: end, t: matchEnd(chapters, units, alignment) });
  return syncMapFromTiePoints(ties);
}

/** Validate a manual alignment (from the book settings) against the chapter and unit lists. */
export function manualAlignment(
  chapters: readonly CanonicalChapter[],
  units: readonly EditionUnit[],
  unitToChapter: readonly (number | null)[],
): Alignment {
  const pairs: { unit: number; chapter: number }[] = [];
  let lastChapter = -1;
  for (let u = 0; u < Math.min(units.length, unitToChapter.length); u++) {
    const c = unitToChapter[u];
    if (c === null || c === undefined) continue;
    if (!Number.isInteger(c) || c < 0 || c >= chapters.length || c <= lastChapter) continue;
    pairs.push({ unit: u, chapter: c });
    lastChapter = c;
  }
  return { method: pairs.length > 0 ? 'manual' : 'none', pairs };
}
