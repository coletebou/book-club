import { type AudioLocator, NativeAudioDiagnosticSchema, RATE_MAX, RATE_MIN, type NativeAudioDiagnostic, type ReadSpanInput } from '@bookclub/shared';

/**
 * The bridge to the iOS app's native audio (D131, D132): when this page runs inside the Expo
 * shell, `window.BookClubNative` is injected before any page script runs (the app's
 * `injectedJavaScriptBeforeContentLoaded`). `AudioProvider` then uses a `NativeAudioElement`
 * instead of an `<audio>` DOM node: the same surface (`src`, `currentTime`, `duration`, `paused`,
 * `playbackRate`, `play()`, `pause()`, its events), backed by `postMessage` to native, so every
 * other line of `AudioProvider.tsx` (places, looks, D70 catch-up, the sleep timer, read-along)
 * stays exactly as it is for the browser.
 *
 * Lock-screen and Control Center controls are native (expo-audio owns them): rather than add a
 * second code path to `AudioProvider`, this also stands a `NativeMediaSession` in for
 * `navigator.mediaSession` (absent in WKWebView, so every mediaSession effect in `AudioProvider`
 * is presently a no-op there), so that code runs unchanged too and simply ends up telling native
 * what to show and to listen for.
 *
 * Media URLs need no special handling here: the app shares the page's session cookie into the
 * native request that loads a track (D133, `docs/DECISIONS.md`), so a track's URL is passed to
 * native exactly as the page already has it.
 */

/** What the web side sends to native. Kept as plain, JSON-serialisable commands. */
export type NativeAudioCommand =
  | { readonly type: 'load'; readonly url: string }
  | { readonly type: 'unload' }
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'seek'; readonly time: number }
  | { readonly type: 'setRate'; readonly rate: number }
  | { readonly type: 'metadata'; readonly title: string; readonly artist?: string; readonly album?: string; readonly artwork: readonly string[] }
  | { readonly type: 'playbackState'; readonly state: MediaSessionPlaybackState }
  | { readonly type: 'positionState'; readonly duration?: number; readonly playbackRate?: number; readonly position?: number }
  /** What native may play on into by itself while the page sleeps (D181); null: nothing loaded. */
  | { readonly type: 'queue'; readonly queue: NativeQueue | null }
  /** When the sleep timer ends (ms since the epoch), for native to pause then itself (D181). */
  | { readonly type: 'sleep'; readonly at: number | null }
  /** What native kept of the place on the device (D196): answered with `kept`. Older builds ignore it. */
  | { readonly type: 'tellKept' };

/** The audiobook loaded, for native to go on with by itself while the page sleeps (D181). */
export interface NativeQueue {
  readonly bookId: string;
  readonly editionId: string;
  /** Whose listening this is (D196): native keeps the place it hears for that person only. */
  readonly userId?: string | null;
  /** Whether native may start the next track when one ends (not in a party, nor sleeping at a track's end). */
  readonly advance: boolean;
  /** Every track in order: its absolute URL (as the element's `src` says it) and its lock-screen title. */
  readonly tracks: readonly { readonly url: string; readonly title: string }[];
}

/** A status update from native: the element's state after whichever DOM event it names. */
interface NativeStatus {
  readonly type: 'status';
  readonly event: 'loadedmetadata' | 'timeupdate' | 'play' | 'pause' | 'ended' | 'waiting' | 'playing' | 'error' | 'ratechange' | 'emptied';
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly playbackRate: number;
  readonly readyState: number;
  readonly errorMessage?: string;
  /** When native saw the player in this state (ms since the epoch; D196). Absent from older builds. */
  readonly at?: number;
}

/**
 * The place native kept on the device (D196): the newest it heard, whose it is, and the stretches
 * heard that its own saves have not yet got to the server. The page saves it as any place saved on
 * this device: kept locally first, then sent, newest wins.
 */
export interface NativeKept {
  readonly bookId: string;
  readonly editionId: string;
  readonly userId: string;
  readonly locator: AudioLocator;
  readonly at: number;
  readonly spans: ReadSpanInput[];
}

interface NativeKeptMessage {
  readonly type: 'kept';
  readonly kept: NativeKept | null;
}

/** A lock-screen or headphone button, relayed from native to whichever handler claimed it. */
interface NativeRemoteAction {
  readonly type: 'remote-action';
  readonly action: MediaSessionAction;
  readonly seekOffset?: number;
  readonly seekTime?: number;
}

/**
 * Native went on to the next track by itself (D181), told just before the `ended` of the one that
 * finished: the element's `src` is that track's from then on, so `AudioProvider` follows it rather
 * than load it again.
 */
interface NativeAdvanced {
  readonly type: 'advanced';
  readonly url: string;
}

type NativeToWeb = NativeStatus | NativeRemoteAction | NativeAdvanced | NativeKeptMessage | { readonly type: 'diagnostic'; readonly diagnostic: NativeAudioDiagnostic };

/** A native seek this close to where the page asked counts as there (the player seeks to a frame). */
export const SEEK_REACHED_S = 1.5;

/** A seek native never answers (it had no player at that moment) holds the place no longer than this. */
export const SEEK_HOLD_MS = 4_000;

const sources = new WeakMap<HTMLAudioElement, 'native-local' | 'native-network'>();
/** The elements that are native players (createNativeAudioElement), not `<audio>` nodes. */
const natives = new WeakSet<object>();

/** Tell a native player what it may play on into by itself (D181); nothing for an `<audio>` element. */
export function sendNativeQueue(el: HTMLAudioElement, queue: NativeQueue | null): void {
  if (natives.has(el)) post({ type: 'queue', queue });
}

/** Tell a native player when the sleep timer ends (D181); nothing for an `<audio>` element. */
export function sendNativeSleep(el: HTMLAudioElement, at: number | null): void {
  if (natives.has(el)) post({ type: 'sleep', at });
}

/** Ask a native player for the place it kept on the device (D196): a `native-kept` event answers. */
export function askNativeKept(el: HTMLAudioElement): void {
  if (natives.has(el)) post({ type: 'tellKept' });
}

/**
 * When the player was where its `currentTime` says (D196): now for an `<audio>` element; for a
 * native player, when native said so (or when this page told it to seek there). A place heard long
 * ago and only now delivered to the page (asleep in the background meanwhile) is that old.
 */
export function observedAt(el: HTMLAudioElement): number {
  return natives.has(el) ? ((el as unknown as { observedAt?: number }).observedAt ?? Date.now()) : Date.now();
}

/** The longer side of a `MediaImage`'s `sizes` ("512x512"; 0 when it does not say). */
function imageSize(image: MediaImage): number {
  return Math.max(0, ...(image.sizes ?? '').split(/\s+/).map((size) => Math.max(...size.split(/x/i).map(Number).filter(Number.isFinite), 0)));
}
export const nativeAudioSource = (el: HTMLAudioElement): 'native-local' | 'native-network' | 'native-unknown' => sources.get(el) ?? 'native-unknown';

export interface BookClubNativeBridge {
  postMessage(json: string): void;
  /**
   * The fastest speed this build's native player plays (D195), set by builds that play past 2×.
   * Absent from every build before it, whose player (expo-audio's own `setPlaybackRate`) stops at 2×.
   */
  readonly maxRate?: number;
}

declare global {
  interface Window {
    BookClubNative?: BookClubNativeBridge;
    __bookClubReceive?: (json: string) => void;
    __bookClubNavigate?: (path: string) => void;
  }
}

/** Whether this page is running inside the iOS app's WebView, not a browser. */
export function isNativeApp(): boolean {
  return typeof window !== 'undefined' && !!window.BookClubNative;
}

/** expo-audio's iOS player caps every rate at 2.0 (its `setPlaybackRate`, SDK 58), until patched (D195). */
export const NATIVE_LEGACY_MAX_RATE = 2;

/**
 * The fastest speed this device plays (D195): any browser plays the whole range; inside the iOS
 * app, whatever its build says it can, and 2× for a build that says nothing (every build before
 * D195), so the page never asks for a speed native would quietly play slower.
 */
export function maxPlayableRate(): number {
  if (!isNativeApp()) return RATE_MAX;
  const max = window.BookClubNative?.maxRate;
  return typeof max === 'number' && Number.isFinite(max) ? Math.min(RATE_MAX, Math.max(RATE_MIN, max)) : NATIVE_LEGACY_MAX_RATE;
}

/**
 * A push notification's target (D134, `/books/<id>#note-<id>`, the bell's own link format) opens
 * through the client-side router, not a full reload: native calls `window.__bookClubNavigate`
 * after a tap (`BookClubWebView.open` in apps/mobile). `pushState` alone does not fire `popstate`
 * (only real back/forward navigation does); the router's history listens for it regardless and
 * re-reads `location` when it fires, which is the usual way to drive it from outside React.
 */
export function installNativeNavigationBridge(): void {
  if (!isNativeApp()) return;
  window.__bookClubNavigate = (path: string) => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
}

function post(command: NativeAudioCommand): void {
  window.BookClubNative?.postMessage(JSON.stringify(command));
}

/**
 * The lock screen and headphone controls, standing in for `navigator.mediaSession` (D131):
 * `AudioProvider`'s existing effects call this unchanged; native shows and hears the result.
 */
class NativeMediaSession implements Pick<MediaSession, 'metadata' | 'playbackState' | 'setActionHandler' | 'setPositionState'> {
  private handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  private _metadata: MediaMetadata | null = null;
  private _playbackState: MediaSessionPlaybackState = 'none';

  get metadata(): MediaMetadata | null {
    return this._metadata;
  }

  set metadata(m: MediaMetadata | null) {
    this._metadata = m;
    if (!m) return;
    // Largest first: native shows `artwork[0]` (a lock screen's tile wants the sharpest, D190).
    const artwork = [...m.artwork].sort((a, b) => imageSize(b) - imageSize(a)).map((a) => a.src);
    post({ type: 'metadata', title: m.title, artist: m.artist, album: m.album, artwork });
  }

  get playbackState(): MediaSessionPlaybackState {
    return this._playbackState;
  }

  set playbackState(s: MediaSessionPlaybackState) {
    this._playbackState = s;
    post({ type: 'playbackState', state: s });
  }

  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    this.handlers.set(action, handler);
  }

  setPositionState(state?: MediaPositionState): void {
    if (!state) return;
    post({ type: 'positionState', duration: state.duration, playbackRate: state.playbackRate, position: state.position });
  }

  /** A remote command came back from native: run whichever handler `AudioProvider` registered. */
  handle(msg: NativeRemoteAction): void {
    this.handlers.get(msg.action)?.({ action: msg.action, seekOffset: msg.seekOffset, seekTime: msg.seekTime });
  }
}

/**
 * Stands in for `navigator.mediaSession` so `AudioProvider`'s unchanged effects drive native's
 * lock screen instead of a no-op. Call once, before `AudioProvider` mounts.
 */
export function installNativeMediaSessionShim(): NativeMediaSession {
  const session = new NativeMediaSession();
  Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
  return session;
}

/**
 * The element `AudioProvider` drives instead of an `<audio>` DOM node: same surface, same events,
 * backed by native playback. `mediaSession` (from `installNativeMediaSessionShim`) hears remote
 * commands relayed through this element's message channel.
 */
export function createNativeAudioElement(mediaSession?: NativeMediaSession): HTMLAudioElement {
  const target = new EventTarget();
  let srcValue = '';
  let currentTime = 0;
  let duration = NaN;
  let paused = true;
  let ended = false;
  let playbackRate = 1;
  let readyState = 0;
  let seeking = false;
  /** When native last said where it was, or this page moved it (D196). */
  let observed = Date.now();
  /**
   * A seek this page asked for and native has not yet made (D196): the place is that, not what
   * native's last reports still say. Native answers each seek with a `native-seek` diagnostic once
   * done, its new place just before; until then a report of the old place (sent before it heard the
   * seek, or as a new track came in at 0:00) is no news of where the player is going. Without this,
   * a track opened at 12:34 said 0:00 between its metadata and its seek: a pause, or the app hidden,
   * in that moment saved the chapter's start, and what was heard counted from there.
   */
  let seekTarget: number | null = null;
  let seekAt = 0;
  let seeksOut = 0;
  /** Every seek asked for is answered: native's next report is from after them, wherever it landed. */
  let seeksDone = false;
  /** Native's own last word on the time, held back while a seek is under way. */
  let nativeTime = 0;
  const release = (at: number) => {
    seekTarget = null;
    seeksOut = 0;
    seeksDone = false;
    currentTime = nativeTime;
    observed = at;
  };

  window.__bookClubReceive = (json: string) => {
    let msg: NativeToWeb;
    try {
      msg = JSON.parse(json) as NativeToWeb;
    } catch {
      return;
    }
    if (msg.type === 'kept') {
      target.dispatchEvent(new CustomEvent('native-kept', { detail: msg.kept ?? null }));
      return;
    }
    if (msg.type === 'diagnostic') {
      const parsed = NativeAudioDiagnosticSchema.safeParse(msg.diagnostic);
      if (!parsed.success) return;
      if (parsed.data.event === 'native-seek') {
        seeking = parsed.data.outcome === 'started';
        // A seek done (or failed): once every seek asked for is, native's word is the place again.
        if (parsed.data.outcome !== 'started' && seekTarget !== null && --seeksOut <= 0) {
          // Its new place came just before this, as a rule: then it is the place now. Else the next
          // report is (it comes after the seek, wherever the seek landed).
          if (Math.abs(nativeTime - seekTarget) <= SEEK_REACHED_S) release(Date.now());
          else seeksDone = true;
        }
      }
      if (parsed.data.event === 'native-source' && (parsed.data.source === 'native-local' || parsed.data.source === 'native-network')) sources.set(el as unknown as HTMLAudioElement, parsed.data.source);
      target.dispatchEvent(new CustomEvent('native-diagnostic', { detail: parsed.data }));
      return;
    }
    if (msg.type === 'remote-action') {
      mediaSession?.handle(msg);
      return;
    }
    if (msg.type === 'advanced') {
      // Native already plays it: the element's source is that track's now, with nothing to load.
      sources.delete(el as unknown as HTMLAudioElement);
      srcValue = new URL(msg.url, location.href).href;
      // A seek the page was waiting on went with the finished track's player: native never answers it.
      seekTarget = null;
      seeksOut = 0;
      seeksDone = false;
      return;
    }
    nativeTime = msg.currentTime;
    const at = typeof msg.at === 'number' && Number.isFinite(msg.at) ? msg.at : Date.now();
    if (seekTarget === null) {
      currentTime = msg.currentTime;
      observed = at;
    } else if (seeksDone || Math.abs(msg.currentTime - seekTarget) <= SEEK_REACHED_S || Date.now() - seekAt > SEEK_HOLD_MS) release(at);
    duration = msg.duration;
    paused = msg.paused;
    ended = msg.ended;
    playbackRate = msg.playbackRate;
    readyState = msg.readyState;
    target.dispatchEvent(new Event(msg.event));
  };

  const el = {
    get src() {
      return srcValue;
    },
    set src(value: string) {
      // A real element's `src` getter reflects the resolved URL, not the raw assignment (the
      // `a.src.endsWith(track.url)` check in `AudioProvider.loadTrack` relies on that).
      sources.delete(el as unknown as HTMLAudioElement);
      readyState = 0;
      seeking = false;
      paused = true;
      ended = false;
      currentTime = 0;
      nativeTime = 0;
      seekTarget = null;
      seeksOut = 0;
      seeksDone = false;
      observed = Date.now();
      srcValue = value ? new URL(value, location.href).href : '';
      if (!srcValue) return;
      post({ type: 'load', url: srcValue });
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      seekTarget = value;
      seekAt = Date.now();
      seeksOut++;
      seeksDone = false;
      observed = seekAt;
      post({ type: 'seek', time: value });
    },
    /** When native was where `currentTime` says (`observedAt`, D196). */
    get observedAt() {
      return observed;
    },
    get duration() {
      return duration;
    },
    get paused() {
      return paused;
    },
    get ended() {
      return ended;
    },
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(value: number) {
      playbackRate = value;
      post({ type: 'setRate', rate: value });
    },
    get readyState() {
      return readyState;
    },
    get seeking() {
      return seeking;
    },
    preload: 'metadata',
    load() {
      // `src`'s setter already told native to load it; a real element's `load()` is otherwise
      // only needed to reload the current source, which native does not need telling twice.
    },
    play(): Promise<void> {
      post({ type: 'play' });
      return Promise.resolve();
    },
    pause(): void {
      post({ type: 'pause' });
    },
    removeAttribute(name: string): void {
      if (name !== 'src') return;
      srcValue = '';
      currentTime = 0;
      nativeTime = 0;
      seekTarget = null;
      seeksOut = 0;
      seeksDone = false;
      duration = NaN;
      paused = true;
      ended = false;
      readyState = 0;
      post({ type: 'unload' });
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };

  natives.add(el);
  return el as unknown as HTMLAudioElement;
}
