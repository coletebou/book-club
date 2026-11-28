import { type AudioMetadata, type AudioPlayer, type AudioStatus, type PitchCorrectionQuality, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import {
  LoadSequencer, MEDIA_TICKET_HEADER, PARTIAL_SUFFIX, SNIFF_BYTES, bytesFromBase64, findOfflineCopy, id3TagLength, isCacheableDownload, nativeRate, offlineBaseName,
  offlineFileName, reportableErrorCode, reportableErrorDomain, sniffAfterId3, sniffAudioExtension, type NativeAudioDiagnostic,
} from '@bookclub/shared';
import { BackgroundProgress, type AudioPlace, type BackgroundProgressDeps, type KeptPlace } from './BackgroundProgress';
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
const CAR_START_TIMEOUT_MS = 20_000;
const CAR_FIRST_SEEK_TIMEOUT_MS = 25_000;
const SPEECH_RESTORE_TIMEOUT_MS = 10_000;
const SPEECH_SEEK_TOLERANCE_MS = 1_000;
const SPEECH_EXACT_SEEK_SECONDS = 0.25;
const SPEECH_PAUSE_GRACE_MS = 400;
const SPEECH_CLIP_TIMEOUT_MS = 75_000;
type SpeechRestore = false | 'answer' | 'page';

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

/**
 * The session while a car is connected (D232): playback only. Apple's CarPlay guide: "recording is
 * not supported while in CarPlay ... While in CarPlay, configure audio sessions without recording
 * features" (a recording session also takes the car's own microphone from its assistant and calls).
 */
export const CAR_AUDIO_MODE = { ...AUDIO_MODE, allowsRecording: false } as const;

export async function configureAudioSession(inCar = false): Promise<void> {
  await setAudioModeAsync(inCar ? CAR_AUDIO_MODE : AUDIO_MODE);
}

/** The page's queue (D181, `NativeQueue` in native-bridge.ts): what native may play on into by itself. */
export interface Queue {
  readonly bookId: string;
  readonly editionId: string;
  /** Whose listening it is (D196); absent from pages before it. */
  readonly userId?: string | null;
  readonly advance: boolean;
  /** This page can adopt a car-owned track without treating the handoff as continuous listening. */
  readonly acceptsHandoff?: boolean;
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

export interface LiveAudioPlace {
  readonly bookId: string;
  readonly editionId: string;
  readonly userId: string | null;
  readonly locator: AudioPlace;
  readonly playing: boolean;
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
  private loadingPosition: number | null = null;
  private firstSeekTimer: ReturnType<typeof setTimeout> | null = null;
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
  /**
   * What the page last said about its own player while CarPlay drove (D221): its queue, sleep timer
   * and speed, applied when it takes the player back. `pageQueue` is undefined until known.
   */
  private pageQueue: Queue | null | undefined = undefined;
  private pageSleep: number | null | undefined = undefined;
  private pageRate: number | undefined = undefined;
  private pageTrack: { url: string; position: number; playing: boolean; metadata: AudioMetadata | null; userId: string | null } | null = null;
  private carStart: { position: number; resolve: (started: boolean) => void; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private carSpeech: { turn: AbortController; resume: boolean; sawPause: boolean; restoring: boolean } | null = null;

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
   * whatever the page has. Resolve after playback starts or fails (D241).
   */
  playFromCar(queue: Queue, metadata: AudioMetadata, track: number, ms: number): Promise<boolean> {
    const t = queue.tracks[track];
    if (!t) return Promise.resolve(false);
    this.finishCarStart(false);
    // Keep the page's own settings even if it never sends a new command while the car drives.
    if (!this.car) {
      this.pageQueue = this.queue;
      this.pageSleep = this.sleepAt;
      this.pageRate = this.rate;
      const position = this.pendingSeek ?? this.loadingPosition ?? this.player?.currentTime ?? 0;
      this.pageTrack = this.currentUrl ? {
        url: this.currentUrl, position: Number.isFinite(position) && position > 0 ? position : 0,
        playing: this.wantPlaying, metadata: this.metadata, userId: this.queue?.userId ?? null,
      } : null;
    }
    if (!this.car || this.queue?.editionId !== queue.editionId) this.sleepAt = null;
    this.car = true;
    this.queue = queue;
    this.progress?.setTarget({ bookId: queue.bookId, editionId: queue.editionId, userId: queue.userId ?? null });
    this.metadata = { ...metadata, title: t.title };
    let resolve!: (started: boolean) => void;
    const ready = new Promise<boolean>((done) => { resolve = done; });
    const start = { position: Math.max(0, ms) / 1000, resolve, timer: null };
    this.carStart = start;
    this.armCarStartTimeout();
    void this.load(t.url, true, start.position).catch(() => {
      if (this.carStart !== start) return;
      this.diagnostic({ event: 'native-error', outcome: 'failed' });
      this.failCarStart();
    });
    return ready;
  }

  private armCarStartTimeout(): void {
    const start = this.carStart;
    if (!start) return;
    start.timer = setTimeout(() => {
      start.timer = null;
      // A seek has its own deadline. Give playback time to start once the seek finishes.
      if (this.carStart === start && this.holdingFor === null) this.failCarStart();
    }, CAR_START_TIMEOUT_MS);
  }

  private failCarStart(): void {
    if (this.carStart) this.restorePageAfterCarFailure();
  }

  private restorePageAfterCarFailure(resumePrevious = true, failedPosition?: number): void {
    const page = this.pageQueue;
    const url = this.currentUrl;
    const sameBookPlace = !this.carStart && this.pageHasCarBook() && page?.acceptsHandoff === true && url
      && (page.userId ?? null) === (this.queue?.userId ?? null)
      && page.tracks.some((track) => track.url === url)
      && failedPosition !== undefined && Number.isFinite(failedPosition) && failedPosition >= 0
      ? { url, position: failedPosition, playing: this.wantPlaying, metadata: this.metadata, userId: page.userId ?? null }
      : null;
    const previous = sameBookPlace ?? this.pageTrack;
    const restore = previous && page && previous.userId === (page.userId ?? null)
      && page.tracks.some((track) => track.url === previous.url);
    this.unload();
    this.endCar(false);
    if (restore) {
      this.metadata = previous.metadata;
      if (previous.playing && resumePrevious) this.resume();
      if (sameBookPlace) this.send(JSON.stringify({ type: 'advanced', url: previous.url, handoff: previous.position, at: this.now() }));
      const token = this.loadSequencer.begin();
      void this.load(previous.url, false, previous.position, false, sameBookPlace ? 'page' : false, token).catch(() => {
        if (this.loadSequencer.isCurrent(token)) this.reportPageRestoreFailure(previous.position);
      });
    }
  }

  private reportPageRestoreFailure(position: number): void {
    this.unload();
    const status = { currentTime: position, duration: 0, playing: false, didJustFinish: false,
      playbackRate: this.rate, isLoaded: false, error: 'Audiobook playback could not be restored' };
    this.emit('pause', status);
    this.emit('error', status);
  }

  private finishCarStart(started: boolean): void {
    const start = this.carStart;
    if (!start) return;
    this.carStart = null;
    if (start.timer !== null) clearTimeout(start.timer);
    start.resolve(started);
  }

  /**
   * A skip, from the watch (D222): the lock screen's own 15 seconds back or 30 forward, on the player
   * itself; the page, if open, hears where it went as from any seek native made.
   */
  skip(seconds: number): void {
    if (this.carSpeech) return;
    const player = this.player;
    const status = this.lastStatus;
    if (!player || !status?.isLoaded || !Number.isFinite(seconds)) return;
    const duration = Number.isFinite(status.duration) && status.duration > 0 ? status.duration : Infinity;
    void player.seekTo(Math.min(Math.max(0, status.currentTime + seconds), duration)).catch(() => undefined);
  }

  /** The car disconnected (D221): the page has the player again if it is on the car's book. */
  carDisconnected(): void {
    this.stopCarSpeech();
    if (this.car && this.pageHasCarBook()) this.endCar(true);
  }

  /** Signing out stops native playback even while the car owns it. */
  forgetAccount(): void {
    this.stopCarSpeech();
    this.car = false;
    this.queue = null;
    this.pageQueue = undefined;
    this.pageSleep = undefined;
    this.pageRate = undefined;
    this.pageTrack = null;
    this.sleepAt = null;
    this.metadata = null;
    this.rate = 1;
    this.progress?.discard();
    this.unload();
  }

  /** The page's queue is the audiobook CarPlay plays (the same edition). */
  private pageHasCarBook(): boolean {
    return !!this.pageQueue && !!this.queue && this.pageQueue.editionId === this.queue.editionId;
  }

  /**
   * The page has the player back (D221): its own queue, sleep timer and speed from now. The target is
   * the page's while the car's still counts as away, so the car's last stretch is saved first (D182).
   * `sync`: the page is on the car's book; it is told the track playing and where, as after an advance.
   */
  private endCar(sync: boolean): void {
    this.stopCarSpeech();
    this.finishCarStart(false);
    const page = this.pageQueue ?? null;
    this.queue = page;
    this.progress?.setTarget(page ? { bookId: page.bookId, editionId: page.editionId, userId: typeof page.userId === 'string' ? page.userId : null } : null);
    if (this.pageSleep !== undefined) this.sleepAt = this.pageSleep;
    if (this.pageRate !== undefined) {
      this.rate = this.pageRate;
      this.player?.setPlaybackRate(this.pageRate, PITCH_QUALITY);
    }
    this.car = false;
    this.pageQueue = undefined;
    this.pageSleep = undefined;
    this.pageRate = undefined;
    this.pageTrack = null;
    if (sync && this.currentUrl && this.trackIndex() >= 0) {
      this.send(JSON.stringify({ type: 'advanced', url: this.currentUrl }));
      if (this.lastStatus) {
        if (this.lastStatus.isLoaded) this.emit('loadedmetadata', this.lastStatus);
        this.emit(this.lastStatus.playing ? 'play' : 'pause', this.lastStatus);
        this.emit('timeupdate', this.lastStatus);
      }
    }
  }

  /** Play or pause, from the Live Activity's button (D189): on the player itself, the page asleep or not. */
  toggle(): void {
    const player = this.player;
    if (!player) return;
    if (player.playing) this.pause();
    else this.resume();
  }

  /** Native controls act on the player directly and leave its current owner in place. */
  pause(): void {
    this.stopCarSpeech();
    this.wantPlaying = false;
    this.statusPausedAt = null;
    this.player?.pause();
  }

  resume(): void {
    if (this.sleepAt !== null && this.sleepAt <= this.now()) this.sleepAt = null;
    this.wantPlaying = true;
    if (this.carSpeech) {
      this.carSpeech.resume = true;
      this.carSpeech.turn.abort();
      return;
    }
    this.statusPausedAt = null;
    if (this.holdingFor === null) this.player?.play();
  }

  setRate(value: number): void {
    const rate = nativeRate(value);
    if (rate === null) return;
    this.rate = rate;
    if (!this.carSpeech || this.carSpeech.restoring) this.player?.setPlaybackRate(rate, PITCH_QUALITY);
  }

  playbackRate(): number {
    return this.rate;
  }

  setSleepTimer(at: number | null): void {
    this.sleepAt = typeof at === 'number' && Number.isFinite(at) ? at : null;
  }

  sleepDeadline(): number | null {
    return this.sleepAt;
  }

  /** The player's place at the tap, independent of the page or the last progress save. */
  livePlace(): LiveAudioPlace | null {
    const player = this.player;
    const queue = this.queue;
    const track = this.trackIndex();
    if (!player || !queue || track < 0 || !this.lastStatus?.isLoaded || this.holdingFor !== null || this.pendingSeek !== null) return null;
    const seconds = player.currentTime;
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return { bookId: queue.bookId, editionId: queue.editionId, userId: queue.userId ?? null, locator: { kind: 'audio', track, ms: Math.round(seconds * 1000) }, playing: player.playing };
  }

  flushPlace(here: LiveAudioPlace, signal: AbortSignal): Promise<boolean> {
    return this.progress?.flush(here, here.locator, this.rate, signal) ?? Promise.resolve(false);
  }

  private stopCarSpeech(): void {
    if (!this.carSpeech) return;
    this.carSpeech.resume = false;
    this.wantPlaying = false;
    this.carSpeech.turn.abort();
  }

  /** Play a spoken turn through the same player, then return to the captured book position. */
  async withCarSpeech(here: LiveAudioPlace, turn: AbortController, work: (play: (uri: string) => Promise<void>) => Promise<void>): Promise<void> {
    const player = this.player;
    const url = this.currentUrl;
    if (!player || !url || this.carSpeech) throw new Error('Playback is unavailable');
    const current = () => this.player === player && this.currentUrl === url && this.queue?.bookId === here.bookId
      && this.queue?.editionId === here.editionId && (this.queue.userId ?? null) === here.userId;
    if (!current()) throw new Error('The audiobook changed');
    this.pause();
    const speech = { turn, resume: here.playing, sawPause: !here.playing, restoring: false };
    this.carSpeech = speech;
    let replaced = false;
    try {
      await work(async (uri) => {
        if (turn.signal.aborted || !current()) throw new Error('Spoken answer cancelled');
        if (!replaced) {
          if (Math.abs(player.currentTime - here.locator.ms / 1000) > 1) throw new Error('The audiobook moved');
          this.loadSequencer.begin(); // The audiobook's status listener must never report the clip as reading.
          this.lastStatus = null;
          player.clearLockScreenControls();
          replaced = true;
        }
        await playSpokenClip(player, uri, turn.signal, () => {
          speech.resume = false;
          turn.abort();
        });
      });
    } finally {
      if (this.carSpeech === speech) {
        const position = here.locator.ms / 1000;
        try {
          if (current() && replaced) {
            speech.restoring = true;
            await this.load(url, speech.resume, position, false, 'answer');
          } else if (current() && speech.resume) {
            this.carSpeech = null;
            this.resume();
          } else if (replaced) {
            this.unload();
          }
        } catch {
          if (this.carSpeech === speech) {
            this.diagnostic({ event: 'native-error', outcome: 'failed' });
            if (this.car) {
              this.restorePageAfterCarFailure(speech.resume, position);
            } else {
              try {
                await this.load(url, speech.resume, position, false, 'page');
              } catch {
                if (this.carSpeech === speech) this.reportPageRestoreFailure(position);
              }
            }
          }
        } finally {
          if (this.carSpeech === speech) this.carSpeech = null;
        }
      }
    }
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
      // CarPlay's book plays (D221). What the page says of its own player is kept for when it takes
      // this one back: with a track of its own (the person choosing on the phone), or a play, pause,
      // seek or speed on the car's own book. Anything else is not for this player.
      if (cmd.type === 'queue') {
        this.pageQueue = isQueue(cmd.queue) ? cmd.queue : null;
        return;
      }
      if (cmd.type === 'sleep') {
        this.pageSleep = typeof cmd.at === 'number' && Number.isFinite(cmd.at) ? cmd.at : null;
        return;
      }
      if (cmd.type === 'setRate' && nativeRate(cmd.rate) !== null && !this.pageHasCarBook()) {
        this.pageRate = nativeRate(cmd.rate)!;
        return;
      }
      if (cmd.type === 'load') this.endCar(false);
      else if ((cmd.type === 'play' || cmd.type === 'pause' || cmd.type === 'seek' || cmd.type === 'setRate') && this.pageHasCarBook()) this.endCar(true);
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
        this.resume();
        return;
      case 'pause':
        this.pause();
        return;
      case 'seek':
        if (typeof cmd.time === 'number' && this.carSpeech && this.currentUrl) {
          // The page scrubber requests the audiobook, even while the same player holds a clip.
          void this.load(this.currentUrl, this.carSpeech.resume, Math.max(0, cmd.time))
            .catch(() => this.diagnostic({ event: 'native-error', outcome: 'failed' }));
          return;
        }
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
      case 'setRate':
        if (typeof cmd.rate === 'number') this.setRate(cmd.rate);
        return;
      case 'metadata':
        // The page sends the artwork largest first (D190): the lock screen's tile wants the sharpest.
        this.metadata = { title: cmd.title ?? '', artist: cmd.artist, albumTitle: cmd.album, artworkUrl: cmd.artwork?.[0] };
        this.player?.updateLockScreenMetadata(this.metadata);
        this.tellNowPlaying();
        // Only the metadata of a track in the queue: a new book's comes before its queue (D221).
        if (this.queue && this.trackIndex() >= 0) this.onQueue?.(this.queue, this.metadata);
        return;
      case 'queue': {
        const queue = isQueue(cmd.queue) ? cmd.queue : null;
        if (this.carSpeech && (queue?.bookId !== this.queue?.bookId || queue?.editionId !== this.queue?.editionId
          || (queue?.userId ?? null) !== (this.queue?.userId ?? null))) this.unload();
        this.queue = queue;
        this.progress?.setTarget(this.queue ? { bookId: this.queue.bookId, editionId: this.queue.editionId, userId: typeof this.queue.userId === 'string' ? this.queue.userId : null } : null);
        if (this.queue) this.onQueue?.(this.queue, this.metadata);
        return;
      }
      case 'tellKept':
        // The page, loaded (again), asks what was kept on the device: the place it may have missed (D196).
        // Answered while CarPlay drives too (D221): the page saves the place CarPlay's book is at.
        void this.restoring.then(() => this.sendToPage(JSON.stringify({ type: 'kept', kept: this.progress?.kept() ?? null })));
        return;
      case 'sleep':
        this.setSleepTimer(cmd.at ?? null);
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

  private clearHeldSeek(): void {
    this.holdingFor = null;
    this.loadingPosition = null;
    if (this.firstSeekTimer !== null) clearTimeout(this.firstSeekTimer);
    this.firstSeekTimer = null;
  }

  private async load(url: string, autoplay = false, resumeAt = 0, owedSeek = false, restoreSpeech: SpeechRestore = false, token = this.loadSequencer.begin()): Promise<void> {
    if (!restoreSpeech && this.carSpeech) {
      this.stopCarSpeech();
      this.carSpeech = null;
    }
    // The caller takes the token synchronously. The last load wins (PR #13).
    if (!owedSeek) this.pendingSeek = null;
    this.clearHeldSeek();
    this.loadingPosition = resumeAt > 0 ? resumeAt : null;
    if (this.carStart?.timer === null) this.armCarStartTimeout();
    this.statusPausedAt = null;
    this.currentUrl = url;
    this.playingLocal = false;
    this.player?.remove();
    this.player = null;
    this.prev = INITIAL_PREV;
    this.lastStatus = null;
    if (autoplay) this.wantPlaying = true;
    const failedBefore = this.failedLocal.has(url);
    const local = failedBefore ? null : await findLocal(url).catch(() => null);
    if (!this.loadSequencer.isCurrent(token)) return; // superseded while awaiting; the newer load owns `this.player` now
    // Streamed: with a ticket (D219), since AVPlayer's own requests carry no session cookie.
    const edition = local ? null : (this.tickets?.editionOf(url) ?? null);
    const ticket = edition && this.tickets ? await this.tickets.get(edition).catch(() => null) : null;
    if (!this.loadSequencer.isCurrent(token)) return;
    this.diagnostic({ event: 'native-source', source: local ? 'native-local' : 'native-network' });
    this.playingLocal = !!local;
    const player = createAudioPlayer(ticket ? { uri: url, headers: { [MEDIA_TICKET_HEADER]: ticket } } : { uri: local ?? url });
    const speechSeek = restoreSpeech && resumeAt > 0 ? new AbortController() : null;
    let checkingPageStart = restoreSpeech === 'page' && resumeAt === 0;
    let restoreRetry: Promise<void> | undefined;
    // The speed and its pitch correction go with the new track at once (D195), not only once the
    // page hears its metadata and sends them again: native plays from the first sample at them.
    player.setPlaybackRate(this.rate, PITCH_QUALITY);
    player.addListener('playbackStatusUpdate', (status) => {
      // A failure can arrive while the initial seek is pending, and Expo reports it only once.
      if (!this.loadSequencer.isCurrent(token) || (this.holdingFor === token && !status.error)) return;
      if (checkingPageStart && status.error) {
        this.reportPageRestoreFailure(resumeAt);
        return;
      }
      if (status.isLoaded) checkingPageStart = false;
      const restoringSpeech = speechSeek !== null && this.holdingFor === token;
      const retry = this.onStatus(status, restoringSpeech ? restoreSpeech : false);
      if (restoringSpeech) {
        restoreRetry = retry;
        void retry?.catch(() => {}); // The pending restore reports failure to the caller.
        speechSeek.abort();
      }
    });
    // The speed chosen carries over to each new player: the page, asleep, cannot set it again (D182).
    if (this.rate !== 1) player.setPlaybackRate(this.rate);
    if (!speechSeek) player.setActiveForLockScreen(true, this.metadata ?? undefined, LOCK_SCREEN_OPTIONS);
    this.player = player;
    if (resumeAt > 0) {
      // Nothing of this player reaches the page until it is back at the place: its 0:00 would be
      // saved as where the person is (D196). A seek the page was owed is answered once it is there.
      this.holdingFor = token;
      const start = this.carStart;
      const started = Date.now();
      const done = (outcome: 'ok' | 'failed') => {
        if (!this.loadSequencer.isCurrent(token) || this.holdingFor !== token) return;
        this.clearHeldSeek();
        if (owedSeek) {
          this.pendingSeek = null;
          this.diagnostic({ event: 'native-seek', outcome, durationMs: Date.now() - started });
        }
        if (start && this.carStart === start) {
          if (outcome === 'failed') { this.failCarStart(); return; }
          if (start.timer === null) this.armCarStartTimeout();
        }
        if (speechSeek) {
          // Expo emits its seek status before resolving, while the position is still held.
          // A paused player need not emit another update.
          const settled = player.currentStatus;
          if (settled?.isLoaded && !settled.error) this.onStatus({ ...settled, currentTime: player.currentTime, didJustFinish: false }, false);
        }
        if (this.wantPlaying) player.play();
      };
      if (speechSeek) {
        const reached = await seekForSpeechRestore(player, resumeAt, restoreSpeech === 'answer' ? 0 : undefined, speechSeek.signal);
        if (!reached && restoreSpeech === 'answer' && !speechSeek.signal.aborted && this.loadSequencer.isCurrent(token)) {
          await seekForSpeechRestore(player, resumeAt, SPEECH_SEEK_TOLERANCE_MS, speechSeek.signal);
        }
        if (restoreRetry) return restoreRetry;
        if (!this.loadSequencer.isCurrent(token)) return;
        // Release a player only near the saved place. A far miss can report or save 0:00.
        const actual = player.currentTime;
        if (!Number.isFinite(actual) || Math.abs(actual - resumeAt) > SPEECH_SEEK_TOLERANCE_MS / 1000 + SPEECH_EXACT_SEEK_SECONDS) {
          if (this.carSpeech) this.carSpeech.resume = false;
          this.wantPlaying = false;
          throw new Error('Audiobook could not be restored near its saved place');
        }
        player.setActiveForLockScreen(true, this.metadata ?? undefined, LOCK_SCREEN_OPTIONS);
        done('ok');
      } else {
        if (start) this.firstSeekTimer = setTimeout(() => done('failed'), CAR_FIRST_SEEK_TIMEOUT_MS);
        void player.seekTo(resumeAt).then(() => done('ok'), () => done('failed'));
      }
    } else if (this.wantPlaying) {
      player.play();
    }
    if (!local && !failedBefore && !this.refused.has(url)) void this.downloadForOffline(url, () => this.loadSequencer.isCurrent(token));
  }

  /**
   * The offline copy failed to play (D219): drop it, and go on with the same track from the
   * network, where it was and playing if it was, with no error for the page (whose element is still
   * on this track, waiting for its metadata). Only once per track per run: a stream that fails too
   * is a real error.
   */
  private recoverFromNetwork(url: string, status: AudioStatus, restoreSpeech: SpeechRestore): Promise<void> {
    this.failedLocal.add(url);
    const dir = offlineDir();
    if (dir) {
      const base = offlineBaseName(url);
      void FileSystem.readDirectoryAsync(dir)
        .then((entries) => findOfflineCopy(entries, base).typed)
        .then((typed) => (typed ? FileSystem.deleteAsync(`${dir}${typed}`, { idempotent: true }) : undefined))
        .catch(() => undefined);
    }
    return this.resumeAfterError(url, status, restoreSpeech);
  }

  /**
   * A stream failed (D219): its ticket may have ended (a restart of the server ends them all), so
   * once, with a fresh one, where it was, before the page hears of any error.
   */
  private reticket(url: string, status: AudioStatus, restoreSpeech: SpeechRestore): Promise<void> {
    this.reticketed.set(url, this.pendingSeek ?? this.loadingPosition ?? (Number.isFinite(status.currentTime) ? status.currentTime : 0));
    const edition = this.tickets?.editionOf(url);
    if (edition) this.tickets?.invalidate(edition);
    return this.resumeAfterError(url, status, restoreSpeech);
  }

  /** The same track again, from a new player: where the person was going, and playing if it was. */
  private resumeAfterError(url: string, status: AudioStatus, restoreSpeech: SpeechRestore): Promise<void> {
    // Where the person was going (a seek not yet made), else where it was.
    const owed = this.pendingSeek !== null;
    const resumeAt = this.pendingSeek ?? this.loadingPosition ?? this.carStart?.position ?? (this.prev.isLoaded && Number.isFinite(status.currentTime) ? status.currentTime : 0);
    // Playing if it was: a failing item may stop by itself a moment before it reports its error.
    const playing = this.wantPlaying || (this.statusPausedAt !== null && this.now() - this.statusPausedAt < 2000);
    const token = this.loadSequencer.begin();
    return this.load(url, playing, resumeAt, owed, restoreSpeech, token).catch((error) => {
      this.diagnostic({ event: 'native-error', outcome: 'failed' });
      if (restoreSpeech) throw error;
      if (this.loadSequencer.isCurrent(token) && this.car) this.restorePageAfterCarFailure(true, resumeAt);
    });
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
    this.stopCarSpeech();
    this.carSpeech = null;
    this.finishCarStart(false);
    this.loadSequencer.begin(); // Invalidate a file lookup/status callback still in flight.
    this.currentUrl = null;
    this.playingLocal = false;
    this.wantPlaying = false;
    this.statusPausedAt = null;
    this.pendingSeek = null;
    this.clearHeldSeek();
    this.lastStatus = null;
    this.onNowPlaying?.(null);
    this.player?.pause(); // Release of the native shared object may happen later.
    this.player?.clearLockScreenControls();
    this.player?.remove();
    this.player = null;
    this.prev = INITIAL_PREV;
  }

  private emit(event: string, status: Pick<AudioStatus, 'currentTime' | 'duration' | 'playing' | 'didJustFinish' | 'playbackRate' | 'isLoaded' | 'error'>): void {
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

  private onStatus(status: AudioStatus, restoreSpeech: SpeechRestore): Promise<void> | undefined {
    const previousStatus = this.lastStatus;
    if (!restoreSpeech) {
      this.lastStatus = status;
      this.tellNowPlaying();
    }
    const speech = this.carSpeech;
    if (speech && !speech.restoring && status.isLoaded && !status.isBuffering && !status.error) {
      if (!status.playing) speech.sawPause = true;
      else if (speech.sawPause) {
        speech.resume = true;
        speech.turn.abort(); // A transport control can play without passing through JavaScript.
      }
    }
    const p = this.prev;
    // The sleep timer, which the page cannot keep while asleep (D182).
    if (this.sleepAt !== null && status.playing && this.now() >= this.sleepAt) {
      this.sleepAt = null;
      this.pause();
    }
    const index = this.trackIndex();
    if (index >= 0 && status.isLoaded && !status.error && !status.didJustFinish) this.progress?.observe({ kind: 'audio', track: index, ms: Math.round(status.currentTime * 1000) }, status.playing, status.playbackRate || this.rate);
    if (status.error && status.error !== p.error) {
      const url = this.currentUrl;
      const failedAt = Number.isFinite(status.currentTime) && status.currentTime > 0
        ? status.currentTime : previousStatus?.isLoaded ? previousStatus.currentTime : status.currentTime;
      const failure = { ...status, currentTime: failedAt };
      if (restoreSpeech !== 'page' && this.playingLocal && url) {
        // The kept copy, not the track (D219): reported, then the same track from the network.
        this.diagnostic({ event: 'native-error', outcome: 'failed', source: 'native-local', recovered: true, ...errorFields(status) });
        return this.recoverFromNetwork(url, failure, restoreSpeech);
      }
      if (restoreSpeech !== 'page' && url && this.tickets?.editionOf(url) && !this.reticketed.has(url)) {
        this.diagnostic({ event: 'native-error', outcome: 'failed', source: 'native-network', recovered: true, ...errorFields(status) });
        return this.reticket(url, failure, restoreSpeech);
      }
      this.diagnostic({ event: 'native-error', outcome: 'failed', source: 'native-network', ...errorFields(status) });
      if (restoreSpeech) return Promise.reject(new Error('Audiobook could not be restored'));
      if (this.car) {
        this.restorePageAfterCarFailure(speech?.resume, this.pendingSeek ?? this.loadingPosition ?? failedAt);
        return;
      }
      this.emit('error', status);
    } else if (!status.error) {
      if (status.isLoaded && status.playing && !status.isBuffering) this.finishCarStart(true);
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

function seekForSpeechRestore(player: AudioPlayer, seconds: number, toleranceMs: number | undefined, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (reached: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(reached);
    };
    const stop = () => finish(false);
    const timer = setTimeout(stop, SPEECH_RESTORE_TIMEOUT_MS);
    signal.addEventListener('abort', stop, { once: true });
    try {
      const seek = toleranceMs === undefined ? player.seekTo(seconds) : player.seekTo(seconds, toleranceMs, toleranceMs);
      void seek.then(() => finish(Math.abs(player.currentTime - seconds) <= SPEECH_EXACT_SEEK_SECONDS)).catch(stop);
    } catch {
      stop();
    }
  });
}

function playSpokenClip(player: AudioPlayer, uri: string, signal: AbortSignal, paused: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      try { player.pause(); }
      finally { finish(new Error('Spoken answer stopped')); }
    };
    const timer = setTimeout(stop, SPEECH_CLIP_TIMEOUT_MS);
    const subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (settled) return;
      if (status.playing) started = true;
      const atEnd = Number.isFinite(status.duration) && status.duration > 0 && status.currentTime >= status.duration;
      if (status.error) finish(new Error('Audio could not play'));
      else if (status.didJustFinish || (started && atEnd)) finish();
      else if (started && status.isLoaded && !status.playing && !status.isBuffering) pauseTimer ??= setTimeout(paused, SPEECH_PAUSE_GRACE_MS);
      else {
        clearTimeout(pauseTimer);
        pauseTimer = undefined;
      }
    });
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pauseTimer);
      signal.removeEventListener('abort', stop);
      subscription.remove();
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener('abort', stop, { once: true });
    try {
      player.replace({ uri });
      player.setPlaybackRate(1, PITCH_QUALITY);
      player.play();
    } catch {
      finish(new Error('Audio could not play'));
    }
  });
}

function isQueue(value: unknown): value is Queue {
  if (!value || typeof value !== 'object') return false;
  const q = value as Partial<Queue>;
  return typeof q.bookId === 'string' && typeof q.editionId === 'string' && typeof q.advance === 'boolean'
    && Array.isArray(q.tracks) && q.tracks.every((t) => !!t && typeof t.url === 'string' && typeof t.title === 'string');
}
