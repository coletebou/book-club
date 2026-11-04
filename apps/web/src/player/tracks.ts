import { type Chapter, type Edition, numberedAs, tidyTrackTitle } from '@bookclub/shared';

/** An entry of the player's list: a track, or a chapter inside one, each where it starts. */
export interface ListEntry {
  readonly title: string;
  readonly track: number;
  readonly ms: number;
  readonly durationMs: number;
  /** 1 for a chapter heard inside a track that holds several (FR152), under its track; else absent. */
  readonly depth?: 1;
}

/**
 * How long a track may open (its announcement, LibriVox's preamble) before the first chapter heard
 * in it starts and still be that chapter's: a minute, as a place at a track's start is (D93).
 */
const TRACK_OPENING_MS = 60_000;

/**
 * The book's chapters a track holds, each where it starts in it (FR152, FR161, D115): the chapter
 * it opens with, then each its read-along hears starting in it. It opens with the first of those
 * (its announcement is that chapter's, D112) unless it is known to open with another: the chapter
 * its read-along hears first, going on from the track before (the server's `chapter`, else its
 * chapter match), or with no such word, where the first starts well into it, the chapter before.
 * None for a file with chapters of its own (an M4B) in which fewer than two were heard: its units
 * say.
 */
export function chaptersHeld(edition: Edition, track: number): readonly { readonly chapter: number; readonly ms: number }[] {
  const tr = edition.tracks[track];
  if (!tr) return [];
  const heard = tr.chapters ?? [];
  const marked = edition.units.length > edition.tracks.length;
  if (marked && heard.length < 2) return [];
  const opens = marked ? null : tr.chapter;
  const first = heard[0];
  if (!first) return opens == null ? [] : [{ chapter: opens, ms: 0 }];
  const before = opens ?? (first.ms > TRACK_OPENING_MS && first.chapter > 0 ? first.chapter - 1 : null);
  return before == null || before === first.chapter ? heard : [{ chapter: before, ms: 0 }, ...heard];
}

/** The chapters heard starting inside a track that holds several (FR152): its entries in the list; else none. */
export function chaptersInTrack(edition: Edition, track: number): readonly { readonly chapter: number; readonly ms: number }[] {
  return chaptersHeld(edition, track).length > 1 ? (edition.tracks[track]?.chapters ?? []) : [];
}

/**
 * Whether a track says it holds several chapters ("Chapters 04 to 06") with none heard inside it
 * (no read-along yet): which of them plays when is not known, so it goes by its own name (FR152).
 */
export function severalUnheard(edition: Edition, track: number): boolean {
  const tr = edition.tracks[track];
  const numbered = tr ? numberedAs(tr.title) : null;
  return numbered?.counts === 'chapter' && numbered.through > numbered.n && chaptersInTrack(edition, track).length === 0;
}

/**
 * A track's own name as the player shows it, where no chapter of the book names it: its tag,
 * without a track number in front of the chapter number it says ("06 - Chapter 6" → "Chapter 6").
 */
export function trackName(edition: Edition, track: number): string | null {
  const title = edition.tracks[track]?.title;
  return title ? tidyTrackTitle(title) : null;
}

/**
 * The book's chapter a track is named by in the list (FR161): the one chapter it holds, by its
 * read-along or its chapter match; none for a track of several, or one that says it holds several
 * ("Chapters 04 to 06"), which keep their own names (D112).
 */
export function chapterOfTrack(edition: Edition, track: number): number | null {
  const held = chaptersHeld(edition, track);
  const numbered = numberedAs(edition.tracks[track]?.title ?? '');
  const range = numbered?.counts === 'chapter' && numbered.through > numbered.n;
  return held.length === 1 && !range ? held[0]!.chapter : null;
}

/** What a track is called (the list's name for it, FR161): the chapter it holds, else its own name. */
export function trackLabel(edition: Edition, chapters: readonly Chapter[], track: number): string | null {
  const one = chapterOfTrack(edition, track);
  return (one != null ? chapters[one]?.title : undefined) ?? trackName(edition, track);
}

/**
 * What the player's list shows: the tracks (named after the book's chapter each holds, FR161),
 * each followed, where it holds several ("Chapter 01 to 03"), by the chapters its read-along
 * hears starting in it, each at its place in the track (FR152); or, for files with chapters inside
 * (a single-file M4B), those chapters, each with its track and start.
 */
export function listEntries(edition: Edition, chapters: readonly Chapter[]): ListEntry[] {
  if (edition.units.length <= edition.tracks.length) {
    return edition.tracks.flatMap((tr) => {
      const inside = chaptersInTrack(edition, tr.index);
      // A track of several chapters keeps its own name over theirs, heard inside it or not.
      const own: ListEntry = { title: trackLabel(edition, chapters, tr.index) ?? tidyTrackTitle(tr.title), track: tr.index, ms: 0, durationMs: tr.durationMs };
      return [
        own,
        ...inside.map((c, i): ListEntry => ({
          title: chapters[c.chapter]?.title ?? `Chapter ${c.chapter + 1}`,
          track: tr.index,
          ms: c.ms,
          durationMs: Math.max(0, (inside[i + 1]?.ms ?? tr.durationMs) - c.ms),
          depth: 1,
        })),
      ];
    });
  }
  const starts: number[] = [];
  let at = 0;
  for (const tr of edition.tracks) {
    starts.push(at);
    at += tr.durationMs;
  }
  return edition.units.map((u, i) => {
    let track = 0;
    while (track + 1 < starts.length && starts[track + 1]! <= u.m) track++;
    const end = Math.min(edition.units[i + 1]?.m ?? at, starts[track]! + edition.tracks[track]!.durationMs);
    return { title: u.title, track, ms: u.m - starts[track]!, durationMs: Math.max(0, end - u.m) };
  });
}

/** The unit at a place `m` ms into the whole audiobook: the last one starting there or before (-1 before the first). */
export function unitIndexAtM(units: readonly { readonly m: number }[], m: number): number {
  let lo = 0;
  let hi = units.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (units[mid]!.m <= m + 0.5) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The chapter the player names as heard (its title, the lock screen's): chapterAt's, but none in a
 * track that says it holds several chapters none of which was heard (severalUnheard), which goes by
 * its own name.
 */
export function chapterNamedAt(edition: Edition, track: number, ms: number): number | null {
  return severalUnheard(edition, track) ? null : chapterAt(edition, track, ms);
}

/**
 * The book's chapter being heard at a place in a track: of the chapters it holds (chaptersHeld),
 * the last one starting there or before, its opening its first chapter's (FR152, FR161); else, in
 * a file with chapters of its own, the chapter of the unit playing there. Null outside the story,
 * or where nothing matched.
 */
export function chapterAt(edition: Edition, track: number, ms: number): number | null {
  const held = chaptersHeld(edition, track);
  if (held.length > 0) return (held.findLast((c) => c.ms <= ms + 0.5) ?? held[0]!).chapter;
  let start = 0;
  for (let i = 0; i < track && i < edition.tracks.length; i++) start += edition.tracks[i]!.durationMs;
  const u = unitIndexAtM(edition.units, start + ms);
  return u >= 0 ? (edition.alignment.unitToChapter[u] ?? null) : null;
}
