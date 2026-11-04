import { type Edition, type HistoryBook, type HistoryEntry, chapterIndexAt, chapterNames, frontMatterOf, locatorToM } from '@bookclub/shared';
import { timelineOf } from '../reader/position';

/**
 * Your own reading and listening history, as lines (D191): pure, so every rule of its wording,
 * its days and its totals is unit-tested.
 */

/** A book as history names it: its chapters and editions, when known (BookDetail has both). */
export interface HistoryBookDetail extends HistoryBook {
  readonly chapters?: readonly { readonly title: string; readonly t: number }[];
  readonly editions?: readonly Edition[];
}

/** "1 hr 5 min", "48 min", "under a minute": how long, as a person says it. */
export function spentLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** "2:14:00", "14:05": a place in an audiobook, across its tracks, as a clock. */
export function clockLabel(ms: number, long: boolean): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return long ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** The chapters a stretch went through, as short as they say it: "ch. 7–8", "ch. 3", "Stave One – Stave Two"; null before the story. */
export function chaptersLabel(chapters: readonly { readonly title: string; readonly t: number }[] | undefined, fromT: number, toT: number): string | null {
  if (!chapters || chapters.length === 0) return null;
  const names = chapterNames(chapters);
  const front = frontMatterOf(chapters);
  const a = chapterIndexAt(chapters, fromT);
  // The end of a stretch is the start of the next page: the chapter it ends in is the one just before it.
  const b = Math.max(a, chapterIndexAt(chapters, Math.max(fromT, toT - 1e-9)));
  if (b < front) return null;
  const first = names[Math.max(a, front)]!;
  const last = names[b]!;
  const n = (name: string) => /^Chapter (\d+)$/.exec(name)?.[1];
  if (first === last) return n(first) ? `ch. ${n(first)}` : first;
  if (n(first) && n(last)) return `ch. ${n(first)}–${n(last)}`;
  return `${first} – ${last}`;
}

/** The whole audiobook's length (ms), to say its places in hours where it runs past one. */
function audioLength(edition: Edition | undefined): number {
  return edition?.tracks.reduce((n, t) => n + t.durationMs, 0) ?? 0;
}

/**
 * What a line says it was: "Read pages 100–146", "Read page 12", "Read ch. 3–4", "Listened
 * 2:14:00–3:02:10 (ch. 7–8)". Pages as the device showed them (an EPUB's, D9) or the PDF's own;
 * where a device did not say, the chapters and how far through the book.
 */
export function entryTitle(entry: HistoryEntry, book: HistoryBookDetail | undefined): string {
  const chapters = chaptersLabel(book?.chapters, entry.fromT, entry.toT);
  const percent = `${Math.floor(entry.fromT * 100)}–${Math.max(Math.floor(entry.fromT * 100), Math.floor(entry.toT * 100))}%`;
  if (entry.kind === 'audio') {
    const edition = book?.editions?.find((e) => e.id === entry.editionId);
    const tl = edition ? timelineOf(edition) : null;
    if (!tl) return chapters ? `Listened (${chapters})` : 'Listened';
    const from = locatorToM(tl.geometry, entry.from);
    const to = locatorToM(tl.geometry, entry.to);
    const long = audioLength(edition) >= 3600_000;
    return `Listened ${clockLabel(from, long)}–${clockLabel(to, long)}${chapters ? ` (${chapters})` : ''}`;
  }
  const pages = entry.kind === 'pdf' && entry.from.kind === 'pdf' && entry.to.kind === 'pdf'
    ? { from: entry.from.page + 1, to: entry.to.page + 1 }
    : entry.pages;
  if (pages) {
    const to = Math.max(pages.from, pages.to);
    return to === pages.from ? `Read page ${pages.from}` : `Read pages ${pages.from}–${to}`;
  }
  return chapters ? `Read ${chapters} · ${percent}` : `Read ${percent}`;
}

/** The line under it: the time it began, how long, on what ("1:30 PM · 1 hr · iPhone"). */
export function entryMeta(entry: HistoryEntry, locale?: string): string {
  const time = new Date(entry.startedAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `${time} · ${spentLabel(entry.activeMs)} · ${entry.device}`;
}

/** A local calendar day's key, "2026-09-12". */
export function dayKey(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Today", "Yesterday", "Fri, Sep 12", or with the year once it is another year's. */
export function dayLabel(time: number, now: number, locale?: string): string {
  const key = dayKey(time);
  if (key === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return 'Yesterday';
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Date(time).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export interface Totals {
  readonly readMs: number;
  readonly listenedMs: number;
}

export function totalsOf(entries: readonly HistoryEntry[]): Totals {
  let readMs = 0;
  let listenedMs = 0;
  for (const e of entries) {
    if (e.kind === 'audio') listenedMs += e.activeMs;
    else readMs += e.activeMs;
  }
  return { readMs, listenedMs };
}

/** "1 hr 20 min read · 48 min listened", leaving out what is nothing. */
export function totalsLabel(totals: Totals): string {
  const parts: string[] = [];
  if (totals.readMs > 0) parts.push(`${spentLabel(totals.readMs)} read`);
  if (totals.listenedMs > 0) parts.push(`${spentLabel(totals.listenedMs)} listened`);
  return parts.join(' · ');
}

export interface HistoryDay {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly HistoryEntry[];
  readonly totals: Totals;
}

/** Entries by the day each began, newest day first, each day's entries newest first, with its totals. */
export function groupByDay(entries: readonly HistoryEntry[], now: number, locale?: string): HistoryDay[] {
  const days = new Map<string, HistoryEntry[]>();
  for (const e of [...entries].sort((a, b) => b.startedAt - a.startedAt)) {
    const key = dayKey(e.startedAt);
    days.set(key, [...(days.get(key) ?? []), e]);
  }
  return [...days].map(([key, list]) => ({ key, label: dayLabel(list[0]!.startedAt, now, locale), entries: list, totals: totalsOf(list) }));
}

/**
 * Where a line takes you: to where that stretch began, in its own format and edition (a look, D58:
 * your place stays where it is until you read or listen on there), or, `other`, the same place in
 * the book's other format.
 */
export function entryHref(entry: HistoryEntry, mode: 'same' | 'other', book: HistoryBookDetail | undefined): string | null {
  const listened = entry.kind === 'audio';
  const wantAudio = mode === 'same' ? listened : !listened;
  const editions = book?.editions?.filter((e) => e.status === 'ready');
  if (mode === 'other' && editions && !editions.some((e) => (e.kind === 'audio') === wantAudio)) return null;
  const at = encodeURIComponent(String(entry.fromT));
  const edition = mode === 'same' ? `edition=${encodeURIComponent(entry.editionId)}&` : '';
  return `/books/${entry.bookId}/${wantAudio ? 'listen' : 'read'}?${edition}at=${at}`;
}
