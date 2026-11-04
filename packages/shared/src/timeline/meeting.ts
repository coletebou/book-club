import { formatPercent } from '../format';
import { type ChapterLike, chapterNames, frontMatterOf } from './chapters';
import { type SyncMap, tToM } from './syncmap';

/**
 * Where the club will talk next (D53): a stop in the book, usually the end of a chapter, and
 * perhaps a day. Positions are on the shared timeline, so a reader and a listener see the same
 * stop and how far they each have to go.
 */

const EPS = 1e-6;

/** Where chapter i ends on the timeline: where the next one starts, or the end of the book. */
export function chapterEnd(chapters: readonly ChapterLike[], i: number): number {
  const start = chapters[i]!.t;
  let end = 1;
  for (const c of chapters) if (c.t > start + EPS && c.t < end) end = c.t;
  return end;
}

export interface MeetingStop {
  readonly t: number;
  readonly label: string;
}

/**
 * The chapters worth stopping at, or counting, with their ends, in reading order: not the front
 * matter a book's contents also list (a title page, an edition note, the contents themselves,
 * frontMatterOf), nor anything else under a seventh of a typical chapter's length.
 */
function storyChapters(chapters: readonly ChapterLike[]): { title: string; name: string; start: number; end: number }[] {
  const front = frontMatterOf(chapters);
  const story = front > 0 ? chapters[front]!.t : -Infinity;
  const names = chapterNames(chapters);
  // Sorted once, each chapter ends where the next later start is: n log n, however long the contents.
  const sorted = chapters
    .map((c, i) => ({ title: c.title, name: names[i]!, start: c.t }))
    .filter((c) => c.start >= story - EPS)
    .sort((a, b) => a.start - b.start);
  const spans: { title: string; name: string; start: number; end: number }[] = [];
  let next = 1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const c = sorted[i]!;
    if (next > c.start + EPS) spans.push({ ...c, end: next });
    if (i === 0 || sorted[i - 1]!.start < c.start - EPS) next = c.start;
  }
  spans.reverse();
  if (spans.length === 0) return [];
  const lengths = spans.map((s) => s.end - s.start).sort((a, b) => a - b);
  const typical = lengths[Math.floor(lengths.length / 2)]!;
  return spans.filter((s) => s.end - s.start >= typical / 7);
}

/** The stops a club can choose: the end of each chapter in reading order, the end of the book last. */
export function meetingStops(chapters: readonly ChapterLike[]): MeetingStop[] {
  const stops = new Map<number, MeetingStop>();
  for (const c of storyChapters(chapters)) {
    const key = Math.round(c.end * 1e6);
    if (!stops.has(key)) stops.set(key, { t: c.end, label: c.end >= 1 - EPS ? 'the end of the book' : `the end of ${c.name}` });
  }
  if (stops.size === 0) for (const q of [0.25, 0.5, 0.75]) stops.set(q * 1e6, { t: q, label: formatPercent(q) });
  stops.set(1e6, { t: 1, label: 'the end of the book' });
  return [...stops.values()].sort((a, b) => a.t - b.t);
}

/** A stop's name: "the end of Chapter 6", "the end of the book", or a percentage. */
export function stopLabel(chapters: readonly ChapterLike[], t: number): string {
  if (t >= 1 - EPS) return 'the end of the book';
  return meetingStops(chapters).find((s) => Math.abs(s.t - t) < EPS)?.label ?? formatPercent(t);
}

/** Whether a member has read (or heard) as far as a stop. */
export function hasReached(progress: { readonly furthest: number; readonly finished: boolean }, t: number): boolean {
  return progress.finished || progress.furthest >= t - EPS;
}

/** How many chapters are left between two places; the rest of the one you are in counts as one. */
export function chaptersToGo(chapters: readonly ChapterLike[], from: number, to: number): number {
  if (to <= from + EPS) return 0;
  return storyChapters(chapters).filter((c) => c.end > from + EPS && c.start < to - EPS).length;
}

/** Silent reading speed for estimates: about 240 words a minute, 5.6 characters a word with its space. */
export const READING_CHARS_PER_MINUTE = 1350;
/** A PDF page, read: about two minutes. */
export const PDF_PAGE_MINUTES = 2;

interface TimedEdition {
  readonly kind: 'epub' | 'pdf' | 'audio';
  readonly status: 'processing' | 'ready' | 'failed';
  readonly sync: SyncMap | null;
}

/**
 * About how long it takes from one place to another: reading the EPUB (or else the PDF), and
 * listening to the audiobook, each null when the book has no such format.
 */
export function timeToGo(editions: readonly TimedEdition[], from: number, to: number): { readingMs: number | null; listeningMs: number | null } {
  const ready = (kind: TimedEdition['kind']) => editions.find((e) => e.kind === kind && e.status === 'ready' && e.sync);
  const span = (e: TimedEdition) => Math.max(0, tToM(e.sync!, to) - tToM(e.sync!, from));
  const epub = ready('epub');
  const pdf = ready('pdf');
  const audio = ready('audio');
  const readingMs = epub ? (span(epub) / READING_CHARS_PER_MINUTE) * 60_000 : pdf ? span(pdf) * PDF_PAGE_MINUTES * 60_000 : null;
  return { readingMs, listeningMs: audio ? span(audio) : null };
}

/** "under a minute", "25 min", "1 h 10 min" (to five minutes above an hour). */
export function formatRoughDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const rounded = Math.round(minutes / 5) * 5;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Whether a value is a calendar day written "2026-10-25". */
export function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * A calendar day the way friends say it, from today: "today", "tomorrow", "yesterday", "Sunday"
 * within the week, else "Sunday 2 November" (with the year when it is another year).
 */
export function formatDay(day: string, now = new Date()): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  // Spelled out here rather than by the browser's locale data, which differs between engines.
  const weekday = WEEKDAYS[date.getDay()]!;
  if (days > 1 && days < 7) return weekday;
  const year = date.getFullYear() === today.getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${weekday} ${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
