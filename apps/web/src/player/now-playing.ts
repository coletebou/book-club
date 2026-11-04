import { type BookDetail, type Edition } from '@bookclub/shared';
import { listEntries, trackName } from './tracks';

/**
 * What the lock screen, Control Center, a watch or a car shows of the audiobook playing, and where
 * its chapter buttons go (D190). Pure, so every rule here is unit-tested without a browser.
 */

/**
 * The square sizes of the cover the system may pick from (the server draws each, D190): a lock
 * screen's tile is square, and a 2:3 cover offered there is cut or boxed by the system instead.
 */
export const ARTWORK_SIZES = [96, 192, 256, 384, 512] as const;

/** The cover as square artwork in every size, each URL absolute (the system fetches it, not the page). */
export function nowPlayingArtwork(coverUrl: string, base: string): MediaImage[] {
  return ARTWORK_SIZES.map((size) => {
    const url = new URL(coverUrl, base);
    url.searchParams.set('shape', 'square');
    url.searchParams.set('w', String(size));
    return { src: url.href, sizes: `${size}x${size}`, type: 'image/webp' };
  });
}

/**
 * The lock screen's lines: the chapter playing as the title (a file may hold several, FR152), the
 * author as the artist, the book as the album (`chapter`: chapterNamedAt's, for the place playing); a track of several chapters none of which was heard
 * yet goes by its own name, and a track with no name at all by the book's.
 */
export function nowPlayingMetadata(book: BookDetail, edition: Edition, track: number, chapter: number | null, base: string): MediaMetadataInit {
  const title = (chapter != null ? book.chapters[chapter]?.title : undefined) ?? trackName(edition, track) ?? book.title;
  return { title, artist: book.author, album: book.title, artwork: nowPlayingArtwork(book.coverUrl, base) };
}

/** A place to go to: a track and where in it. */
export interface Stop {
  readonly track: number;
  readonly ms: number;
}

/** How far into a chapter "previous" means "this chapter's start" rather than the one before (as Apple's Books). */
export const RESTART_CHAPTER_MS = 3000;

const before = (a: Stop, b: Stop) => a.track < b.track || (a.track === b.track && a.ms < b.ms);

/**
 * The chapters of the audiobook in order, each where it starts: the player's own list (a track per
 * chapter; the chapters inside a track that holds several; a single file's own chapters), without
 * a second stop at the same place (a track and the first chapter heard at its very start).
 */
export function chapterStops(edition: Edition, chapters: BookDetail['chapters']): Stop[] {
  const stops: Stop[] = [];
  for (const entry of listEntries(edition, chapters)) {
    const last = stops.at(-1);
    const stop = { track: entry.track, ms: entry.ms };
    if (!last || before(last, stop)) stops.push(stop);
  }
  return stops;
}

/**
 * Where the previous or next chapter button goes from a place (D190): the next chapter's start
 * (none past the last); for previous, this chapter's start once it has played for a few seconds,
 * else the chapter before's (the first chapter's own start at the very beginning). The same rule
 * for the lock screen's track buttons, headphones, a car and the player's own buttons, so a
 * single-file M4B's chapters are reached the same way as a folder of tracks.
 */
export function chapterStep(stops: readonly Stop[], here: Stop, direction: 1 | -1): Stop | null {
  if (stops.length === 0) return null;
  let current = -1;
  for (let i = 0; i < stops.length; i++) if (!before(here, stops[i]!)) current = i;
  if (direction === 1) return stops[current + 1] ?? null;
  if (current < 0) return { track: 0, ms: 0 };
  const start = stops[current]!;
  const into = here.track === start.track ? here.ms - start.ms : Number.POSITIVE_INFINITY;
  if (into > RESTART_CHAPTER_MS || current === 0) return start;
  return stops[current - 1]!;
}

/** Whether a place is at the very start of the audiobook, where "previous" has nowhere to go. */
export function atBookStart(stops: readonly Stop[], here: Stop): boolean {
  const first = stops[0] ?? { track: 0, ms: 0 };
  return here.track < first.track || (here.track === first.track && here.ms <= first.ms + RESTART_CHAPTER_MS);
}

/**
 * The lock screen's scrubber, read from the element itself (never a rounded copy of it): null while
 * the track's length is not known yet, the position kept inside the track, a speed that is never 0
 * (the Media Session refuses it; paused is said by the playback state).
 */
export function positionStateOf(el: Pick<HTMLMediaElement, 'duration' | 'currentTime' | 'playbackRate'>): MediaPositionState | null {
  const { duration } = el;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const position = Math.min(Math.max(0, Number.isFinite(el.currentTime) ? el.currentTime : 0), duration);
  const playbackRate = el.playbackRate > 0 && Number.isFinite(el.playbackRate) ? el.playbackRate : 1;
  return { duration, position, playbackRate };
}
