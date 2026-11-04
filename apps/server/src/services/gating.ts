import {
  type Chapter,
  type CommentView,
  type EditionGeometry,
  type EditionKind,
  type EditionTimeline,
  type Locator,
  type RevealedComment,
  type Span,
  type SyncMap,
  RANGE_EPSILON,
  chapterNameAt,
  formatPercent,
  locatorToM,
  mToLocator,
  mToT,
  memberColor,
  normalizeRanges,
  rangesContain,
  rangesCover,
  slotColor,
  tToM,
  totalMeasure,
  unitStarts,
} from '@bookclub/shared';
import { type Db } from '../db/db';
import { fromJson, isoRequired } from '../lib/json';
import { type BookRow, type EditionRow, bookChapters, editionAlignment, editionTimeline, editionUnits, editionsForBook } from '../repos/books';
import { type CommentMediaRow } from '../repos/comment-media';
import { type CommentWithAuthor, type Horizon } from '../repos/comments';
import { type Reading, progressFor, readingOf } from '../repos/progress';
import { type ReadAlongRow, readAlongSentences, readAlongsForBook } from '../repos/readalong';

/**
 * Spoiler gating. A comment's text and quoted passage are released only to its author or to a
 * member who has read all of it: its position, and for a note on a passage, the whole passage
 * (a quote can run onto a page the reader has not reached). Everyone else receives a marker: who,
 * where, and the reaction emoji (the spoiler-free sentiment v1 designed), never the words.
 *
 * What a member read is kept per edition. In the edition a note was made in, its place is exact:
 * it opens the moment their reading there reaches it. Reading in another format reaches it through
 * two sync maps, and a map lined up with the book only by chapters places words inside a chapter
 * by interpolation: an audiobook's up to 44 s from the narration (docs/ALIGNMENT.md). So from
 * another format a note opens only once all of where it may really be has been read, and only
 * the part of what was read that cannot be anywhere else counts: never early, at the price of a
 * minute of listening (or a page) before a friend's note opens. A map matched to no chapter is a
 * straight line over the whole book, and the price there is six per cent of the book (D73, D74).
 * Where a forced alignment lined an edition up with the reference word by word (an audiobook's
 * transcript, D46; a PDF's printed lines, D75), there is no margin: a note there is judged as one
 * within its own edition, a PDF's to the line.
 *
 * A comment also waits for where its writer had read to when they wrote it (its horizon, D69),
 * judged as a note made there would be: a friend far ahead answering an early note (a reply sits
 * at its note's place, D48), or writing one while paging back (D62), does not put a later chapter
 * into it for those who have read only the early place. They see a marker that says where the
 * writer had read to, never the words.
 */

/** How far an audiobook lined up by chapters can be from its text: a minute (measured: 44.1 s at most). */
export const AUDIO_MARGIN_MS = 60_000;
/** How far a PDF lined up by chapters can be from another format: a page. */
export const PDF_MARGIN_PAGES = 1;
/** Two EPUBs lined up by chapters: the same words, give or take about a printed page. */
export const TEXT_MARGIN_CHARS = 2000;
/**
 * And at least this share of the stretch the map interpolates there, however long: a chapter
 * map's error grows with the chapter (measured: 5.6 % of it at most, on chapters of ten to fifteen
 * minutes), and between places the map is sure of that lie further apart, with all of the stretch
 * between them (D73).
 */
export const CHAPTER_SHARE = 0.1;
/**
 * A map matched to no chapter is sure only of the book's ends: a straight line, and its margin is
 * this share of the book (D74). Measured on the Alice books, a straight line is off by up to 3.06 %
 * of the book at a chapter's start (the LibriVox recording against the Gutenberg EPUB; the Alice
 * PDF, 2.65 %), and inside a chapter by that and the chapter map's own error besides (44 s of 2 h
 * 59 min, 0.41 %): 3.5 % at most. Six per cent leaves that the headroom CHAPTER_SHARE leaves a
 * chapter map (1.7 times what was measured), for books less even than Alice: some eleven minutes of
 * Alice's recording, or five and a half of its PDF's 91 pages, where a tenth of the book was
 * eighteen minutes and nine pages.
 */
export const LINE_SHARE = 0.06;

/**
 * Read to a place is read up to it, not of it: the place a chapter starts at, read to, is the end
 * of the chapter before. Named a hair before it (chapterNameAt holds a start 1e-12 either side).
 */
const READ_TO_STEP = 1e-9;

/** How closely a note ahead of you is placed for you (D80): half a per cent of the book. */
export const ROUGH_STEP = 0.005;
/** Places of an edition's measure this close are one place. */
const SAME_PLACE = 1e-6;

/**
 * Listening paused and played on again resumes a few milliseconds off where it stopped (WebKit, a
 * reload): pieces this close are one stretch heard. A skip is fifteen seconds or more.
 */
export const LISTENING_JOIN_MS = 2000;

/** How close two stretches read in an edition must be to count as one: see LISTENING_JOIN_MS. */
export function joinGap(geometry: EditionGeometry, total: number): number {
  return geometry.kind === 'audio' ? LISTENING_JOIN_MS : total * RANGE_EPSILON;
}

/**
 * What was read in one edition, in its own measure: spans `[start, end)`, sorted and merged like
 * the book's read ranges (packages/shared timeline/ranges.ts), but inside the edition's extent
 * instead of [0, 1], pieces within `gap` of each other joined (joinGap); the span that reaches its
 * end holds the very end too.
 */
export function addReadSpans(ranges: readonly Span[], spans: readonly Span[], total: number, gap = total * RANGE_EPSILON): Span[] {
  const cleaned = [...ranges, ...spans]
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .map(([a, b]): Span => [Math.min(total, Math.max(0, Math.min(a, b))), Math.min(total, Math.max(0, Math.max(a, b)))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of cleaned) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Whether place `m` of an edition was read; with `to`, all of `[m, to)` in one stretch. */
function readThere(ranges: readonly Span[], total: number, m: number, to = m): boolean {
  return ranges.some(([a, b]) => m >= a && (m < b || (b >= total && m <= total)) && (to <= m || to <= b + total * RANGE_EPSILON || (b >= total && to <= total)));
}

/** What decides whether a comment is open: its place, and where its writer had read to (D69). */
export type Gated = Pick<CommentWithAuthor, 'user_id' | 'edition_id' | 'locator_json' | 'end_locator_json' | 't' | 'end_t'> &
  Partial<Pick<CommentWithAuthor, 'horizon_edition_id' | 'horizon_locator_json' | 'horizon_t'>>;

/**
 * What a member may do with a comment's words: read them (`open`); not yet, its place is ahead of
 * them (`ahead`); or not yet, they have read its place but not as far as its writer had (`held`).
 */
export type Access = 'open' | 'ahead' | 'held';

/**
 * How far past a comment's place its writer may have read without that holding it: what one page
 * shows. A note is written on the page on screen, which counts as read for everyone (D12), and an
 * EPUB's pages differ from device to device (measured on War and Peace at the default font: 2,132
 * characters a page on a laptop, 858 on an iPhone), so the writer's own page is not held, up to
 * about a printed page; a PDF's page is the same everywhere; and a listener writes while the
 * narration plays on, so a minute of it.
 */
export const HORIZON_PAGE: Readonly<Record<EditionKind, number>> = { epub: 2000, pdf: 1, audio: 60_000 };

/** A comment's horizon as a place of its own, judged as a note made there would be. */
function horizonPlace(comment: Gated): Gated | null {
  const { horizon_edition_id: editionId, horizon_locator_json: locator, horizon_t: t } = comment;
  if (!editionId || !locator || t === null || t === undefined) return null;
  return { user_id: comment.user_id, edition_id: editionId, locator_json: locator, end_locator_json: null, t, end_t: null };
}

/** A place an edition's map is right whatever happens inside chapters, and the t it is at. */
interface Anchor {
  readonly m: number;
  lo: number;
  hi: number;
}

interface Placed {
  readonly geometry: EditionGeometry;
  readonly sync: SyncMap;
  readonly total: number;
  /** The edition the timeline rests on: its map is exact by definition. */
  readonly reference: boolean;
  /** How far its map can be off, in its own measure. */
  readonly slack: number;
  /** Stretches of its measure a trusted forced alignment lined up with the reference, sentence by sentence or line by line. */
  readonly exact: readonly (readonly [number, number])[];
  readonly anchors: readonly Anchor[];
  /** Its map is a straight line from its story's start to its end: it was matched to no chapter. */
  readonly straight: boolean;
  /**
   * A PDF whose printed text was lined up with the reference (D75): where on the timeline its lines
   * start, in order, wherever that alignment holds; else none.
   */
  readonly lines: readonly number[];
}

function slackOf(kind: EditionKind | undefined): number {
  return kind === 'audio' ? AUDIO_MARGIN_MS : kind === 'pdf' ? PDF_MARGIN_PAGES : 0;
}

/**
 * Where an edition's place in the book is known whatever its map does inside chapters: each unit
 * matched to a chapter starts it, and its map's ends are the story's. Anchors that disagree with
 * the ones before them (a book whose contents are not in reading order) are no guide.
 */
function anchorsOf(edition: EditionRow, sync: SyncMap, chapters: readonly Chapter[]): Anchor[] {
  const units = editionUnits(edition);
  const points = [sync.points[0]!, sync.points[sync.points.length - 1]!];
  editionAlignment(edition).unitToChapter.forEach((c, u) => {
    const unit = units[u];
    const chapter = c === null ? undefined : chapters[c];
    if (unit && chapter) points.push({ m: unit.m, t: chapter.t });
  });
  points.sort((a, b) => a.m - b.m);
  const anchors: Anchor[] = [];
  for (const p of points) {
    const last = anchors[anchors.length - 1];
    if (last && p.m - last.m <= SAME_PLACE) {
      last.lo = Math.min(last.lo, p.t);
      last.hi = Math.max(last.hi, p.t);
    } else if (!last || p.t >= last.hi) {
      anchors.push({ m: p.m, lo: p.t, hi: p.t });
    }
  }
  return anchors;
}

/** An edition a forced alignment lined up word by word with another: that edition, and the stretches of its own measure it holds. */
interface WordAligned {
  readonly partner: string;
  readonly stretches: readonly (readonly [number, number])[];
}

/**
 * Stretches of an edition that a forced alignment lined up with another edition, in its own
 * measure, and that edition: the tracks of an audiobook that aligned (they have sentences), or the
 * text read in each of them when the audiobook is the reference; the pages of a PDF whose printed
 * lines were lined up with the text, or the text they hold when the PDF is the reference (D75).
 */
function wordAligned(edition: EditionRow, geometry: EditionGeometry, readAlongs: readonly ReadAlongRow[]): WordAligned | null {
  const alignment = editionAlignment(edition);
  if (alignment.method !== 'forced') return null;
  if (alignment.printed) return { partner: alignment.printed.editionId, stretches: alignment.printed.exact };
  const row = readAlongs.find((r) => r.refined_edition_id === edition.id);
  if (!row) return null;
  const partner = row.audio_edition_id === edition.id ? row.text_edition_id : row.audio_edition_id;
  const starts = unitStarts(geometry);
  const tracks = readAlongSentences(row);
  if (geometry.kind === 'audio') {
    return { partner, stretches: tracks.flatMap((sentences, k): [number, number][] => (sentences.length > 0 && k + 1 < starts.length ? [[starts[k]!, starts[k + 1]!]] : [])) };
  }
  if (geometry.kind !== 'epub') return null;
  const stretches = tracks.flatMap((sentences): [number, number][] => {
    const first = sentences[0];
    const last = sentences[sentences.length - 1];
    return first && last ? [[starts[first[0]]! + first[1], starts[last[0]]! + last[1] + last[2]]] : [];
  });
  return { partner, stretches };
}

/** Where two lists of stretches (each sorted, none overlapping) both hold. */
function overlap(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const from = Math.max(a[i]![0], b[j]![0]);
    const to = Math.min(a[i]![1], b[j]![1]);
    if (to > from) out.push([from, to]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return out;
}

/**
 * Stretches of each edition's measure lined up exactly with the reference: where a forced
 * alignment lined it up with the reference itself, and where it lined it up with an edition that a
 * forced alignment lined up with the reference in turn (an audiobook lined up with the EPUB that a
 * PDF the timeline rests on lined up line by line; a PDF lined up with the EPUB that the audiobook
 * the timeline rests on refined). Lined up with any other edition, a forced alignment is only as
 * good as that edition's chapter map: not exact.
 */
function exactStretches(referenceId: string | null, timelines: ReadonlyMap<string, EditionTimeline>, aligned: ReadonlyMap<string, WordAligned>): Map<string, WordAligned['stretches']> {
  const out = new Map<string, WordAligned['stretches']>();
  for (const [id, own] of aligned) {
    if (id === referenceId) continue;
    if (own.partner === referenceId) {
      out.set(id, own.stretches);
      continue;
    }
    const via = aligned.get(own.partner);
    const ownSync = timelines.get(id)?.sync;
    const viaSync = timelines.get(own.partner)?.sync;
    if (!via || via.partner !== referenceId || !ownSync || !viaSync) continue;
    // The partner's exact stretches, in this edition's measure.
    const through = via.stretches.map(([a, b]): [number, number] => [tToM(ownSync, mToT(viaSync, a)), lastMeasureAt(ownSync, mToT(viaSync, b))]);
    out.set(id, overlap(own.stretches, through));
  }
  return out;
}

/** The t of the anchors at or before `m` and at or after it (unbounded where there is none). */
function between(anchors: readonly Anchor[], m: number): [number, number] {
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid]!.m < m - SAME_PLACE) lo = mid + 1;
    else hi = mid;
  }
  const next = anchors[lo];
  const before = next && next.m <= m + SAME_PLACE ? next : anchors[lo - 1];
  return [before ? before.lo : -Infinity, next ? next.hi : Infinity];
}

/**
 * Where a stretch read from `m` starts, as the gate places it: at a chapter start the edition was
 * matched at when it starts within `gap` after it (the player starts a chapter chosen from the track
 * list a few milliseconds in, and a listener's join gap is LISTENING_JOIN_MS), so that its start is
 * as exact as the chapter's; elsewhere where it is. Starting a chapter 7 ms in left its first minute
 * (the margin) unheard for good, and a reader's note there never opened for that listener.
 */
function fromAnchor(anchors: readonly Anchor[], m: number, gap: number): number {
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid]!.m <= m + SAME_PLACE) lo = mid + 1;
    else hi = mid;
  }
  const before = anchors[lo - 1];
  return before && m - before.m <= gap ? before.m : m;
}

/** The last place of an edition's measure its map puts at t (the end of a stretch it holds still). */
function lastMeasureAt(map: SyncMap, t: number): number {
  const { points } = map;
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t > t) hi = mid;
    else lo = mid + 1;
  }
  if (lo === 0) return points[0]!.m;
  if (lo === points.length) return points[points.length - 1]!.m;
  const a = points[lo - 1]!;
  const b = points[lo]!;
  return a.m + ((b.m - a.m) * (t - a.t)) / (b.t - a.t);
}

/** Where a comment's place (its locator, else its t) is in an edition's own measure. */
function measureOf(e: Placed, json: string | null, t: number): number {
  const locator = fromJson<Locator | null>(json, null);
  return locator && locator.kind === e.geometry.kind ? locatorToM(e.geometry, locator) : tToM(e.sync, t);
}

/**
 * Where on the timeline the printed lines of a PDF lined up with the reference start (D75), from
 * the map that alignment refined (the PDF's own, or the text's when the timeline rests on the PDF):
 * its tie points inside the stretches lined up exactly.
 */
function lineStarts(pdfId: string, timelines: ReadonlyMap<string, EditionTimeline>, aligned: ReadonlyMap<string, WordAligned>, exact: ReadonlyMap<string, WordAligned['stretches']>): number[] {
  const refined = aligned.has(pdfId) ? pdfId : [...aligned].find(([, a]) => a.partner === pdfId)?.[0];
  const stretches = refined ? exact.get(refined) : undefined;
  const sync = refined ? timelines.get(refined)?.sync : undefined;
  if (!stretches || stretches.length === 0 || !sync) return [];
  return sync.points.filter((p) => stretches.some(([a, b]) => p.m >= a - SAME_PLACE && p.m <= b + SAME_PLACE)).map((p) => p.t);
}

/** Where the next printed line starts after t, inside the lines a PDF's alignment holds (none outside them). */
function nextLine(lines: readonly number[], t: number): number | undefined {
  if (lines.length === 0 || t < lines[0]! || t >= lines[lines.length - 1]!) return undefined;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]! > t) hi = mid;
    else lo = mid + 1;
  }
  return lines[lo];
}

/** One book's spoiler gate: its editions' maps, and how far each can be from the book. */
export class Gate {
  private readonly editions = new Map<string, Placed>();
  private readonly referenceId: string | null;
  private readonly reference: Placed | undefined;
  /** How far the reference's own measure can be from another format's (60 s of an audiobook, a page of a PDF). */
  private readonly referenceSlack: number;
  private readonly chapters: readonly Chapter[];
  private readonly chapterStarts: number[];
  private readonly placedRead = new WeakMap<Reading, Span[]>();
  private readonly timelineSpans = new WeakMap<Reading, Span[]>();
  private readonly allRead = new WeakMap<Reading, Map<string, Span[]>>();

  constructor(book: BookRow, editions: readonly EditionRow[], readAlongs: readonly ReadAlongRow[]) {
    const chapters = bookChapters(book);
    this.chapters = chapters;
    this.referenceId = book.reference_edition_id;
    this.chapterStarts = [...new Set(chapters.map((c) => c.t))].sort((a, b) => a - b);
    this.referenceSlack = slackOf(editions.find((e) => e.id === book.reference_edition_id && editionTimeline(e))?.kind);
    const timelines = new Map<string, EditionTimeline>();
    const aligned = new Map<string, WordAligned>();
    for (const e of editions) {
      const timeline = editionTimeline(e);
      if (!timeline || !(totalMeasure(timeline.geometry) > 0) || timeline.sync.points.length < 2) continue;
      timelines.set(e.id, timeline);
      const words = wordAligned(e, timeline.geometry, readAlongs);
      if (words) aligned.set(e.id, words);
    }
    const exact = exactStretches(book.reference_edition_id, timelines, aligned);
    for (const e of editions) {
      const timeline = timelines.get(e.id);
      if (!timeline) continue;
      const reference = e.id === book.reference_edition_id;
      const own = slackOf(e.kind);
      this.editions.set(e.id, {
        geometry: timeline.geometry,
        sync: timeline.sync,
        total: totalMeasure(timeline.geometry),
        reference,
        slack: own === 0 && this.referenceSlack === 0 ? TEXT_MARGIN_CHARS : own,
        exact: exact.get(e.id) ?? [],
        anchors: reference ? [] : anchorsOf(e, timeline.sync, chapters),
        straight: timeline.sync.points.length === 2,
        lines: e.kind === 'pdf' ? lineStarts(e.id, timelines, aligned, exact) : [],
      });
    }
    this.reference = book.reference_edition_id ? this.editions.get(book.reference_edition_id) : undefined;
  }

  /** Whether a member may read a comment's words. */
  isOpen(comment: Gated, viewerId: string, reading: Reading): boolean {
    return this.access(comment, viewerId, reading) === 'open';
  }

  /**
   * What a member has read of this book, on the shared timeline, as every other gate decision
   * weighs it. Exposed for Cal (apps/server/src/cal/gating.ts, D162): his book search filters
   * indexed chunks to this same union of spans, so a chunk is never surfaced to him for a user
   * who could not have read its words through the ordinary reader either.
   */
  readSpans(reading: Reading): Span[] {
    return this.timelineRead(reading);
  }

  /**
   * Whether a member may read a comment's words, and if not, why not. Your own words, always. Every
   * other comment opens by your reading: its place, and where its writer had read to (D69). The
   * answers to your note too: the app records your reading before you post, and a note placed
   * ahead of it (through the API) must not collect friends' answers about a part you have not read.
   */
  access(comment: Gated, viewerId: string, reading: Reading): Access {
    if (comment.user_id === viewerId) return 'open';
    if (!this.placeRead(comment, reading)) return 'ahead';
    const horizon = horizonPlace(comment);
    return horizon && !this.placeRead(horizon, reading) ? 'held' : 'open';
  }

  view(comment: CommentWithAuthor, viewerId: string, reading: Reading, media: readonly CommentMediaRow[] = []): CommentView {
    const access = this.access(comment, viewerId, reading);
    // Its writer is told where friends must have read to before its words reach them; a friend
    // held by it, where its writer was.
    const told = access === 'held' || (access === 'open' && comment.user_id === viewerId);
    // A note at a place you have not read comes to you only roughly placed (D80): its exact place
    // is its passage, there to be looked up in the book you can download.
    const rough = access === 'ahead' && !rangesContain(this.timelineRead(reading), comment.t) ? this.roughPlace(comment) : null;
    return toCommentView(comment, access === 'open', told ? this.horizonLabel(comment) : null, rough, media);
  }

  /** What a member has read, on the shared timeline, as the app shows them (cached per reading). */
  private timelineRead(reading: Reading): Span[] {
    let spans = this.timelineSpans.get(reading);
    if (!spans) {
      const all: Span[] = [...reading.unplaced];
      for (const [id, ranges] of reading.byEdition) {
        const e = this.editions.get(id);
        if (e) for (const [a, b] of ranges) all.push([mToT(e.sync, a), mToT(e.sync, b)]);
      }
      spans = normalizeRanges(all);
      this.timelineSpans.set(reading, spans);
    }
    return spans;
  }

  /**
   * Where a note ahead of you is, as you are told it: its place on the timeline to the nearest
   * ROUGH_STEP (half a per cent of the book: on the club bar, a pixel or two), never outside its
   * chapter, and the place in its edition that is.
   */
  private roughPlace(comment: Gated): { t: number; locator: Locator } {
    const [start, end] = this.chapterAround(comment.t);
    const rounded = Math.round(comment.t / ROUGH_STEP) * ROUGH_STEP;
    const t = Math.min(Math.max(rounded, start), Math.max(start, end - 1e-6));
    const e = this.editions.get(comment.edition_id);
    const own = fromJson<Locator>(comment.locator_json, { kind: 'epub', section: 0, offset: 0 });
    const locator = e ? mToLocator(e.geometry, tToM(e.sync, t)) : own.kind === 'epub' ? { kind: 'epub' as const, section: 0, offset: 0 } : own.kind === 'pdf' ? { kind: 'pdf' as const, page: 0, y: 0 } : { kind: 'audio' as const, track: 0, ms: 0 };
    return { t, locator };
  }

  /**
   * Where a comment's writer had read to, named as the club bar names places: the chapter of the
   * last place they had read ("Chapter 9": read to its very end is read to Chapter 9, not 10),
   * placed from its locator through its edition's map as it is now. The horizon kept is that place
   * less the page they had on screen (HORIZON_PAGE): the page is added back to name it, for a page
   * back from a chapter's first page is the chapter before, where the writer was not (fidelity
   * review round 16: "read to Chapter 2", written in Chapter 3).
   */
  horizonLabel(comment: Gated): string | null {
    const horizon = horizonPlace(comment);
    if (!horizon) return null;
    const e = this.editions.get(horizon.edition_id);
    const t = e ? mToT(e.sync, Math.min(measureOf(e, horizon.locator_json, horizon.t) + HORIZON_PAGE[e.geometry.kind], tToM(e.sync, 1))) : horizon.t;
    return chapterNameAt(this.chapters, Math.max(0, t - READ_TO_STEP)) ?? formatPercent(t);
  }

  /**
   * Where a writer had read to (D69), for a comment of theirs at `place`, as it is kept with it: the
   * furthest they have read, in the edition they read furthest in (in its own measure, so it is
   * judged exactly as a note made there), less the page they had on screen (HORIZON_PAGE). Reading
   * kept only on the timeline (from before ranges were kept per edition) reaching further is
   * placed in `editionId`, the edition they read now. Null when that is not past the place.
   */
  horizon(reading: Reading, furthest: number, editionId: string | null, place: Gated): Horizon | null {
    let best: { id: string; e: Placed; m: number; t: number } | null = null;
    for (const [id, ranges] of reading.byEdition) {
      const e = this.editions.get(id);
      if (!e || ranges.length === 0) continue;
      // What lies past the story's end (a licence) is no story.
      const m = Math.min(
        ranges.reduce((most, [, b]) => Math.max(most, b), 0),
        tToM(e.sync, 1),
      );
      const t = mToT(e.sync, m);
      if (!best || t > best.t) best = { id, e, m, t };
    }
    const now = editionId ? this.editions.get(editionId) : undefined;
    if (editionId && now && furthest > (best?.t ?? 0) + RANGE_EPSILON) best = { id: editionId, e: now, m: tToM(now.sync, furthest), t: furthest };
    if (!best) return null;
    const locator = mToLocator(best.e.geometry, Math.max(0, best.m - HORIZON_PAGE[best.e.geometry.kind]));
    const m = locatorToM(best.e.geometry, locator);
    const t = mToT(best.e.sync, m);
    const end = place.end_t !== null && place.end_t > place.t ? place.end_t : null;
    const beyond =
      best.id === place.edition_id
        ? m > Math.max(measureOf(best.e, place.locator_json, place.t), end === null ? 0 : measureOf(best.e, place.end_locator_json, end)) + SAME_PLACE
        : t > (end ?? place.t) + RANGE_EPSILON;
    return beyond ? { editionId: best.id, locator, t } : null;
  }

  /** Whether a member's reading opens a place (a comment's, or where its writer had read to). */
  private placeRead(comment: Gated, reading: Reading): boolean {
    const end = comment.end_t !== null && comment.end_t > comment.t ? comment.end_t : null;
    const home = this.editions.get(comment.edition_id);
    // Read in the edition it was made in: exactly there.
    const own = home ? reading.byEdition.get(comment.edition_id) : undefined;
    if (home && own && own.length > 0) {
      const from = measureOf(home, comment.locator_json, comment.t);
      if (readThere(own, home.total, from, end === null ? from : measureOf(home, comment.end_locator_json, end))) return true;
    }
    // Read in any format: all of where it may really be.
    const [lo, hi] = this.whereNote(comment, home, end);
    return rangesCover(this.certainlyRead(reading, comment.edition_id), lo, hi);
  }

  /**
   * Where on the timeline the words at `m` of an edition can really be. Where its map puts them,
   * for the reference and where a trusted forced alignment placed them (`trustForced`; the end of
   * a range read, `closing`, is still in a stretch that ends there); elsewhere within its margin
   * of that, in its own measure and then in the reference's, but never past a chapter start its
   * units were matched to, where its map is right whatever it does inside.
   */
  private spread(e: Placed, m: number, trustForced: boolean, closing = false): [number, number] {
    const t = mToT(e.sync, m);
    const inside = ([a, b]: readonly [number, number]) => (closing ? m > a && m <= b + SAME_PLACE : m >= a - SAME_PLACE && m < b);
    if (e.reference || (trustForced && e.exact.some(inside))) return [t, t];
    let lo = mToT(e.sync, m - e.slack);
    let hi = mToT(e.sync, m + e.slack);
    const ref = this.reference;
    if (ref && this.referenceSlack > 0) {
      lo = mToT(ref.sync, tToM(ref.sync, lo) - this.referenceSlack);
      hi = mToT(ref.sync, tToM(ref.sync, hi) + this.referenceSlack);
    }
    const [floor, ceiling] = between(e.anchors, m);
    // The stretch the map interpolates here: the chapter, or all between the anchors around it
    // when those are further apart (a chapter its units skipped), a tenth of it; a straight line's
    // whole book, LINE_SHARE of it.
    const [start, end] = this.chapterAround(t);
    const anchored = Number.isFinite(ceiling - floor) ? ceiling - floor : 0;
    const margin = Math.max(CHAPTER_SHARE * (end - start), (e.straight ? LINE_SHARE : CHAPTER_SHARE) * anchored);
    lo = Math.min(lo, t - margin);
    hi = Math.max(hi, t + margin);
    return [Math.min(t, Math.max(lo, floor)), Math.max(t, Math.min(hi, ceiling))];
  }

  /** The t where the chapter holding t starts, and where the next one does (or the book ends). */
  private chapterAround(t: number): [number, number] {
    let start = 0;
    let end = 1;
    for (const s of this.chapterStarts) {
      if (s <= t) start = s;
      else if (s < end) end = s;
    }
    return [start, end];
  }

  /**
   * Where on the timeline a note's words (all of a passage's) may really be. A place on a printed
   * page lined up with the text is the line it is on (its locator says only how far down the page):
   * all of that line, up to where the next one starts (D75).
   */
  private whereNote(comment: Gated, home: Placed | undefined, end: number | null): [number, number] {
    const last = end ?? comment.t;
    if (!home) {
      // Its edition is gone. The reference's notes are where they were; another's were placed by a
      // chapter map no longer here, so they are somewhere in their chapters.
      return comment.edition_id === this.referenceId ? [comment.t, last] : [this.chapterStart(comment.t), this.chapterEnd(last)];
    }
    const from = measureOf(home, comment.locator_json, comment.t);
    const to = end === null ? from : Math.max(from, measureOf(home, comment.end_locator_json, end));
    const hi = Math.max(last, this.spread(home, to, true, end !== null)[1]);
    return [Math.min(comment.t, this.spread(home, from, true)[0]), Math.max(hi, nextLine(home.lines, mToT(home.sync, to)) ?? hi)];
  }

  /**
   * What a member has certainly read, on the timeline, when judging a note made in `editionId`:
   * each range read in an edition, less the margin at either end where its map may be off, and
   * what was read before ranges were kept per edition (cached per reading).
   */
  private certainlyRead(reading: Reading, editionId: string): Span[] {
    let placed = this.placedRead.get(reading);
    if (!placed) {
      const spans: Span[] = [];
      for (const [id, ranges] of reading.byEdition) {
        // An edition that is gone: what was read in it cannot be placed any more.
        const e = this.editions.get(id);
        if (!e) continue;
        // Kept before pieces this close were joined as they were saved: joined here too.
        const gap = joinGap(e.geometry, e.total);
        for (const [a, b] of addReadSpans(ranges, [], e.total, gap)) {
          const from = this.spread(e, fromAnchor(e.anchors, a, gap), true)[1];
          const to = this.spread(e, b, true, true)[0];
          if (to > from) spans.push([from, to]);
        }
      }
      placed = normalizeRanges(spans);
      this.placedRead.set(reading, placed);
    }
    if (reading.unplaced.length === 0) return placed;
    let byNote = this.allRead.get(reading);
    if (!byNote) this.allRead.set(reading, (byNote = new Map<string, Span[]>()));
    let all = byNote.get(editionId);
    if (!all) {
      all = normalizeRanges([...placed, ...this.unplaced(reading.unplaced, editionId)]);
      byNote.set(editionId, all);
    }
    return all;
  }

  /**
   * Reading from before ranges were kept per edition counts as if done in whichever other format
   * of the book is furthest from the note's own, through its chapter map; and in the note's own
   * edition too once a forced alignment has refined it, since that reading may have come through
   * the chapter map the alignment replaced (a transcript added later moves its notes, not it).
   */
  private unplaced(ranges: readonly Span[], editionId: string): Span[] {
    // The reference places what was read in it exactly: it narrows nothing.
    const others = [...this.editions].flatMap(([id, e]) => (e.reference || (id === editionId && e.exact.length === 0) ? [] : [e]));
    const out: Span[] = [];
    for (const [a, b] of ranges) {
      let from = a;
      let to = b;
      for (const e of others) {
        from = Math.max(from, this.spread(e, lastMeasureAt(e.sync, a), false)[1]);
        to = Math.min(to, this.spread(e, tToM(e.sync, b), false, true)[0]);
      }
      if (to > from) out.push([from, to]);
    }
    return out;
  }

  /** Where the chapter holding t starts on the timeline, and where the one holding t ends. */
  private chapterStart(t: number): number {
    let start = 0;
    for (const s of this.chapterStarts) if (s <= t) start = s;
    return start;
  }

  private chapterEnd(t: number): number {
    return this.chapterStarts.find((s) => s > t) ?? 1;
  }
}

/** The gate of a book, as it is now. */
export function gateFor(db: Db, book: BookRow): Gate {
  return new Gate(book, editionsForBook(db, book.id), readAlongsForBook(db, book.id));
}

/** Where a member had read to (D69), for a comment they are writing at `place` now. */
export function writerHorizon(db: Db, gate: Gate, book: BookRow, userId: string, place: Gated): Horizon | null {
  const row = progressFor(db, userId, book.id);
  return row ? gate.horizon(readingOf(db, userId, book.id, row), row.furthest, row.edition_id, place) : null;
}

/**
 * A media note's full view (D140): the derived, web-safe rendition's address, a video's poster
 * frame, its duration and dimensions, and its transcript once the recogniser has made one (D79).
 * `/media/notes/:id/...` checks the same gate on every request (routes/media.ts): this address
 * is useless to anyone it is not already open to.
 */
function noteMediaView(m: CommentMediaRow): NonNullable<RevealedComment['media']>[number] {
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    mime: m.mime,
    url: m.status === 'ready' ? `/media/notes/${m.id}/file` : null,
    posterUrl: m.poster_blob_id ? `/media/notes/${m.id}/poster` : null,
    durationMs: m.duration_ms,
    width: m.width,
    height: m.height,
    transcript: m.transcript,
    transcriptStatus: m.transcript_status,
  };
}

/**
 * A comment as a viewer gets it: in full when it is open to them, else a marker; one held only by
 * where its writer had read to says where that was (`horizon`, D69). Its media (D140) follows the
 * same rule as its words: the derived file, duration and dimensions in full when open, else only
 * its kind (never bytes, duration or a thumbnail that could leak pacing or content).
 */
export function toCommentView(
  comment: CommentWithAuthor,
  open: boolean,
  horizon: string | null = null,
  rough: { t: number; locator: Locator } | null = null,
  media: readonly CommentMediaRow[] = [],
): CommentView {
  const base = {
    id: comment.id,
    bookId: comment.book_id,
    userId: comment.user_id,
    authorName: comment.author_name,
    color: comment.author_slot === null ? memberColor(comment.user_id) : slotColor(comment.author_slot),
    t: comment.t,
    editionId: comment.edition_id,
    kind: comment.kind,
    locator: fromJson<Locator>(comment.locator_json, { kind: 'epub', section: 0, offset: 0 }),
    reaction: comment.deleted_at === null ? comment.reaction : null,
    createdAt: isoRequired(comment.created_at),
    parentId: comment.parent_id,
    ...(comment.deleted_at !== null ? { deleted: true } : {}),
  };
  const gone = comment.deleted_at !== null;
  if (open) {
    return {
      ...base,
      hidden: false,
      endLocator: comment.end_locator_json && !gone ? fromJson<Locator>(comment.end_locator_json, base.locator) : null,
      endT: gone ? null : comment.end_t,
      quote: gone ? null : comment.quote,
      text: gone ? null : comment.text,
      media: gone ? [] : media.map(noteMediaView),
      ...(horizon && !gone ? { horizon } : {}),
    };
  }
  const placed = rough ? { t: rough.t, locator: rough.locator, approx: true as const } : {};
  return {
    ...base,
    ...placed,
    hidden: true,
    hasText: !gone && comment.text !== null && comment.text.length > 0,
    media: gone ? [] : media.map((m) => ({ kind: m.kind })),
    ...(horizon ? { horizon } : {}),
  };
}
