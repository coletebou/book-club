import { type AudioMetadata, type AudioPlayer, type AudioStatus, type PitchCorrectionQuality, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import {
  LoadSequencer, PARTIAL_SUFFIX, SNIFF_BYTES, bytesFromBase64, findOfflineCopy, isCacheableDownload, nativeRate, offlineBaseName, offlineFileName,
  reportableErrorCode, reportableErrorDomain, sniffAudioExtension, type NativeAudioDiagnostic,
} from '@bookclub/shared';
import { BackgroundProgress, type BackgroundProgressDeps } from './BackgroundProgress';

/**
 * The native half of the audio bridge (D130-D132). The web half,
 * `apps/web/src/player/native-bridge.ts`, drives an object shaped like an `HTMLAudioElement`;
 * this turns its commands into calls on a real `expo-audio` `AudioPlayer` (AVPlayer under the
 * hood), and turns that player's own status into the DOM events `AudioProvider.tsx` already
 * listens for, unchanged.
 *
 * Lock-screen and Control Center controls are native end to end (D131): a hardware button or the
 * Control Center acts directly on this player (expo-audio's `MediaController`, read from its
 * source for SDK 58 — github.com/expo/expo `packages/expo-audio/ios/MediaController.swift`), so
 * the resulting `AudioStatus` update is all this needs to forward; nothing comes back through
 * `navigator.mediaSession`'s `setActionHandler` (the shim exists only for the write direction:
 * telling native what to show).
 *
 * Media URLs need no cookie of their own (D133): the WebView shares cookies with the system
 * (`sharedCookiesEnabled`, `BookClubWebView.tsx`), and both `AVURLAsset` (which `expo-audio` uses)
 * and this module's own `fetch` calls consult the same shared cookie storage by default on iOS.
 *
 * Offline (D138): whatever track is currently loaded downloads to `expo-file-system` in the
 * background the first time, and plays from that local copy on every load after — covering "the
 * book you are listening to now," not a general "mark any book offline" manager (not built; see
 * D138 for what that would still need). The copy is named with the extension its own bytes say it
 * is (D219): AVFoundation cannot open a local file without one, and a copy it cannot play is never
 * a reason for a track not to play — the track goes on from the network and the copy is dropped.
 */

export type SendToWeb = (json: string) => void;

interface Prev {
  playing: boolean;
  isLoaded: boolean;
  isBuffering: boolean;
  playbackRate: number;
  error: string | null;
  didJustFinish: boolean;
}

/**
 * Pitch correction at every speed (D195): `high` is AVFoundation's spectral algorithm, the one it
 * recommends for most content at any rate; expo-audio's own default is the cheaper time-domain one.
 */
export const PITCH_QUALITY: PitchCorrectionQuality = 'high';

const INITIAL_PREV: Prev = { playing: false, isLoaded: false, isBuffering: false, playbackRate: 1, error: null, didJustFinish: false };

/** Where the offline copies are (D138), or null where the app has no document directory. */
function offlineDir(): string | null {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}bookclub-audio/` : null;
}

/**
 * Keeps the file at `from` as `<dir><base>.<ext>` when its first bytes are audio iOS plays (D219),
 * and deletes it otherwise (an error body, a format AVFoundation does not open, unreadable). The
 * path kept, or null.
 */
async function keepTyped(from: string, dir: string, base: string): Promise<string | null> {
  try {
    const head = await FileSystem.readAsStringAsync(from, { encoding: 'base64', position: 0, length: SNIFF_BYTES });
    const ext = sniffAudioExtension(bytesFromBase64(head));
    if (ext) {
      const to = `${dir}${offlineFileName(base, ext)}`;
      await FileSystem.moveAsync({ from, to });
      return to;
    }
  } catch {
    // unreadable: not a copy worth keeping
  }
  await FileSystem.deleteAsync(from, { idempotent: true }).catch(() => {});
  return null;
}

/**
 * The playable offline copy of a track, if there is one (D138, D219). A copy kept by a build before
 * D219 has no extension, so iOS cannot open it: it is renamed with the one its bytes say, or
 * deleted, here, the first time its track is loaded again.
 */
async function findLocal(url: string): Promise<string | null> {
  const dir = offlineDir();
  if (!dir) return null;
  const base = offlineBaseName(url);
  const entries = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
  const { typed, legacy } = findOfflineCopy(entries, base);
  if (!legacy) return typed ? `${dir}${typed}` : null;
  if (typed) {
    await FileSystem.deleteAsync(`${dir}${base}`, { idempotent: true }).catch(() => {});
    return `${dir}${typed}`;
  }
  return keepTyped(`${dir}${base}`, dir, base);
}

/** A native error's domain and code as AVPlayer gave them, when this build's expo-audio says (D219). */
function errorFields(status: AudioStatus): Pick<NativeAudioDiagnostic, 'errorDomain' | 'errorCode'> {
  const raw = status as AudioStatus & { errorDomain?: unknown; errorCode?: unknown };
  const errorDomain = reportableErrorDomain(raw.errorDomain);
  const errorCode = reportableErrorCode(raw.errorCode);
  return { ...(errorDomain ? { errorDomain } : {}), ...(errorCode !== undefined ? { errorCode } : {}) };
}

/**
 * One `AVAudioSession` setup for the whole app (call once, on launch): background playback with
 * lock-screen controls, and — since voice channels and talking to Cal may run while a book plays —
 * a category that allows recording (D132). `allowsRecording: true` puts the session in
 * `.playAndRecord` even before anyone records (a dim, standard mic-in-use indicator); switching
 * categories when a voice channel opens risks an audible glitch mid-chapter, which matters more.
 *
 * Not mixable (D182, superseding D132's `mixWithOthers`): iOS makes an app the Now Playing app —
 * the lock screen's and Control Center's player, the one headphones and a car talk to — only if
 * its session does not mix with other apps' audio (expo-audio's own note: "When using
 * `setActiveForLockScreen`, this must be set to `doNotMix`"). Mixing concerns *other apps*: the
 * WebView's own voice channel, voice notes and Cal still play alongside the book, in this app's
 * one session. What changes is that starting the book pauses another app's music or podcast, as
 * an audiobook player should.
 */
export const AUDIO_MODE = {
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  allowsRecording: true,
  interruptionMode: 'doNotMix',
} as const;

export async function configureAudioSession(): Promise<void> {
  await setAudioModeAsync(AUDIO_MODE);
}

/** The page's queue (D181, `NativeQueue` in native-bridge.ts): what native may play on into by itself. */
interface Queue {
  readonly bookId: string;
  readonly editionId: string;
  /** Whose listening it is (D196); absent from pages before it. */
  readonly userId?: string | null;
  readonly advance: boolean;
  readonly tracks: readonly { readonly url: string; readonly title: string }[];
}

/** The lock screen's skips, as the player's own buttons (SKIP_BACK_SECONDS, SKIP_FORWARD_SECONDS). */
export const LOCK_SCREEN_OPTIONS = {
  showSeekForward: true,
  showSeekBackward: true,
  // iOS keeps chapter navigation in the app, not the lock screen (the web app's D64).
  showNextTrack: false,
  showPreviousTrack: false,
  seekForwardIntervalSeconds: 30,
  seekBackwardIntervalSeconds: 15,
} as const;

/** What the player is doing, for the Live Activity (D189): the shape of src/widgets/NativeExtras.ts's `NowPlaying`. */
export interface EngineNowPlaying {
  readonly bookId: string;
  readonly title: string;
  readonly author: string;
  readonly chapter: string;
  readonly playing: boolean;
  readonly position: number;
  readonly duration: number;
  readonly rate: number;
  readonly track: number;
  readonly tracks: number;
}

export interface NativeAudioEngineOptions {
  /** Saving the place while the page sleeps (D182); none in a test that does not need it. */
  readonly progress?: BackgroundProgressDeps;
  /** The place an earlier run of the app kept on the device (`progress.keep`'s file), read at start (D196). */
  readonly readKept?: () => Promise<string | null>;
  readonly now?: () => number;
  /** Told of every change of what is playing (null: nothing loaded), for the Live Activity (D189). */
  readonly onNowPlaying?: (np: EngineNowPlaying | null) => void;
}

export class NativeAudioEngine {
  private player: AudioPlayer | null = null;
  private prev: Prev = INITIAL_PREV;
  private metadata: AudioMetadata | null = null;
  private readonly downloading = new Set<string>();
  // Guards against two overlapping `load` calls racing each other's async file lookup (PR #13
  // review: a second load that starts before the first's `await` resolves must always win, never
  // the one still in flight once it resolves late). See packages/shared/src/audio/native-engine.ts.
  private readonly loadSequencer = new LoadSequencer();
  /** The speed chosen on the page, given to every player made (a new track too, D182). */
  private rate = 1;
  /** The source playing: the URL the page sees as the element's `src`. */
  private currentUrl: string | null = null;
  /** The player is playing the track's offline copy, not the network (D219). */
  private playingLocal = false;
  /** Tracks whose offline copy failed to play this run: streamed, and not downloaded again until the next (D219). */
  private readonly failedLocal = new Set<string>();
  /** Whether the person wants the track playing (their last play or pause): what a recovery resumes (D219). */
  private wantPlaying = false;
  private queue: Queue | null = null;
  private sleepAt: number | null = null;
  private readonly progress: BackgroundProgress | null;
  private readonly now: () => number;
  private readonly onNowPlaying: ((np: EngineNowPlaying | null) => void) | null;
  private lastStatus: AudioStatus | null = null;
  /** The kept place read from the device at start; `tellKept` waits for it (D196). */
  private readonly restoring: Promise<void>;

  constructor(private readonly send: SendToWeb, options: NativeAudioEngineOptions = {}) {
    this.progress = options.progress ? new BackgroundProgress(options.progress) : null;
    this.now = options.now ?? (() => Date.now());
    this.onNowPlaying = options.onNowPlaying ?? null;
    const read = options.readKept;
    this.restoring = read && this.progress ? read().then((json) => this.progress?.restore(json), () => undefined) : Promise.resolve();
  }

  /** Play or pause, from the Live Activity's button (D189): on the player itself, the page asleep or not. */
  toggle(): void {
    const player = this.player;
    if (!player) return;
    if (this.lastStatus?.playing) player.pause();
    else player.play();
  }

  /** Tell the Live Activity what is playing now. */
  private tellNowPlaying(): void {
    if (!this.onNowPlaying) return;
    const status = this.lastStatus;
    const index = this.trackIndex();
    if (!this.player || !this.queue || index < 0 || !status) {
      this.onNowPlaying(null);
      return;
    }
    this.onNowPlaying({
      bookId: this.queue.bookId,
      title: this.metadata?.albumTitle ?? '',
      author: this.metadata?.artist ?? '',
      chapter: this.metadata?.title ?? this.queue.tracks[index]?.title ?? '',
      playing: status.playing,
      position: status.currentTime,
      duration: Number.isFinite(status.duration) ? status.duration : 0,
      rate: status.playbackRate || this.rate,
      track: index,
      tracks: this.queue.tracks.length,
    });
  }

  /** The app went to the background (AppState): the page may sleep from now on. */
  backgrounded(): void {
    this.progress?.backgrounded();
  }

  /** A command from the web bridge (`NativeAudioCommand` in native-bridge.ts), as JSON. */
  handle(json: string): void {
    let cmd: { type: string; url?: string; time?: number; rate?: number; title?: string; artist?: string; album?: string; artwork?: string[]; queue?: Queue | null; at?: number | null };
    try {
      cmd = JSON.parse(json);
    } catch {
      return;
    }
    switch (cmd.type) {
      case 'load':
        this.wantPlaying = false;
        if (cmd.url) void this.load(cmd.url).catch(() => this.diagnostic({ event: 'native-error', outcome: 'failed' }));
        return;
      case 'unload':
        this.unload();
        return;
      case 'play':
        this.wantPlaying = true;
        this.player?.play();
        return;
      case 'pause':
        this.wantPlaying = false;
        this.player?.pause();
        return;
      case 'seek':
        if (typeof cmd.time === 'number' && this.player) {
          const started = Date.now();
          const player = this.player;
          this.diagnostic({ event: 'native-seek', outcome: 'started' });
          void player.seekTo(cmd.time).then(
            () => { if (this.player === player) this.diagnostic({ event: 'native-seek', outcome: 'ok', durationMs: Date.now() - started }); },
            () => { if (this.player === player) this.diagnostic({ event: 'native-seek', outcome: 'failed', durationMs: Date.now() - started }); },
          );
        }
        return;
      case 'setRate': {
        const rate = nativeRate(cmd.rate);
        if (rate !== null) {
          this.rate = rate;
          this.player?.setPlaybackRate(rate, PITCH_QUALITY);
        }
        return;
      }
      case 'metadata':
        // The page sends the artwork largest first (D190): the lock screen's tile wants the sharpest.
        this.metadata = { title: cmd.title ?? '', artist: cmd.artist, albumTitle: cmd.album, artworkUrl: cmd.artwork?.[0] };
        this.player?.updateLockScreenMetadata(this.metadata);
        this.tellNowPlaying();
        return;
      case 'queue':
        this.queue = isQueue(cmd.queue) ? cmd.queue : null;
        this.progress?.setTarget(this.queue ? { bookId: this.queue.bookId, editionId: this.queue.editionId, userId: typeof this.queue.userId === 'string' ? this.queue.userId : null } : null);
        return;
      case 'tellKept':
        // The page, loaded (again), asks what was kept on the device: the place it may have missed (D196).
        void this.restoring.then(() => this.send(JSON.stringify({ type: 'kept', kept: this.progress?.kept() ?? null })));
        return;
      case 'sleep':
        this.sleepAt = typeof cmd.at === 'number' && Number.isFinite(cmd.at) ? cmd.at : null;
        return;
      case 'playbackState':
      case 'positionState':
        // Informational only: native already reflects real playback state and position, which is
        // the source of truth the web side is mirroring, not the other way around.
        return;
      default:
        return;
    }
  }

  /**
   * Plays from a local copy when one already exists (D138: offline playback for whatever the
   * person is currently listening to), and starts one in the background otherwise — never
   * blocking playback on the download, which starts from the network exactly as before.
   */
  private diagnostic(diagnostic: NativeAudioDiagnostic): void {
    // Never send native error text, cookie headers, local paths or media URLs.
    this.send(JSON.stringify({ type: 'diagnostic', diagnostic }));
  }

  private async load(url: string, autoplay = false, resumeAt = 0): Promise<void> {
    // Taken synchronously, before anything async: the last `load` call made wins, no matter how
    // its own await or an earlier one's resolves (PR #13 review — see LoadSequencer's own note).
    const token = this.loadSequencer.begin();
    this.currentUrl = url;
    this.playingLocal = false;
    this.player?.remove();
    this.player = null;
    this.prev = INITIAL_PREV;
    const failedBefore = this.failedLocal.has(url);
    const local = failedBefore ? null : await findLocal(url).catch(() => null);
    if (!this.loadSequencer.isCurrent(token)) return; // superseded while awaiting; the newer load owns `this.player` now
    this.diagnostic({ event: 'native-source', source: local ? 'native-local' : 'native-network' });
    this.playingLocal = !!local;
    if (autoplay) this.wantPlaying = true;
    const player = createAudioPlayer({ uri: local ?? url });
    // The speed and its pitch correction go with the new track at once (D195), not only once the
    // page hears its metadata and sends them again: native plays from the first sample at them.
    player.setPlaybackRate(this.rate, PITCH_QUALITY);
    player.addListener('playbackStatusUpdate', (status) => {
      if (this.loadSequencer.isCurrent(token)) this.onStatus(status);
    });
    // The speed chosen carries over to each new player: the page, asleep, cannot set it again (D182).
    if (this.rate !== 1) player.setPlaybackRate(this.rate);
    player.setActiveForLockScreen(true, this.metadata ?? undefined, LOCK_SCREEN_OPTIONS);
    this.player = player;
    if (resumeAt > 0) void player.seekTo(resumeAt).catch(() => undefined);
    if (autoplay) player.play();
    if (!local && !failedBefore) void this.downloadForOffline(url, () => this.loadSequencer.isCurrent(token));
  }

  /**
   * The offline copy failed to play (D219): drop it, and go on with the same track from the
   * network, where it was and playing if it was, with no error for the page (whose element is still
   * on this track, waiting for its metadata). Only once per track per run: a stream that fails too
   * is a real error.
   */
  private recoverFromNetwork(url: string, status: AudioStatus): void {
    this.failedLocal.add(url);
    const dir = offlineDir();
    if (dir) {
      const base = offlineBaseName(url);
      void FileSystem.readDirectoryAsync(dir)
        .then((entries) => findOfflineCopy(entries, base).typed)
        .then((typed) => (typed ? FileSystem.deleteAsync(`${dir}${typed}`, { idempotent: true }) : undefined))
        .catch(() => undefined);
    }
    const resumeAt = this.prev.isLoaded && Number.isFinite(status.currentTime) ? status.currentTime : 0;
    void this.load(url, this.wantPlaying, resumeAt).catch(() => this.diagnostic({ event: 'native-error', outcome: 'failed' }));
  }

  private async downloadForOffline(url: string, current: () => boolean): Promise<void> {
    const dir = offlineDir();
    if (!dir || this.downloading.has(url)) return;
    this.downloading.add(url);
    const started = Date.now();
    if (current()) this.diagnostic({ event: 'native-download', outcome: 'started' });
    const base = offlineBaseName(url);
    // Written under a name `findLocal` never takes, and kept under the typed one only once it is
    // whole and its bytes are audio iOS plays (D219).
    const part = `${dir}${base}${PARTIAL_SUFFIX}`;
    try {
      if (!(await FileSystem.getInfoAsync(dir)).exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const result = await FileSystem.downloadAsync(url, part);
      // A 401/404/5xx still "completes" as far as downloadAsync is concerned, and leaves its error
      // body behind: never kept (PR #13 review), and neither is a 200 that is not audio (D219).
      const kept = isCacheableDownload(result.status) ? await keepTyped(part, dir, base) : null;
      if (!kept) await FileSystem.deleteAsync(part, { idempotent: true }).catch(() => {});
      if (current()) this.diagnostic({ event: 'native-download', outcome: kept ? 'ok' : 'failed', durationMs: Date.now() - started });
    } catch {
      await FileSystem.deleteAsync(part, { idempotent: true }).catch(() => {});
      if (current()) this.diagnostic({ event: 'native-download', outcome: 'failed', durationMs: Date.now() - started });
      // offline, or the request failed: streamed this time; tried again the next time this loads
    } finally {
      this.downloading.delete(url);
    }
  }

  private unload(): void {
    this.loadSequencer.begin(); // Invalidate a file lookup/status callback still in flight.
    this.currentUrl = null;
    this.playingLocal = false;
    this.wantPlaying = false;
    this.lastStatus = null;
    this.onNowPlaying?.(null);
    this.player?.clearLockScreenControls();
    this.player?.remove();
    this.player = null;
    this.prev = INITIAL_PREV;
  }

  private emit(event: string, status: AudioStatus): void {
    this.send(
      JSON.stringify({
        type: 'status',
        event,
        currentTime: status.currentTime,
        duration: Number.isFinite(status.duration) ? status.duration : 0,
        paused: !status.playing,
        ended: status.didJustFinish,
        playbackRate: status.playbackRate,
        readyState: status.isLoaded ? 2 : 0,
        errorMessage: status.error ?? undefined,
        // When the player was so (D196): the page saves a place delivered late as heard then.
        at: this.now(),
      }),
    );
  }

  /** The index in the page's queue of the track playing, or -1. */
  private trackIndex(): number {
    return this.queue && this.currentUrl ? this.queue.tracks.findIndex((t) => t.url === this.currentUrl) : -1;
  }

  /**
   * A track played to its end. If the page allows it (D181: its queue says `advance`, and there is
   * a next track), go on to that one now, as the page would from its `ended` handler, so playback
   * does not stop while iOS has the page asleep: tell the page first (`advanced`, so its element
   * already says the new track when its `ended` arrives), then load and play it here, with its
   * lock-screen title.
   */
  private finished(status: AudioStatus): void {
    const index = this.trackIndex();
    if (index >= 0) this.progress?.finished({ kind: 'audio', track: index, ms: Math.round(status.currentTime * 1000) });
    const next = this.queue?.advance && index >= 0 ? this.queue.tracks[index + 1] : undefined;
    if (next) this.send(JSON.stringify({ type: 'advanced', url: next.url }));
    this.emit('ended', status);
    if (!next) return;
    if (this.metadata) this.metadata = { ...this.metadata, title: next.title };
    // After this status callback returns: the finished player is removed by the load, not inside its own listener.
    void Promise.resolve()
      .then(() => this.load(next.url, true))
      .catch(() => this.diagnostic({ event: 'native-error', outcome: 'failed' }));
  }

  private onStatus(status: AudioStatus): void {
    this.lastStatus = status;
    this.tellNowPlaying();
    const p = this.prev;
    // The sleep timer, which the page cannot keep while asleep (D182).
    if (this.sleepAt !== null && status.playing && this.now() >= this.sleepAt) {
      this.sleepAt = null;
      this.player?.pause();
    }
    const index = this.trackIndex();
    if (index >= 0 && status.isLoaded && !status.didJustFinish) this.progress?.observe({ kind: 'audio', track: index, ms: Math.round(status.currentTime * 1000) }, status.playing, status.playbackRate || this.rate);
    if (status.error && status.error !== p.error) {
      const url = this.currentUrl;
      if (this.playingLocal && url) {
        // The kept copy, not the track (D219): reported, then the same track from the network.
        this.diagnostic({ event: 'native-error', outcome: 'failed', source: 'native-local', recovered: true, ...errorFields(status) });
        this.recoverFromNetwork(url, status);
        return;
      }
      this.diagnostic({ event: 'native-error', outcome: 'failed', source: 'native-network', ...errorFields(status) });
      this.emit('error', status);
    } else if (!status.error) {
      // A lock-screen, headphone or interruption play/pause is the person's too.
      if (status.playing && !p.playing) this.wantPlaying = true;
      else if (!status.playing && p.playing && !status.didJustFinish) this.wantPlaying = false;
    }
    if (status.isLoaded && !p.isLoaded) this.emit('loadedmetadata', status);
    if (status.playing && !p.playing) {
      this.emit('play', status);
      if (!status.isBuffering) this.emit('playing', status);
    } else if (!status.playing && p.playing) {
      this.emit('pause', status);
    }
    if (status.isBuffering && !p.isBuffering) {
      this.emit('waiting', status);
    } else if (!status.isBuffering && p.isBuffering && status.playing) {
      this.emit('playing', status); // resumed after buffering
    }
    if (status.playbackRate !== p.playbackRate) this.emit('ratechange', status);
    const justFinished = status.didJustFinish && !p.didJustFinish;
    this.prev = { playing: status.playing, isLoaded: status.isLoaded, isBuffering: status.isBuffering, playbackRate: status.playbackRate, error: status.error, didJustFinish: status.didJustFinish };
    if (justFinished) {
      this.finished(status); // May replace the player: last, after this one's own events.
      return;
    }
    this.emit('timeupdate', status);
  }
}

function isQueue(value: unknown): value is Queue {
  if (!value || typeof value !== 'object') return false;
  const q = value as Partial<Queue>;
  return typeof q.bookId === 'string' && typeof q.editionId === 'string' && typeof q.advance === 'boolean'
    && Array.isArray(q.tracks) && q.tracks.every((t) => !!t && typeof t.url === 'string' && typeof t.title === 'string');
}
