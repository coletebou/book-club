import { type AudioLocator, type BookDetail, type Edition, type Locator, chapterIndexAt, chapterNames, frontMatterOf } from '@bookclub/shared';
import { type StartPosition, tOf, translatePlace } from '../reader/position';
import { SAME_PLACE_T } from '../reader/elsewhere';

/**
 * One book, read or heard or both (D186, D187, D197, D198): the rules that decide where each
 * format opens and what the book page offers, pure so each is unit-tested.
 */

/** "Chapter 4", as short as the book names it; null before the story's first chapter. */
export function chapterShort(book: Pick<BookDetail, 'chapters'>, t: number): string | null {
  const i = chapterIndexAt(book.chapters, t);
  if (i < 0 || i < frontMatterOf(book.chapters)) return null;
  return chapterNames(book.chapters)[i] ?? null;
}

export interface FormatAction {
  /** What it opens: a text (EPUB or PDF), or the audiobook of a book that has no text. */
  readonly edition: Edition;
  readonly label: string;
  readonly primary: boolean;
  /** Listening (D197, D198): the audiobook played over `edition`, the text, from your place. */
  readonly along?: Edition;
}

/**
 * The book page's one way in (D198). Exactly one button:
 * - A book with text: always opens the text. Label is "Continue" once you have a place, else
 *   "Open". If you were last listening and the audiobook is not hidden, the same tap starts it
 *   over the page (`along`).
 * - A book that is only an audiobook: opens the player ("Continue" / "Open").
 * Secondary formats and hide-audiobook live in Book settings, not beside this button.
 */
export function formatActions(
  _book: Pick<BookDetail, 'chapters'>,
  ready: readonly Edition[],
  mine: { editionId: string | null; t: number } | null | undefined,
  options: { readonly audioHidden?: boolean } = {},
): FormatAction[] {
  const placed = !!mine && mine.t > 0;
  const label = placed ? 'Continue' : 'Open';
  const texts = ready.filter((e) => e.kind !== 'audio');
  const audios = ready.filter((e) => e.kind === 'audio');
  if (texts.length === 0) {
    const last = audios.find((e) => e.id === mine?.editionId) ?? audios[0];
    if (!last) return [];
    return [{ edition: last, label, primary: true }];
  }
  const lastIn = ready.find((e) => e.id === mine?.editionId);
  const listened = lastIn?.kind === 'audio';
  const text =
    (lastIn && !listened ? lastIn : null) ?? (listened ? textFor(ready, lastIn) : null) ?? texts.find((e) => e.kind === 'epub') ?? texts[0]!;
  const audiobook = options.audioHidden ? null : listened ? lastIn : null;
  return [{ edition: text, label, primary: true, ...(audiobook ? { along: audiobook } : {}) }];
}

/**
 * The player, already holding this audiobook and paused, opened again (D186): if your newest place
 * is in another format (you read on since you stopped listening, here or elsewhere), the place it
 * should go to; else none. A look in the player is left alone: it is somewhere on purpose.
 */
export function catchUpTo(start: StartPosition, edition: Edition, here: AudioLocator | null): AudioLocator | null {
  if (start.source !== 'other-format' || start.locator?.kind !== 'audio' || !here) return null;
  return Math.abs(tOf(edition, start.locator) - tOf(edition, here)) > SAME_PLACE_T ? start.locator : null;
}

/**
 * Play pressed in a reader (D186): where the audiobook starts. If it is already on this page, or
 * about to come to it (within the next page), it resumes where it is: reading along, a glance
 * back, a pause. Anywhere else (you read on since it stopped, or went back to reread), it starts
 * at the page you are reading.
 */
export function playFrom(audioT: number | null, page: { readonly startT: number; readonly endT: number }): 'resume' | 'page' {
  if (audioT === null) return 'page';
  const span = Math.max(page.endT - page.startT, SAME_PLACE_T);
  return audioT >= page.startT - SAME_PLACE_T && audioT <= page.endT + span ? 'resume' : 'page';
}

/**
 * The audiobook a reader of `text` reads along with (D194): the one lined up with this very edition
 * (D46) if there is one, else the book's first ready audiobook; none, and the reader offers none.
 */
export function audiobookFor(editions: readonly Edition[], text: Pick<Edition, 'id'>): Edition | null {
  const ready = editions.filter((e) => e.kind === 'audio' && e.status === 'ready');
  return ready.find((e) => e.readAlong?.textEditionId === text.id) ?? ready[0] ?? null;
}

/**
 * The text a listener of `audio` reads along in (D194): the edition it is lined up with, else the
 * book's EPUB, else its PDF; none, and the player has no text to show.
 */
export function textFor(editions: readonly Edition[], audio: Pick<Edition, 'readAlong'>): Edition | null {
  const ready = editions.filter((e) => e.status === 'ready' && e.kind !== 'audio');
  return ready.find((e) => e.id === audio.readAlong?.textEditionId) ?? ready.find((e) => e.kind === 'epub') ?? ready[0] ?? null;
}

/**
 * The one obvious Play over the page (D194): this book's audiobook over the page (`docked`), not
 * playing, and either the browser refused to start it without a tap or listening was asked for
 * (opened with `along`) and has not started.
 */
export function needsStartTap(docked: boolean, player: { readonly playing: boolean; readonly blocked: boolean }, askedAlong: boolean): boolean {
  return docked && !player.playing && (player.blocked || askedAlong);
}

/**
 * Where reading along starts from the book page (D194): your place, in the audiobook (to the
 * sentence where it is lined up, D46); the audiobook's start before anything is read.
 */
export function alongStart(book: BookDetail, audio: Edition, mine: { readonly editionId: string | null; readonly t: number; readonly locator?: Locator | null } | null | undefined): AudioLocator | null {
  if (!mine || mine.t <= 0) return null;
  const to = translatePlace(book, audio, { t: mine.t, ...(mine.editionId ? { editionId: mine.editionId } : {}), ...(mine.locator ? { locator: mine.locator } : {}) });
  return to?.kind === 'audio' ? to : null;
}

/** Whether the audiobook, paused at `here`, should go to `to` first: it is somewhere else in the book than your place. */
export function elsewhereThan(edition: Edition, here: AudioLocator | null, to: AudioLocator | null): boolean {
  return !!here && !!to && Math.abs(tOf(edition, here) - tOf(edition, to)) > SAME_PLACE_T;
}

/** Sentinel in `?along=` when the card/banner resumes listening over text without an edition id (D198). */
export const ALONG_RESUME = '1';

/** Resolve an `along` query value to an audiobook edition id, or null. */
export function resolveAlong(editions: readonly Edition[], text: Pick<Edition, 'id'>, along: string | null | undefined): string | null {
  if (!along) return null;
  if (along === ALONG_RESUME) return audiobookFor(editions, text)?.id ?? null;
  return editions.some((e) => e.id === along && e.kind === 'audio' && e.status === 'ready') ? along : audiobookFor(editions, text)?.id ?? null;
}
