import { type AudioMetadata, type AudioPlayer, type AudioStatus, type PitchCorrectionQuality, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import {
  LoadSequencer, MEDIA_TICKET_HEADER, PARTIAL_SUFFIX, SNIFF_BYTES, bytesFromBase64, findOfflineCopy, id3TagLength, isCacheableDownload, nativeRate, offlineBaseName,
  offlineFileName, reportableErrorCode, reportableErrorDomain, sniffAfterId3, sniffAudioExtension, type NativeAudioDiagnostic,
} from '@bookclub/shared';
import { BackgroundProgress, type BackgroundProgressDeps, type KeptPlace } from './BackgroundProgress';
import { type MediaTickets } from './mediaTicket';

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
    const head = bytesFromBase64(await FileSystem.readAsStringAsync(from, { encoding: 'base64', position: 0, length: SNIFF_BYTES }));
    let ext = sniffAudioExtension(head);
    // An ID3 tag says nothing of what follows it: an `.aac` audiobook is often tagged too.
    const tag = ext === 'mp3' ? id3TagLength(head) : null;
    if (tag !== null) ext = sniffAfterId3(bytesFromBase64(await FileSystem.readAsStringAsync(from, { encoding: 'base64', position: tag, length: 4 }).catch(() => '')));
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
export interface Queue {
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
  /** Tickets for streaming a track (D219): AVPlayer sends no session cookie; none, it streams with none. */
  readonly tickets?: MediaTickets;
  /** Told of the page's queue and the book's metadata as they come, for CarPlay's kept queues (D221). */
  readonly onQueue?: (queue: Queue, metadata: AudioMetadata | null) => void;
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
  /** When the player last stopped by itself (a status, not a command): a failing item may pause just before its error. */
  private statusPausedAt: number | null = null;
  /** Tracks whose download was not audio iOS plays: not downloaded again this run (D219). */
  private readonly refused = new Set<string>();
  /**
   * Tracks streamed again with a fresh ticket after a failure (D219), and from where: tried once,
   * and again only after it has played on past that place, never in a loop on one bad spot.
   */
  private readonly reticketed = new Map<string, number>();
  private readonly tickets: MediaTickets | null;
  /** A seek the page asked for that the player has not yet made: where a recovery resumes (D219). */
  private pendingSeek: number | null = null;
  /** A recovered player whose statuses wait until it has sought back to the place (D196, D219). */
  private holdingFor: number | null = null;
  private queue: Queue | null = null;
  private sleepAt: number | null = null;
  private readonly progress: BackgroundProgress | null;
  private readonly now: () => number;
  private readonly onNowPlaying: ((np: EngineNowPlaying | null) => void) | null;
  private lastStatus: AudioStatus | null = null;
  /** The kept place read from the device at start; `tellKept` waits for it (D196). */
  private readonly restoring: Promise<void>;
  private readonly onQueue: ((queue: Queue, metadata: AudioMetadata | null) => void) | null;
  /**
   * CarPlay started what plays (D221), not the page: the page (if one is open at all) has another
   * book or none on its element, so it hears nothing of this player and its commands are not
   * obeyed, until it loads a track of its own (the person chose something on the phone).
   */
  private car = false;

  constructor(private readonly sendToPage: SendToWeb, options: NativeAudioEngineOptions = {}) {
    this.progress = options.progress ? new BackgroundProgress(options.progress) : null;
    this.now = options.now ?? (() => Date.now());
    this.onNowPlaying = options.onNowPlaying ?? null;
    this.tickets = options.tickets ?? null;
    this.onQueue = options.onQueue ?? null;
    const read = options.readKept;
    this.restoring = read && this.progress ? read().then((json) => this.progress?.restore(json), () => undefined) : Promise.resolve();
  }

  /** To the page, unless CarPlay drives the player (D221). */
  private send(json: string): void {
    if (!this.car) this.sendToPage(json);
  }

  /** Whether CarPlay started what plays (D221): the place is saved natively, page open or not. */
  drivenByCar(): boolean {
    return this.car;
  }

  /** The place kept on the device (D196), once the one an earlier run kept has been read. */
  async keptPlace(): Promise<KeptPlace | null> {
    await this.restoring;
    return this.progress?.kept() ?? null;
  }

  /**
   * CarPlay plays a book (D221): its kept queue from `track` at `ms`, with its lock-screen title,
   * whatever the page has. The page takes the player back with its next track of its own.
   */
  playFromCar(queue: Queue, metadata: AudioMetadata, track: number, ms: number): void {
    const t = queue.tracks[track];
    if (!t) return;
    this.car = true;
    this.queue = queue;
    this.progress?.setTarget({ bookId: queue.bookId, editionId: queue.editionId, userId: queue.userId ?? null });
    this.metadata = { ...metadata, title: t.title };
    this.sleepAt = null;
    this.wantPlaying = true;
    void this.load(t.url, true, Math.max(0, ms) / 1000).catch(() => this.diagnostic({ event: 'native-error', outcome: 'failed' }));
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
    if (this.car) {
      // CarPlay's book plays (D221): the page's element is on another book, or none. Its next load is
      // the person choosing on the phone, and takes the player back; the rest is not for this player.
      if (cmd.type === 'load') this.car = false;
      else if (cmd.type !== 'tellKept') return;
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
        this.statusPausedAt = null;
        this.player?.play();
        return;
      case 'pause':
        this.wantPlaying = false;
        this.statusPausedAt = null;
        this.player?.pause();
        return;
      case 'seek':
        if (typeof cmd.time === 'number' && this.player) {
          const started = Date.now();
          const player = this.player;
          const time = cmd.time;
          this.pendingSeek = time;
          this.diagnostic({ event: 'native-seek', outcome: 'started' });
          const settle = (outcome: 'ok' | 'failed') => {
            if (this.player !== player) return; // a recovery answers for it (recoverFromNetwork)
            if (this.pendingSeek === time) this.pendingSeek = null;
            this.diagnostic({ event: 'native-seek', outcome, durationMs: Date.now() - started });
          };
          void player.seekTo(time).then(() => settle('ok'), () => settle('failed'));
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
        if (this.queue) this.onQueue?.(this.queue, this.metadata);
        return;
      case 'queue':
        this.queue = isQueue(cmd.queue) ? cmd.queue : null;
        this.progress?.setTarget(this.queue ? { bookId: this.queue.bookId, editionId: this.queue.editionId, userId: typeof this.queue.userId === 'string' ? this.queue.userId : null } : null);
        if (this.queue) this.onQueue?.(this.queue, this.metadata);
        return;
      case 'tellKept':
        // The page, loaded (again), asks what was kept on the device: the place it may have missed (D196).
        // Answered while CarPlay drives too (D221): the page saves the place CarPlay's book is at.
        void this.restoring.then(() => this.sendToPage(JSON.stringify({ type: 'kept', kept: this.progress?.kept() ?? null })));
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

  private async load(url: string, autoplay = false, resumeAt = 0, owedSeek = false): Promise<void> {
    // Taken synchronously, before anything async: the last `load` call made wins, no matter how
    // its own await or an earlier one's resolves (PR #13 review — see LoadSequencer's own note).
    const token = this.loadSequencer.begin();
    if (!owedSeek) this.pendingSeek = null;
    this.holdingFor = null;
    this.statusPausedAt = null;
    this.currentUrl = url;
    this.playingLocal = false;
    this.player?.remove();
    this.player = null;
    this.prev = INITIAL_PREV;
    const failedBefore = this.failedLocal.has(url);
    const local = failedBefore ? null : await findLocal(url).catch(() => null);
    if (!this.loadSequencer.isCurrent(token)) return; // superseded while awaiting; the newer load owns `this.player` now
    // Streamed: with a ticket (D219), since AVPlayer's own requests carry no session cookie.
    const edition = local ? null : (this.tickets?.editionOf(url) ?? null);
    const ticket = edition && this.tickets ? await this.tickets.get(edition).catch(() => null) : null;
    if (!this.loadSequencer.isCurrent(token)) return;
    this.diagnostic({ event: 'native-source', source: local ? 'native-local' : 'native-network' });
    this.playingLocal = !!local;
    if (autoplay) this.wantPlaying = true;
    const player = createAudioPlayer(ticket ? { uri: url, headers: { [MEDIA_TICKET_HEADER]: ticket } } : { uri: local ?? url });
    // The speed and its pitch correction go with the new track at once (D195), not only once the
    // page hears its metadata and sends them again: native plays from the first sample at them.
    player.setPlaybackRate(this.rate, PITCH_QUALITY);
    player.addListener('playbackStatusUpdate', (status) => {
      if (this.loadSequencer.isCurrent(token) && this.holdingFor !== token) this.onStatus(status);
    });
    // The speed chosen carries over to each new player: the page, asleep, cannot set it again (D182).
    if (this.rate !== 1) player.setPlaybackRate(this.rate);
    player.setActiveForLockScreen(true, this.metadata ?? undefined, LOCK_SCREEN_OPTIONS);
    this.player = player;
    if (resumeAt > 0) {
      // Nothing of this player reaches the page until it is back at the place: its 0:00 would be
      // saved as where the person is (D196). A seek the page was owed is answered once it is there.
      this.holdingFor = token;
      const started = Date.now();
      const done = (outcome: 'ok' | 'failed') => {
        if (!this.loadSequencer.isCurrent(token)) return;
        this.holdingFor = null;
        if (owedSeek) {
          this.pendingSeek = null;
          this.diagnostic({ event: 'native-seek', outcome, durationMs: Date.now() - started });
        }
      };
      void player.seekTo(resumeAt).then(() => done('ok'), () => done('failed'));
    }
    if (autoplay) player.play();
    if (!local && !failedBefore && !this.refused.has(url)) void this.downloadForOffline(url, () => this.loadSequencer.isCurrent(token));
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
    this.resume(url, status);
  }

  /**
   * A stream failed (D219): its ticket may have ended (a restart of the server ends them all), so
   * once, with a fresh one, where it was, before the page hears of any error.
   */
  private reticket(url: string, status: AudioStatus): void {
    this.reticketed.set(url, this.pendingSeek ?? (Number.isFinite(status.currentTime) ? status.currentTime : 0));
    const edition = this.tickets?.editionOf(url);
    if (edition) this.tickets?.invalidate(edition);
    this.resume(url, status);
  }

  /** The same track again, from a new player: where the person was going, and playing if it was. */
  private resume(url: string, status: AudioStatus): void {
    // Where the person was going (a seek not yet made), else where it was.
    const owed = this.pendingSeek !== null;
    const resumeAt = owed ? this.pendingSeek! : this.prev.isLoaded && Number.isFinite(status.currentTime) ? status.currentTime : 0;
    // Playing if it was: a failing item may stop by itself a moment before it reports its error.
    const playing = this.wantPlaying || (this.statusPausedAt !== null && this.now() - this.statusPausedAt < 2000);
    void this.load(url, playing, resumeAt, owed).catch(() => this.diagnostic({ event: 'native-error', outcome: 'failed' }));
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
      // A whole response that is not audio iOS plays would be the same the next time: not again this run.
      if (!kept && isCacheableDownload(result.status)) this.refused.add(url);
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
    this.statusPausedAt = null;
    this.pendingSeek = null;
    this.holdingFor = null;
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
      if (url && this.tickets?.editionOf(url) && !this.reticketed.has(url)) {
        this.diagnostic({ event: 'native-error', outcome: 'failed', source: 'native-network', recovered: true, ...errorFields(status) });
        this.reticket(url, status);
        return;
      }
      this.diagnostic({ event: 'native-error', outcome: 'failed', source: 'native-network', ...errorFields(status) });
      this.emit('error', status);
    } else if (!status.error) {
      // A lock-screen, headphone or interruption play/pause is the person's too.
      if (status.playing && !p.playing) {
        this.wantPlaying = true;
        this.statusPausedAt = null;
      } else if (!status.playing && p.playing && !status.didJustFinish) {
        if (this.wantPlaying) this.statusPausedAt = this.now();
        this.wantPlaying = false;
      }
    }
    // It played on past where it failed: a later failure may be tried again.
    const failedAt = this.currentUrl ? this.reticketed.get(this.currentUrl) : undefined;
    if (failedAt !== undefined && status.isLoaded && status.currentTime > failedAt + 5) this.reticketed.delete(this.currentUrl!);
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
