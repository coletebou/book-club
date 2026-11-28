import { type WidgetBook, type WidgetSnapshot } from '@bookclub/shared';
import { type AudioPlace } from '../audio/BackgroundProgress';

/**
 * What CarPlay shows (D221), built here and drawn as is by the native side
 * (`modules/book-club-native/ios/CarPlayController.swift`), so every rule of it is unit-tested in
 * TypeScript: the car only lists, and only plays, what this person already has on this phone.
 *
 * - The books are the widgets' snapshot (D188): your own places in your own clubs' books, nothing
 *   of anyone else's. Signing out clears it, and with it everything CarPlay lists.
 * - A book plays in the car once its audiobook has been opened on this phone: its tracks (URLs and
 *   the titles the player's own list shows) are kept on the device from the page's queue
 *   (`keptQueues.ts`). Nothing is fetched to find a book's tracks.
 * - Chapter titles are the track titles the page already gives the lock screen and its own list;
 *   no notes, chat or other members' places ever reach the car.
 * - Now Playing's own buttons, an action sheet and the voice screen (D232) are part of the model
 *   too: native draws whichever it is given and sends each tap back, so what a button is and does
 *   is decided here, and ships over the air. The car's screen still never shows a book's words, a
 *   note or a message (Apple's CarPlay rules for an audio app, and D221's own).
 */

/** One book's audiobook as the page last gave it to native (its queue), kept on the device. */
export interface KeptQueue {
  readonly bookId: string;
  readonly editionId: string;
  readonly userId: string | null;
  readonly title: string;
  readonly author: string;
  readonly artworkUrl: string | null;
  readonly tracks: readonly { readonly url: string; readonly title: string }[];
  readonly bookmark?: { readonly trackUrl: string; readonly ms: number };
  /** When the page last sent it (ms since the epoch): the newest few are kept. */
  readonly at: number;
}

/** What the engine is playing now, if anything (NativeAudioEngine's `onNowPlaying`). */
export interface CarNowPlaying {
  readonly bookId: string;
  readonly track: number;
  readonly playing: boolean;
}

export interface CarRow {
  /** What a tap sends back (`parseCarCommand`). */
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  /** The cover's book, for the image the widgets keep in the App Group; none for a chapter. */
  readonly coverBookId: string | null;
  /** The row's audio is what plays now (CarPlay draws its playing indicator). */
  readonly playing: boolean;
}

/** One of Now Playing's buttons (D232): an SF Symbol, or CarPlay's own speed button (`system: 'rate'`). */
export type CarButton = { readonly id: string; readonly symbol: string } | { readonly id: string; readonly system: 'rate' };

/** Now Playing's controls (D232): at most five buttons, and the title of its button that opens the chapters. */
export interface CarControls {
  readonly buttons: readonly CarButton[];
  readonly upNext?: string;
}

/** One choice of an action sheet (D232): its tap comes back as `control:<id>`. */
export interface CarAction {
  readonly id: string;
  readonly title: string;
  readonly style?: 'cancel' | 'destructive';
}

/** The voice screen (D232, iOS 27): its states (at most five), the one showing, and the bar button that ends it. */
export interface CarVoice {
  readonly states: readonly { readonly id: string; readonly title: string; readonly symbol?: string }[];
  readonly state: string;
  readonly cancel?: string;
}

/** Where the car goes next, or what it shows over its screens; `seq` changes once per step. */
export type CarNav =
  | { readonly seq: number; readonly to: 'nowPlaying' | 'chapters' | 'dismiss' }
  | { readonly seq: number; readonly to: 'message'; readonly message?: string }
  | { readonly seq: number; readonly to: 'sheet'; readonly message?: string; readonly actions: readonly CarAction[] }
  | { readonly seq: number; readonly to: 'voice'; readonly voice: CarVoice };

export interface CarPlayModel {
  /** The Continue tab's one row: the book listened to last on this phone, from where it was. */
  readonly continue: CarRow | null;
  /** Your club books: each playable here, or listed with why it is not. */
  readonly books: readonly (CarRow & { readonly playable: boolean })[];
  /** The chapters of the book the Chapters tab is on (playing now, else the Continue book). */
  readonly chapters: { readonly bookId: string; readonly title: string; readonly rows: readonly CarRow[] } | null;
  /**
   * Where the car should go after a tap (its `seq` changes once per tap answered): Now Playing once
   * something plays, the book's chapters when its place is not known, or a short message; and
   * (D232) an action sheet, the voice screen, or taking either down.
   */
  readonly nav: CarNav | null;
  /** Now Playing's own buttons (D232); without it, CarPlay's plain Now Playing. */
  readonly controls?: CarControls;
}

/**
 * Why a club book cannot play in the car: its audiobook was never opened on this phone. It states
 * the condition and no more: Apple's CarPlay guide forbids wording that asks the driver to use the
 * phone ("must not include wording that asks people to manipulate their iPhone").
 */
export const NOT_READY = 'Not ready for the car yet';

/** Read a bookmark only if its saved track still belongs to this queue (D252). */
export function bookmarkPlace(queue: KeptQueue): AudioPlace | null {
  const mark = queue.bookmark;
  if (!queue.userId || !mark || !Number.isSafeInteger(mark.ms) || mark.ms < 0) return null;
  const track = queue.tracks.findIndex((entry) => entry.url === mark.trackUrl);
  return track < 0 ? null : { kind: 'audio', track, ms: mark.ms };
}

export type CarCommand =
  | { readonly kind: 'continue' }
  | { readonly kind: 'book'; readonly bookId: string }
  | { readonly kind: 'bookmark'; readonly bookId: string }
  | { readonly kind: 'chapter'; readonly bookId: string; readonly track: number }
  /** One of Now Playing's buttons, or a sheet's choice (D232): the id the model gave it. */
  | { readonly kind: 'control'; readonly id: string }
  /** The voice screen (D232): shown, ended by its bar button, gone by the car's own doing, or not on this iOS. */
  | { readonly kind: 'voice'; readonly event: 'shown' | 'cancel' | 'closed' | 'unavailable' }
  /** An action sheet was asked for where an audio app has none (before iOS 17): nothing was shown. */
  | { readonly kind: 'sheet'; readonly event: 'unavailable' };

/** A row's id back as the command it stands for, or null for anything else. */
export function parseCarCommand(id: unknown): CarCommand | null {
  if (typeof id !== 'string') return null;
  if (id === 'continue') return { kind: 'continue' };
  const book = /^book:([A-Za-z0-9_-]{1,64})$/.exec(id);
  if (book) return { kind: 'book', bookId: book[1]! };
  const bookmark = /^bookmark:([A-Za-z0-9_-]{1,64})$/.exec(id);
  if (bookmark) return { kind: 'bookmark', bookId: bookmark[1]! };
  const chapter = /^chapter:([A-Za-z0-9_-]{1,64}):(\d{1,5})$/.exec(id);
  if (chapter) return { kind: 'chapter', bookId: chapter[1]!, track: Number(chapter[2]) };
  const control = /^control:([A-Za-z0-9_.:-]{1,64})$/.exec(id);
  if (control) return { kind: 'control', id: control[1]! };
  const voice = /^voice:(shown|cancel|closed|unavailable)$/.exec(id);
  if (voice) return { kind: 'voice', event: voice[1] as 'shown' | 'cancel' | 'closed' | 'unavailable' };
  if (id === 'sheet:unavailable') return { kind: 'sheet', event: 'unavailable' };
  return null;
}

const bookId = (id: string) => `book:${id}`;
const chapterId = (book: string, track: number) => `chapter:${book}:${track}`;

/** The snapshot's books, newest first, each once. */
function snapshotBooks(snapshot: WidgetSnapshot | null): WidgetBook[] {
  if (!snapshot) return [];
  const seen = new Set<string>();
  return [snapshot.current, ...snapshot.others].filter((b): b is WidgetBook => !!b && !seen.has(b.bookId) && !!seen.add(b.bookId));
}

/**
 * The model for the given snapshot, kept queues and player. `chaptersOf` is the book the Chapters
 * tab was last sent to (a tap on a book whose place is not known); `nav` is passed through.
 */
export function carPlayModel(input: {
  readonly snapshot: WidgetSnapshot | null;
  readonly queues: readonly KeptQueue[];
  readonly nowPlaying: CarNowPlaying | null;
  readonly chaptersOf?: string | null;
  readonly nav?: CarPlayModel['nav'];
  readonly controls?: CarControls | null;
}): CarPlayModel {
  const books = snapshotBooks(input.snapshot);
  const listed = new Set(books.map((b) => b.bookId));
  // Only books of the person signed in now: a queue kept for a book not in their snapshot is never shown.
  const queues = new Map(input.queues.filter((q) => listed.has(q.bookId)).map((q) => [q.bookId, q]));
  const np = input.nowPlaying && queues.has(input.nowPlaying.bookId) ? input.nowPlaying : null;
  const newest = [...queues.values()].sort((a, b) => b.at - a.at)[0] ?? null;
  const continueBook = np ? queues.get(np.bookId)! : newest;
  const snap = (id: string) => books.find((b) => b.bookId === id);

  const continueRow: CarRow | null = continueBook
    ? {
        // Use the displayed book's command even if the active book changes before the tap (D221).
        id: bookId(continueBook.bookId),
        title: snap(continueBook.bookId)?.title ?? continueBook.title,
        detail: (np && np.bookId === continueBook.bookId ? continueBook.tracks[np.track]?.title : undefined) ?? snap(continueBook.bookId)?.label ?? null,
        coverBookId: continueBook.bookId,
        playing: !!np && np.playing && np.bookId === continueBook.bookId,
      }
    : null;

  const bookRows = books.map((b) => {
    const playable = queues.has(b.bookId);
    return {
      id: bookId(b.bookId),
      title: b.title,
      // Your own place as friends already see it, and the club; why it cannot play, when it cannot.
      detail: playable ? `${b.label} · ${b.clubName}` : NOT_READY,
      coverBookId: b.bookId,
      playing: !!np && np.playing && np.bookId === b.bookId,
      playable,
    };
  });

  const chaptersBook = input.chaptersOf ? queues.get(input.chaptersOf) : continueBook;
  let chapters: CarPlayModel['chapters'] = null;
  if (chaptersBook) {
    const rows = chaptersBook.tracks.map((t, i): CarRow => ({
      id: chapterId(chaptersBook.bookId, i),
      title: t.title,
      detail: null,
      coverBookId: null,
      playing: !!np && np.playing && np.bookId === chaptersBook.bookId && np.track === i,
    }));
    const mark = bookmarkPlace(chaptersBook);
    if (mark) rows.unshift({ id: `bookmark:${chaptersBook.bookId}`, title: 'Bookmark', detail: chaptersBook.tracks[mark.track]!.title, coverBookId: null, playing: false });
    chapters = { bookId: chaptersBook.bookId, title: snap(chaptersBook.bookId)?.title ?? chaptersBook.title, rows };
  }

  return { continue: continueRow, books: bookRows, chapters, nav: input.nav ?? null, ...(input.controls ? { controls: input.controls } : {}) };
}
