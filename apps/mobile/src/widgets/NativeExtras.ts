import { type BookClubNativeApi, type NowPlayingRecord } from '../../modules/book-club-native';

/**
 * The page's messages for the widgets and the Live Activity (D188, D189), on the same channel as
 * the audio and sign-in bridges (each ignores what is not its own): `widgets` is handed to the
 * widget extension through the App Group; `live-activity` says whether the person wants it.
 */
export class NativeExtras {
  /**
   * `origin`: the server whose session the Messages extension may use (D220); none, none shared.
   * `onSnapshot` hears each snapshot once the App Group has it (CarPlay lists its books, D221), and
   * `signedOut` when it was nobody's.
   */
  constructor(
    private readonly native: BookClubNativeApi | null,
    private readonly activity: LiveActivityDriver,
    private readonly origin: string | null = null,
    private readonly onSnapshot: (signedOut: boolean) => void = () => {},
  ) {}

  /**
   * Whether the page's last snapshot was somebody's (false: signed out). The cookie the WebView
   * mirrored stays in the system store after a sign-out, so it alone cannot say; before any
   * snapshot, the cookie decides (and the server, which ended a session signed out of, answers).
   */
  private signedIn = true;

  /**
   * Share the session with the Messages extension, or delete it once signed out (D220): native
   * reads the session cookie the WebView mirrors to the system (D133), unless the page said nobody
   * is signed in. Called with every snapshot (the page sends one on sign-in and sign-out) and on
   * each foreground.
   */
  shareSession(): void {
    if (!this.origin) return;
    try {
      this.native?.shareSession?.(this.origin, this.signedIn);
    } catch {
      // a build without the keychain item's group: the extension simply asks to open the app
    }
  }

  handle(json: string): void {
    let msg: { type?: string; snapshot?: unknown; covers?: unknown; enabled?: unknown };
    try {
      msg = JSON.parse(json) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'widgets' && msg.snapshot && typeof msg.snapshot === 'object') {
      const covers = msg.covers && typeof msg.covers === 'object' ? Object.fromEntries(Object.entries(msg.covers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && /^https?:\/\//.test(e[1]))) : {};
      // A snapshot of nobody's reading (signed out) clears the widgets rather than keeping the last person's.
      const current = (msg.snapshot as { current?: unknown }).current;
      this.signedIn = !(current === null && Object.keys(covers).length === 0);
      if (!this.signedIn) {
        this.native?.clearWidgets();
        this.onSnapshot(true);
      } else {
        void this.native?.setWidgetSnapshot(JSON.stringify(msg.snapshot), covers).then(() => this.onSnapshot(false), () => undefined);
      }
      this.shareSession();
      return;
    }
    if (msg.type === 'live-activity' && typeof msg.enabled === 'boolean') this.activity.setEnabled(msg.enabled);
  }
}

/** What the player is doing, as the audio engine sees it (NativeAudioEngine's `onNowPlaying`). */
export interface NowPlaying {
  readonly bookId: string;
  readonly title: string;
  readonly author: string;
  readonly chapter: string;
  readonly playing: boolean;
  /** Seconds into the file playing, its length, the speed. */
  readonly position: number;
  readonly duration: number;
  readonly rate: number;
  /** The file's place in the audiobook, for how far through it is. */
  readonly track: number;
  readonly tracks: number;
}

/** A place this far from where the activity's clock says playback is counts as a seek. */
const DRIFT_S = 3;

/**
 * The audiobook's Live Activity (D189): shown while the person wants it and the audiobook is loaded,
 * updated only when something a viewer would see changes (play, pause, a seek, a new chapter, the
 * speed), since the system draws the elapsed time itself from the file's start and end; ended when
 * the audiobook stops or the person turns it off.
 */
export class LiveActivityDriver {
  private enabled = false;
  private last: (NowPlayingRecord & { rate: number }) | null = null;

  constructor(private readonly native: BookClubNativeApi | null, private readonly now: () => number = Date.now) {}

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) this.end();
  }

  /** The player's state now; null once nothing is loaded. */
  update(np: NowPlaying | null): void {
    if (!this.native || !this.enabled || !this.native.liveActivitiesAllowed()) {
      if (this.last) this.end();
      return;
    }
    if (!np || !np.bookId) {
      this.end();
      return;
    }
    const record = recordOf(np, this.now());
    const last = this.last;
    if (last && !changed(last, record, np.rate)) return;
    this.last = { ...record, rate: np.rate };
    void this.native.showNowPlaying(record).catch(() => undefined);
  }

  private end(): void {
    this.last = null;
    void this.native?.endNowPlaying().catch(() => undefined);
  }
}

export function recordOf(np: NowPlaying, now: number): NowPlayingRecord {
  const rate = np.rate > 0 ? np.rate : 1;
  const duration = Number.isFinite(np.duration) && np.duration > 0 ? np.duration : 0;
  const startedAt = now - (np.position / rate) * 1000;
  const fraction = duration > 0 ? Math.min(1, np.position / duration) : 0;
  return {
    bookId: np.bookId,
    title: np.title,
    author: np.author,
    chapter: np.chapter,
    playing: np.playing,
    startedAt: Math.round(startedAt),
    endsAt: Math.round(startedAt + (duration / rate) * 1000),
    fraction,
    bookPercent: np.tracks > 0 ? Math.min(100, Math.floor(((np.track + fraction) / np.tracks) * 100)) : 0,
  };
}

/**
 * The watch app (D222): what plays now, as the Live Activity has it (`recordOf`), sent whether or not
 * the Live Activity is on, and only when something the watch shows changed; null once nothing plays.
 */
export class WatchDriver {
  /** What the watch was told last: undefined before anything, null for nothing playing. */
  private last: (NowPlayingRecord & { rate: number }) | null | undefined = undefined;

  constructor(private readonly native: Pick<BookClubNativeApi, 'setWatchNowPlaying'> | null, private readonly now: () => number = Date.now) {}

  update(np: NowPlaying | null): void {
    if (!this.native) return;
    if (!np || !np.bookId) {
      if (this.last !== null) this.native.setWatchNowPlaying(null);
      this.last = null;
      return;
    }
    const record = recordOf(np, this.now());
    if (this.last && !changed(this.last, record, np.rate)) return;
    this.last = { ...record, rate: np.rate };
    this.native.setWatchNowPlaying(JSON.stringify(record));
  }
}

function changed(last: NowPlayingRecord & { rate: number }, next: NowPlayingRecord, rate: number): boolean {
  if (last.bookId !== next.bookId || last.chapter !== next.chapter || last.playing !== next.playing || last.rate !== rate || last.title !== next.title) return true;
  if (Math.abs(last.endsAt - next.endsAt) > 1000) return true; // another file, or its length now known
  // Playing: the activity's clock goes on by itself; only a seek moves its start.
  return next.playing ? Math.abs(last.startedAt - next.startedAt) > DRIFT_S * 1000 : Math.abs(last.fraction - next.fraction) > 0.01;
}
