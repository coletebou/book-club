import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AudioLocator,
  type BookDetail,
  type Edition,
  type ReadSpanInput,
  type PartyControlBody,
  type PartyState,
  type NativeAudioDiagnostic,
  projectPosition,
  DRIFT_SEEK_THRESHOLD_S,
  DEFAULT_RATE,
  listeningLabel,
  normalizeRate,
} from '@bookclub/shared';
import { ApiError, api, beaconProgress } from '../lib/api';
import { applyPartyResponse, keys, partyFence, useParty, useSession } from '../lib/queries';
import { followAlongChanged } from './follow-along';
import { PartyDiagnostics } from '../live/party-diagnostics';
import { PartyAudioSync } from './party-sync';
import { partyTransport, type LocalAudioController } from './party-transport';
import { editionCacheName } from '../lib/offline';
import { currentUser, flushOutbox, rememberPosition, saveProgress, saveProgressNow } from '../lib/outbox';
import { savedFromHere } from '../lib/saved-here';
import { realtime, useClubPresence } from '../lib/realtime';
import { tOf } from '../reader/position';
import { chapterAt } from './tracks';
import { type NativeKept, askNativeKept, createNativeAudioElement, installNativeMediaSessionShim, isNativeApp, maxPlayableRate, nativeAudioSource, observedAt } from './native-bridge';
import { chooseBookRate } from './speed-memory';
import { useMediaSession } from './useMediaSession';
import { useNativeQueue } from './useNativeQueue';
import { reportNativeErrors } from './native-error-report';

export interface AudioState {
  readonly book: BookDetail | null;
  readonly edition: Edition | null;
  readonly track: number;
  readonly position: number;
  readonly duration: number;
  readonly playing: boolean;
  /** The rate the engine plays at now: your speed, a party's, or a party's nudged to close a drift. */
  readonly rate: number;
  /**
   * The speed in effect, as chosen (D195): yours for this book, or the party's while you listen
   * together. Never a drift nudge, and never lowered to what this device can play: what to show.
   */
  readonly speed: number;
  readonly buffering: boolean;
  readonly error: string | null;
  readonly sleepUntil: number | null;
  readonly sleepAtTrackEnd: boolean;
  /**
   * During a look (a link followed, a friend's note visited): where you were listening. A look
   * is not listening: it moves no saved place until you press play there.
   */
  readonly returnTo: AudioLocator | null;
  /** The track that last played to its end (and when), for the chapter's and the book's end. */
  readonly ended: { readonly track: number; readonly at: number } | null;
  /**
   * The browser refused to start the audiobook without a tap (D194): set when `play()` is refused
   * as not allowed, cleared once it plays. A page shows one obvious Play while it is set.
   */
  readonly blocked: boolean;
}

export interface AudioController {
  readonly state: AudioState;
  /**
   * Load an edition at a place; `look` makes it a visit, with `returnTo` to come back to. `play`
   * starts it at once, in the caller's own tap (D194): call it from a click handler, so that a
   * browser that plays only on a tap plays it (the track's metadata arrives after the tap is over).
   * The edition already in the player is not loaded again: `play` then plays it where it is.
   * `rate` opens it at that speed (D195).
   */
  load(book: BookDetail, edition: Edition, at: AudioLocator | null, options?: { look?: boolean; returnTo?: AudioLocator | null; play?: boolean; rate?: number }): void;
  /** Go to a place without moving your saved one (until you play there). */
  look(index: number, seconds: number): void;
  /** End a look: back to where you were listening. */
  back(): void;
  /**
   * Your place moved on another device while this one was paused (D70): show it there, saving
   * nothing (it is already saved), so that playing on never puts the old place back.
   */
  catchUp(at: AudioLocator): void;
  /** Save and send where you are now (before opening notes you have just reached). */
  saveNow(): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
  seekBy(delta: number): void;
  setTrack(index: number, seconds?: number, autoplay?: boolean): void;
  /**
   * Play at this speed. A person's own choice (the default) is kept as this book's speed, here and
   * on the server (D195); `temporary` is for a party's speed, applied but not kept as yours,
   * `nudge` for drift correction, which is not a speed anyone chose and is never shown, and
   * `fromDefault` for your default arriving after a book with no speed of its own opened: this
   * book's speed for now, not kept as its own until you choose one.
   */
  setRate(rate: number, options?: { temporary?: boolean; nudge?: boolean; fromDefault?: boolean }): void;
  /**
   * A local interruption (recording or playing a voice note, Cal speaking): pause this device's
   * audiobook and keep party sync from restarting it, without a shared Pause. The returned release
   * (idempotent) ends this hold; when the last one ends, a party player resyncs to the shared clock
   * at once, and a solo player resumes if a hold paused it (unless every such hold said
   * `resumeAlone: false`).
   */
  hold(options?: { resumeAlone?: boolean }): () => void;
  /** Whether any local interruption currently holds the audiobook. */
  readonly held: boolean;
  setSleep(mode: 'off' | 'track' | number): void;
  stop(): void;
  locator(): AudioLocator | null;
  /** Local engine actions: reconciliation/temporary interruptions never issue shared controls. */
  readonly local: LocalAudioController;
  readonly element: HTMLAudioElement | null;
}

const INITIAL: AudioState = {
  book: null,
  edition: null,
  track: 0,
  position: 0,
  duration: 0,
  playing: false,
  rate: DEFAULT_RATE,
  speed: DEFAULT_RATE,
  buffering: false,
  error: null,
  sleepUntil: null,
  sleepAtTrackEnd: false,
  returnTo: null,
  ended: null,
  blocked: false,
};

/** How much of the audiobook lies between two places in it (ms), across tracks. */
function heardMsBetween(edition: Edition, from: AudioLocator, to: AudioLocator): number {
  let ms = to.ms - from.ms;
  for (let i = from.track; i < to.track; i++) ms += edition.tracks[i]?.durationMs ?? 0;
  return Math.max(0, ms);
}

const AudioContext = createContext<AudioController | null>(null);
const AudioStateContext = createContext<AudioState>(INITIAL);
// Button intent is not audibility: a playing party may be locally held or still buffering.
const AudioTransportPlayingContext = createContext(false);

/** Commands of one kind replace each other while queued; different kinds never do. */
type ControlKind = 'playback' | 'seek' | 'rate' | 'settings';
const controlKind = (body: PartyControlBody): ControlKind =>
  body.action === 'play' || body.action === 'pause' || body.action === 'resume' ? 'playback' : body.action;

/**
 * The audiobook engine. One <audio> element for the whole app, so playback continues while you
 * browse the club and keeps going on the lock screen. Media Session handlers are registered once
 * and read live state through refs, so lock-screen buttons never act on stale positions.
 */
export function AudioProvider({ children }: { children: ReactNode }) {
  // Inside the iOS app: a bridged native player stands in for the `<audio>` element below, and
  // for `navigator.mediaSession` (native-bridge.ts), so every line past this one is unchanged.
  const native = isNativeApp();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (native && !audioRef.current) audioRef.current = createNativeAudioElement(installNativeMediaSessionShim());
  const [state, setState] = useState<AudioState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const qc = useQueryClient();
  const session = useSession();
  const partyQuery = useParty(state.book?.id);
  const party = partyQuery.data ?? null;
  const selfId = session.data?.user?.id;
  const joinedParty = party && party.editionId === state.edition?.id && party.members.some((m) => m.userId === selfId) ? party : null;
  const partyRef = useRef<PartyState | null>(joinedParty);
  partyRef.current = joinedParty;
  useClubPresence(joinedParty?.clubId); // Playback keeps its subscription when the page navigates away.
  const diagnosticsRef = useRef<PartyDiagnostics | null>(null);
  const statusAt = useRef(Date.now());
  const sharedRequest = useRef(false);
  const partyGeneration = useRef(0);
  const partyCommandRef = useRef<((body: PartyControlBody) => Promise<void>) | null>(null);
  const inflightControl = useRef<PartyControlBody | null>(null);
  const queuedControls = useRef(new Map<ControlKind, PartyControlBody>());
  const intendedPlaying = useCallback((): boolean | null => {
    const inflight = inflightControl.current;
    const latest = queuedControls.current.get('playback') ?? (inflight && controlKind(inflight) === 'playback' ? inflight : null);
    return latest ? latest.action !== 'pause' : null;
  }, []);
  const controlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncRef = useRef(new PartyAudioSync());
  const holds = useRef(0);
  /** Set when a hold paused a playing solo player: the edition to resume once every hold ends. */
  const resumeAfterHold = useRef<string | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const autoplayNext = useRef(false);
  const heardFrom = useRef<AudioLocator | null>(null);
  const spans = useRef<ReadSpanInput[]>([]);
  const lastReport = useRef(0);
  const lastAnnounce = useRef(0);
  const looking = useRef(false);
  const prefetched = useRef(new Set<string>());
  /** Your own speed for the book loaded (D195): what a party's speed gives way to when it ends. */
  const chosenRate = useRef(DEFAULT_RATE);

  /**
   * Keep the next track on the device while this one plays (v1 cached audio as it went): it then
   * plays from the cache, even with no signal on the train. Skipped when the browser asks to save
   * data; a full cache is simply not used.
   */
  const prefetch = useCallback((edition: Edition, index: number) => {
    const track = edition.tracks[index];
    if (!track || prefetched.current.has(track.url) || !('caches' in window)) return;
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    prefetched.current.add(track.url);
    void (async () => {
      try {
        const cache = await caches.open(editionCacheName(edition.id));
        if (await cache.match(track.url)) return;
        const res = await fetch(track.url, { credentials: 'same-origin' });
        if (res.ok) await cache.put(track.url, res);
      } catch {
        prefetched.current.delete(track.url);
      }
    })();
  }, []);

  const patch = useCallback((p: Partial<AudioState>) => setState((s) => ({ ...s, ...p })), []);

  const currentLocator = useCallback((): AudioLocator | null => {
    const a = audioRef.current;
    const s = stateRef.current;
    if (!a || !s.edition) return null;
    // A track still loading is at the place it is about to seek to, not at its start: started in a
    // tap before its metadata came (D194), the time heard from is that place.
    const seconds = pendingSeek.current ?? a.currentTime;
    // The page's own track, never the element's source: inside the iOS app native says it went on
    // (`advanced`, the next track's source) just before the finished track's `ended`, whose time is
    // that track's end (D181).
    return { kind: 'audio', track: s.track, ms: Math.round(seconds * 1000) };
  }, []);

  /**
   * When the place `currentLocator` gives was where the player was (D196): now, for a browser's
   * element and a place still loading; inside the iOS app, when native last said where it was, so a
   * report of a place heard long ago (native's status, delivered once the page woke) is saved as that
   * old, and never outranks the place native saved itself while the page slept.
   */
  const placeObservedAt = useCallback((): number => {
    const a = audioRef.current;
    return a && pendingSeek.current === null ? observedAt(a) : Date.now();
  }, []);

  /** Tell the club where you are listening now, or, paused, that you are just around. */
  const announce = useCallback(
    (now: AudioLocator | null = currentLocator()) => {
      const s = stateRef.current;
      if (!s.book || !s.edition || !now) return;
      const playing = !!audioRef.current && !audioRef.current.paused && !audioRef.current.ended;
      // The recording's announcement before a chapter is that chapter's, not the end of the last.
      const label = listeningLabel(s.book.chapters, tOf(s.edition, now), chapterAt(s.edition, now.track, now.ms));
      realtime()?.setReading(playing ? { bookId: s.book.id, editionId: s.edition.id, locator: now, label } : null, { audible: true });
    },
    [currentLocator],
  );

  /** Close the span heard since `heardFrom` and send progress (saved locally first). */
  const report = useCallback(
    (opts: { restart?: AudioLocator | null; beacon?: boolean } = {}): Promise<void> => {
      const s = stateRef.current;
      const now = currentLocator();
      if (!s.book || !s.edition || !now) return Promise.resolve();
      const nowAt = placeObservedAt();
      const from = heardFrom.current;
      if (from && (from.track < now.track || (from.track === now.track && from.ms < now.ms))) {
        // When it was heard, for your own history (D191): it ended now, and lasted as long as it played at this speed.
        const at = Date.now();
        spans.current.push({ from, to: now, since: Math.round(at - heardMsBetween(s.edition, from, now) / (audioRef.current?.playbackRate || 1)), at });
      }
      heardFrom.current = opts.restart === undefined ? now : opts.restart;
      announce(now);
      if (looking.current) {
        spans.current = [];
        lastReport.current = Date.now();
        return Promise.resolve();
      }
      lastReport.current = Date.now();
      // Inside the iOS app, with the page hidden, native saves the place itself (D182): what this
      // page hears then is native's word from a while ago, delivered late, and saving it here would
      // only race native's own saves. Kept for the next save once the page is back; the moment it
      // goes (the beacon below) is the last word this page has, and is saved.
      if (native && !opts.beacon && document.visibilityState === 'hidden') return Promise.resolve();
      const payload = { bookId: s.book.id, editionId: s.edition.id, locator: now, at: nowAt, spans: spans.current };
      spans.current = [];
      savedFromHere(s.book.id, tOf(s.edition, now));
      if (!opts.beacon) return saveProgress(payload);
      // The page is going (hidden, closed): kept at once on the device as well, before anything
      // that may not finish (D196, as the reader does: lib/outbox.ts saveProgressNow), and sent.
      saveProgressNow(payload);
      beaconProgress(s.book.id, { editionId: payload.editionId, locator: now, readSpans: payload.spans, at: payload.at });
      return Promise.resolve();
    },
    [announce, currentLocator, placeObservedAt, native],
  );

  /** A place moved to while paused (a scrub, a skip, a chapter): saved once the moving stops (D196). */
  const pausedMove = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePausedPlace = useCallback(() => {
    if (pausedMove.current) clearTimeout(pausedMove.current);
    pausedMove.current = setTimeout(() => {
      pausedMove.current = null;
      const a = audioRef.current;
      if (a?.paused && stateRef.current.edition) void report({ restart: null });
    }, 400);
  }, [report]);

  /** Play, saying so when the browser refuses for want of a tap (D194); any other refusal (a newer source, a pause) is not news. */
  const startNow = useCallback(
    (a: HTMLAudioElement) => {
      void a.play().catch((err: unknown) => {
        if (err instanceof Error && err.name === 'NotAllowedError') patch({ blocked: true });
      });
    },
    [patch],
  );

  const loadTrack = useCallback((index: number, seconds: number, autoplay: boolean) => {
    const a = audioRef.current;
    const s = stateRef.current;
    const track = s.edition?.tracks[index];
    if (!a || !track) return;
    pendingSeek.current = seconds;
    // The place is this track's from now on, before React renders it: a play started in this same
    // tap (D194) counts what is heard from here, not from the track before.
    stateRef.current = { ...stateRef.current, track: index, position: seconds };
    autoplayNext.current = autoplay && holds.current === 0;
    if (!a.src.endsWith(track.url)) {
      a.src = track.url;
      a.load();
      // Started now, not when its metadata comes: called from a tap, this is the call the browser
      // lets play (D194). The seek to `seconds` still waits for the metadata, which comes before
      // any sound does; the metadata's own `play()` below is then a no-op.
      if (autoplayNext.current) startNow(a);
    } else if (a.readyState >= 1) {
      a.currentTime = seconds;
      pendingSeek.current = null;
      if (autoplayNext.current) startNow(a);
    }
    patch({ track: index, position: seconds, duration: track.durationMs / 1000, error: null });
  }, [patch, startNow]);

  // Element events.
  useEffect(() => {
    const a = audioRef.current!;
    const onMeta = () => {
      if (pendingSeek.current !== null) {
        a.currentTime = Math.min(pendingSeek.current, a.duration || pendingSeek.current);
        pendingSeek.current = null;
      }
      a.playbackRate = stateRef.current.rate;
      patch({ duration: a.duration || stateRef.current.duration });
      if (autoplayNext.current) {
        autoplayNext.current = false;
        void a.play().catch(() => undefined);
      }
    };
    const onTime = () => {
      statusAt.current = Date.now();
      patch({ position: a.currentTime });
      // Friends see a listener move every second; the place is saved every five.
      if (!a.paused && Date.now() - lastReport.current > 5000) void report();
      else if (!a.paused && Date.now() - lastAnnounce.current >= 1000) {
        lastAnnounce.current = Date.now();
        announce();
      }
      const playing = stateRef.current;
      if (!a.paused && playing.edition && a.currentTime > 20) prefetch(playing.edition, playing.track + 1);
      const s = stateRef.current;
      if (s.sleepUntil && Date.now() >= s.sleepUntil) {
        a.pause();
        patch({ sleepUntil: null });
      }
    };
    const onPlay = () => {
      // A native Play already in flight (or hardware play) must not defeat a local hold.
      if (holds.current > 0) {
        autoplayNext.current = false;
        a.pause();
        patch({ playing: false, buffering: false });
        return;
      }
      // Playing where a look took you is listening there: it becomes your place.
      if (looking.current) {
        looking.current = false;
        patch({ returnTo: null });
      }
      patch({ playing: true, blocked: false });
      heardFrom.current = currentLocator();
      lastReport.current = Date.now();
      // Friends see you start listening at once, not at the next progress report.
      announce();
    };
    const onPause = () => {
      patch({ playing: false, buffering: false });
      void report({ restart: null });
    };
    const onEnded = () => {
      const s = stateRef.current;
      const saved = report({ restart: null });
      const last = !!s.edition && s.track + 1 >= s.edition.tracks.length;
      const ended = { track: s.track, at: Date.now() };
      const p = partyRef.current;
      const atSharedEnd = p?.playing && p.track === s.track && projectPosition(p, Date.now()) >= s.duration - DRIFT_SEEK_THRESHOLD_S;
      const endCondition = p?.clockRevision !== undefined ? { expectedClockRevision: p.clockRevision } : {};
      // The book's last track: send it first, so the server can say whether that finished it.
      if (last) void saved.then(() => flushOutbox()).then(() => patch({ ended }));
      else patch({ ended });
      if (s.sleepAtTrackEnd) {
        // Stop here, with the next chapter ready: Play goes on, never replays the one just heard.
        patch({ sleepAtTrackEnd: false, playing: false });
        if (s.edition && s.track + 1 < s.edition.tracks.length) loadTrack(s.track + 1, 0, false);
        return;
      }
      // Load the next track from the ended handler: keeps background playback alive on iOS.
      if (s.edition && s.track + 1 < s.edition.tracks.length) {
        const next = s.edition.tracks[s.track + 1]!;
        if (!partyRef.current && a.src.endsWith(next.url)) {
          // The iOS app's player already went on to it by itself, while this page slept (D181):
          // follow it there (its own reports say how far it has got) rather than load it again.
          stateRef.current = { ...stateRef.current, track: s.track + 1 };
          patch({ track: s.track + 1, position: 0, duration: next.durationMs / 1000, error: null });
          return;
        }
        if (partyRef.current) {
          if (atSharedEnd) void partyCommandRef.current?.({ action: 'seek', track: s.track + 1, position: 0, fromTrack: s.track, ...endCondition });
        }
        else loadTrack(s.track + 1, 0, true);
      }
      else {
        if (atSharedEnd) void partyCommandRef.current?.({ action: 'pause', ...endCondition });
        patch({ playing: false });
      }
    };
    const onWaiting = () => patch({ buffering: true });
    const onPlaying = () => {
      if (holds.current > 0 && !a.paused) onPlay();
      else patch({ buffering: false, playing: !a.paused });
    };
    // Some engines change `paused` without a pause event (WebKit on a new source fires only
    // "emptied"): the UI follows the element itself, never just the events it expects.
    const sync = () => patch({ playing: !a.paused && !a.ended });
    const onError = () => patch({ error: 'This track could not be played.', playing: false, buffering: false });
    const onRate = () => patch({ rate: a.playbackRate });
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnded);
    a.addEventListener('waiting', onWaiting);
    a.addEventListener('playing', onPlaying);
    a.addEventListener('error', onError);
    a.addEventListener('ratechange', onRate);
    for (const e of ['emptied', 'loadstart', 'loadedmetadata', 'canplay', 'stalled', 'suspend'] as const) a.addEventListener(e, sync);
    return () => {
      for (const e of ['emptied', 'loadstart', 'loadedmetadata', 'canplay', 'stalled', 'suspend'] as const) a.removeEventListener(e, sync);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('waiting', onWaiting);
      a.removeEventListener('playing', onPlaying);
      a.removeEventListener('error', onError);
      a.removeEventListener('ratechange', onRate);
    };
  }, [patch, report, announce, loadTrack, currentLocator, prefetch]);

  // Progress when the app goes to the background or closes.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && stateRef.current.edition) void report({ beacon: true });
      // Back from the background inside the iOS app: what native said while the page slept may
      // still be arriving, oldest first; the next save from here waits its five seconds (D196).
      else if (document.visibilityState === 'visible' && native) lastReport.current = Date.now();
    };
    const onPageHide = () => {
      if (stateRef.current.edition) void report({ beacon: true });
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [report, native]);

  // Inside the iOS app: the place native kept on the device (D196), the newest it heard, perhaps
  // while this page slept and then the app was closed, or with no network for its own save. Asked
  // for once the page knows whose it is, and taken as any save made on this device: newest wins.
  useEffect(() => {
    const el = audioRef.current;
    if (!native || !el || !selfId) return;
    const onKept = (event: Event) => {
      const kept = (event as CustomEvent<NativeKept | null>).detail;
      if (!kept || kept.userId !== selfId || currentUser() !== selfId) return;
      void rememberPosition({ bookId: kept.bookId, editionId: kept.editionId, locator: kept.locator, at: kept.at, userId: kept.userId });
      void saveProgress({ bookId: kept.bookId, editionId: kept.editionId, locator: kept.locator, at: kept.at, spans: kept.spans });
    };
    el.addEventListener('native-kept', onKept);
    askNativeKept(el);
    return () => el.removeEventListener('native-kept', onKept);
  }, [native, selfId]);

  const controller = useMemo<AudioController>(() => {
    const a = () => audioRef.current;
    const ctl: Omit<AudioController, 'local'> = {
      get state() {
        return stateRef.current;
      },
      get element() {
        return audioRef.current;
      },
      load(book, edition, at, options = {}) {
        const s = stateRef.current;
        if (s.edition?.id === edition.id && s.book) {
          patch({ book, edition });
          if (options.play && a()?.paused) void ctl.play();
          return;
        }
        if (s.edition) void report({ restart: null });
        a()?.pause();
        looking.current = !!options.look;
        // The book's own speed (D195), applied before its first track loads: the element takes
        // `state.rate` once that track's metadata is in (a new source resets an element's rate).
        const speed = normalizeRate(options.rate ?? chosenRate.current);
        chosenRate.current = speed;
        const rate = Math.min(speed, maxPlayableRate());
        stateRef.current = { ...stateRef.current, book, edition, rate, speed };
        patch({ book, edition, rate, speed, track: at?.track ?? 0, position: (at?.ms ?? 0) / 1000, playing: false, error: null, returnTo: options.look ? (options.returnTo ?? null) : null });
        heardFrom.current = null;
        loadTrack(at?.track ?? 0, (at?.ms ?? 0) / 1000, !!options.play);
      },
      look(index, seconds) {
        const el = a();
        if (!looking.current) {
          void report({ restart: null });
          looking.current = true;
          patch({ returnTo: currentLocator() });
        }
        el?.pause();
        heardFrom.current = null;
        loadTrack(index, seconds, false);
      },
      async saveNow() {
        await report();
        await flushOutbox();
      },
      back() {
        const to = stateRef.current.returnTo;
        looking.current = false;
        patch({ returnTo: null });
        if (to) loadTrack(to.track, to.ms / 1000, false);
      },
      catchUp(at) {
        if (!a()?.paused) return;
        looking.current = false;
        spans.current = [];
        heardFrom.current = null;
        patch({ returnTo: null });
        loadTrack(at.track, at.ms / 1000, false);
      },
      async play() {
        const el = a();
        if (!el || holds.current > 0) return;
        try {
          await el.play();
        } catch (err) {
          patch({ error: 'Tap play to start listening.', ...(err instanceof Error && err.name === 'NotAllowedError' ? { blocked: true } : {}) });
        }
      },
      pause() {
        // A pause while the next track is loading must win over its pending autoplay.
        autoplayNext.current = false;
        a()?.pause();
        patch({ playing: false, buffering: false });
      },
      toggle() {
        const el = a();
        if (!el) return;
        if (el.paused && !autoplayNext.current) void ctl.play();
        else ctl.pause();
      },
      seek(seconds) {
        const el = a();
        if (!el) return;
        void report({ restart: null });
        if (el.readyState < 1) {
          // The track is still loading: seek as soon as its metadata arrives.
          pendingSeek.current = Math.max(0, seconds);
          patch({ position: pendingSeek.current });
          return;
        }
        el.currentTime = Math.max(0, Math.min(seconds, el.duration || seconds));
        // The newest seek wins over a track's start position whose metadata event is still queued
        // (tap a chapter, then scrub at once: the chapter's start must not undo the scrub).
        pendingSeek.current = null;
        heardFrom.current = el.paused ? null : currentLocator();
        patch({ position: el.currentTime });
        if (el.paused) savePausedPlace();
      },
      seekBy(delta) {
        const el = a();
        const s = stateRef.current;
        if (!el || !s.edition) return;
        const target = el.currentTime + delta;
        if (target < 0 && s.track > 0) {
          const prev = s.edition.tracks[s.track - 1]!;
          void report({ restart: null });
          const play = !el.paused;
          loadTrack(s.track - 1, Math.max(0, prev.durationMs / 1000 + target), play);
          if (!play) savePausedPlace();
          return;
        }
        if (el.duration && target > el.duration && s.track + 1 < s.edition.tracks.length) {
          void report({ restart: null });
          const play = !el.paused;
          loadTrack(s.track + 1, target - el.duration, play);
          if (!play) savePausedPlace();
          return;
        }
        ctl.seek(target);
      },
      setTrack(index, seconds = 0, autoplay) {
        const el = a();
        void report({ restart: null });
        const play = autoplay ?? !(el?.paused ?? true);
        loadTrack(index, seconds, play);
        if (!play) savePausedPlace();
      },
      setRate(rate, options) {
        const el = a();
        // A nudge is the party's speed a hair off (D156), not a step: played exactly as asked.
        const speed = options?.nudge ? stateRef.current.speed : normalizeRate(rate);
        const playable = Math.min(options?.nudge ? rate : speed, maxPlayableRate());
        if (el) el.playbackRate = playable;
        if (!options?.temporary && !options?.nudge) {
          chosenRate.current = speed;
          const bookId = stateRef.current.book?.id;
          if (bookId && !options?.fromDefault) void chooseBookRate(selfId, bookId, speed);
        }
        stateRef.current = { ...stateRef.current, rate: playable, speed };
        patch({ rate: playable, speed });
      },
      get held() {
        return holds.current > 0;
      },
      hold(options = {}) {
        const el = a();
        const s = stateRef.current;
        holds.current++;
        // A track still loading to autoplay counts as playing: the hold must win over that too.
        if (s.playing || (!!el && !el.paused) || autoplayNext.current) {
          if (!partyRef.current && options.resumeAlone !== false && s.edition) resumeAfterHold.current = s.edition.id;
          ctl.pause();
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          holds.current = Math.max(0, holds.current - 1);
          if (holds.current > 0) return;
          const resume = resumeAfterHold.current;
          resumeAfterHold.current = null;
          const p = partyRef.current;
          // In a party the shared clock decides: seek to where everyone is now, playing or not.
          if (p) syncRef.current.apply(p, ctl, (event) => diagnosticsRef.current?.record(event), statusAt.current);
          else if (resume && resume === stateRef.current.edition?.id) void ctl.play();
        };
      },
      setSleep(mode) {
        if (mode === 'off') patch({ sleepUntil: null, sleepAtTrackEnd: false });
        else if (mode === 'track') patch({ sleepUntil: null, sleepAtTrackEnd: true });
        else patch({ sleepUntil: Date.now() + mode * 60_000, sleepAtTrackEnd: false });
      },
      stop() {
        void report({ restart: null });
        const el = a();
        el?.pause();
        if (el) {
          el.removeAttribute('src');
          el.load();
        }
        realtime()?.setReading(null);
        looking.current = false;
        prefetched.current.clear();
        // The lock screen is cleared by useMediaSession once no edition is loaded.
        patch({ ...INITIAL, rate: stateRef.current.rate, speed: stateRef.current.speed });
      },
      locator: currentLocator,
    };
    const queue = queuedControls.current;
    const sendShared = async (body: PartyControlBody): Promise<void> => {
      const p = partyRef.current;
      if (!p) {
        queue.clear();
        return;
      }
      const log = diagnosticsRef.current;
      if (sharedRequest.current || controlTimer.current) {
        // Keep the latest trailing intent of each kind, not a growing request queue: Pause wins
        // over a Play already in flight, a scrub queued beside it is kept, and the final scrub
        // position is never silently discarded. An automatic (conditional) end command never
        // replaces a person's own queued command of the same kind.
        const kind = controlKind(body);
        const queued = queue.get(kind);
        if (body.expectedClockRevision === undefined || !queued || queued.expectedClockRevision !== undefined) {
          queue.delete(kind); // Re-inserted last: trailing commands go out in the order last chosen.
          const inflight = inflightControl.current;
          // Back to exactly what is already in flight (Play, Pause, Play): cancel, don't repeat it.
          const repeat = kind === 'playback' && body.expectedClockRevision === undefined && inflight?.action === body.action && inflight.expectedClockRevision === undefined;
          if (!repeat) queue.set(kind, body);
        }
        log?.record({ event: 'control-result', action: body.action, outcome: 'superseded' });
        patch({}); // Publish button intent before any player/hub event arrives.
        return;
      }
      if (p.settings.hostOnlyControls && p.hostId !== selfId) {
        queue.clear();
        patch({ error: 'Only the host controls this party.' });
        log?.record({ event: 'control-result', action: body.action, outcome: 'blocked' });
        return; // Never fall back to a local action the sync loop would undo.
      }
      const generation = partyGeneration.current;
      sharedRequest.current = true;
      inflightControl.current = body;
      patch({});
      const started = Date.now();
      let allowTrailing = true;
      let trailingDelay = 150;
      log?.record({ event: 'control-request', action: body.action });
      try {
        const fence = partyFence(qc, p.bookId);
        const next = await api.partyControl(p.bookId, { ...body, ...(p.partyId ? { partyId: p.partyId } : {}) });
        // The person chose this speed and the party took it: keep it as their speed for this book
        // (D195) even if a newer state (someone else's command) wins the cache below. Sync nudges
        // never get here.
        if (body.action === 'rate') {
          chosenRate.current = normalizeRate(body.rate);
          void chooseBookRate(selfId, p.bookId, chosenRate.current);
        }
        // Check the actual cache as well as render refs: a hub end/leave can arrive before
        // React has rendered it, and a late HTTP response must not resurrect that party.
        const current = qc.getQueryData<PartyState | null>(keys.party(p.bookId));
        if (current?.partyId === p.partyId && current?.members.some((m) => m.userId === selfId) && partyRef.current?.bookId === p.bookId && partyRef.current.editionId === p.editionId && partyRef.current.partyId === p.partyId && generation === partyGeneration.current) {
          if (applyPartyResponse(qc, p.bookId, fence, next)) {
            partyRef.current = next;
            if (body.action === 'rate') ctl.setRate(body.rate, { temporary: true }); // Applied now; already saved above.
          }
          patch({ error: null });
        }
        log?.record({ event: 'control-result', action: body.action, outcome: 'ok', durationMs: Date.now() - started });
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        if (status >= 400 && status < 500) {
          if (status === 429) trailingDelay = 60_000;
          else allowTrailing = false; // Definitive refusal: do not replay another command.
        }
        // Timeout/network/5xx is uncertain: the first command may have reached the server,
        // so a trailing Pause must still be attempted, once, in the same participation.
        if (generation === partyGeneration.current && partyRef.current?.bookId === p.bookId && partyRef.current.partyId === p.partyId) patch({ error: 'The party could not be controlled. Check your connection and try again.' });
        log?.record({ event: 'control-result', action: body.action, outcome: 'failed', durationMs: Date.now() - started });
      } finally {
        if (generation === partyGeneration.current) {
          sharedRequest.current = false;
          inflightControl.current = null;
          if (allowTrailing && queue.size > 0 && diagnosticsRef.current === log && partyRef.current?.bookId === p.bookId) {
            controlTimer.current = setTimeout(() => {
              controlTimer.current = null;
              const [first] = queue;
              if (!first) return;
              queue.delete(first[0]);
              if (diagnosticsRef.current === log && partyRef.current?.bookId === p.bookId) void sendShared(first[1]);
              else queue.clear();
            }, trailingDelay);
          } else queue.clear();
          patch({}); // Completion/refusal clears optimistic button intent too.
        }
      }
    };
    partyCommandRef.current = sendShared;
    const shared = partyTransport(ctl, () => partyRef.current, sendShared, intendedPlaying);
    return { ...ctl, ...shared, get state() { return stateRef.current; }, get element() { return audioRef.current; }, get held() { return holds.current > 0; }, local: ctl };
  }, [patch, report, loadTrack, currentLocator, qc, selfId, intendedPlaying, savePausedPlace]);

  // Diagnostics exist only during this participation, with no durable device id or offline outbox.
  const partyBookId = joinedParty?.bookId;
  const partyEditionId = joinedParty?.editionId;
  const partyInstanceId = joinedParty?.partyId;
  useEffect(() => {
    if (!partyBookId || !partyEditionId || !selfId) return;
    const generation = ++partyGeneration.current;
    const queue = queuedControls.current;
    sharedRequest.current = false;
    syncRef.current = new PartyAudioSync();
    const log = new PartyDiagnostics((body) => api.partyDiagnostics(partyBookId, body), partyInstanceId);
    diagnosticsRef.current = log;
    log.start();
    log.record({ event: 'joined', platform: native ? 'native' : 'web', source: native ? nativeAudioSource(audioRef.current!) : 'browser-unknown' });
    const el = audioRef.current!;
    const types = ['loadstart', 'loadedmetadata', 'waiting', 'stalled', 'playing', 'play', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied'] as const;
    const media = (event: Event) => {
      log.record({ event: 'media', mediaEvent: event.type as typeof types[number], track: stateRef.current.track, position: el.currentTime, playing: !el.paused, readyState: el.readyState, visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible' });
    };
    const diagnostic = (event: Event) => log.record({ ...(event as CustomEvent<NativeAudioDiagnostic>).detail, track: stateRef.current.track });
    for (const type of types) el.addEventListener(type, media);
    el.addEventListener('native-diagnostic', diagnostic);
    return () => {
      for (const type of types) el.removeEventListener(type, media);
      el.removeEventListener('native-diagnostic', diagnostic);
      log.stop();
      partyGeneration.current = generation + 1;
      sharedRequest.current = false;
      inflightControl.current = null;
      queue.clear();
      if (controlTimer.current) clearTimeout(controlTimer.current);
      controlTimer.current = null;
      if (diagnosticsRef.current === log) diagnosticsRef.current = null;
      // The party's speed was the party's: back to your own for this book (D195).
      controller.local.setRate(chosenRate.current, { temporary: true });
    };
  }, [partyBookId, partyEditionId, partyInstanceId, selfId, native, controller]);

  // The iOS app's playback errors while no party is (D207); a party's own log has them otherwise.
  const reportingBookId = state.book?.id;
  useEffect(() => {
    if (!native || !reportingBookId || partyBookId) return;
    return reportNativeErrors(audioRef.current!, () => stateRef.current.track, (body) => api.partyDiagnostics(reportingBookId, body));
  }, [native, reportingBookId, partyBookId]);

  // Cache availability is evidence, not proof of which response a browser actually used.
  useEffect(() => {
    if (!partyBookId || native) return;
    const track = state.edition?.tracks[state.track];
    const log = diagnosticsRef.current;
    if (!track || !log) return;
    let active = true;
    void (async () => {
      let source: 'browser-cache-available' | 'browser-network' | 'browser-unknown' = 'browser-unknown';
      try {
        if ('caches' in window && navigator.serviceWorker?.controller) {
          const cache = await caches.open(editionCacheName(partyEditionId!));
          source = await cache.match(track.url) ? 'browser-cache-available' : 'browser-network';
        }
      } catch { /* unavailable cache: keep the honest unknown */ }
      if (active) log.record({ event: 'source', source, track: state.track });
    })();
    return () => { active = false; };
  }, [partyBookId, partyEditionId, native, state.track, state.edition]);

  const syncNow = useCallback(() => {
    const p = partyRef.current;
    if (p) syncRef.current.apply(p, controller.local, (event) => diagnosticsRef.current?.record(event), statusAt.current);
  }, [controller]);
  useEffect(() => {
    if (!partyBookId) return;
    syncNow(); // Shared controls apply as soon as state arrives, not up to a second later.
    const id = setInterval(syncNow, 1000);
    return () => clearInterval(id);
  }, [partyBookId, partyInstanceId, syncNow]);
  useEffect(() => {
    if (partyBookId) syncNow();
  }, [partyBookId, joinedParty?.updatedAt, joinedParty?.track, joinedParty?.playing, joinedParty?.rate, syncNow]);

  // Forced alignment finishing while this edition is already in the player (D46): book:changed
  // refreshes book detail, but load() is not called again (ListenPage / the reader keep the
  // playing edition). Patch book+edition in place so pages follow the new sync without a relaunch.
  const loadedBookId = state.book?.id;
  const bookDetail = useQuery({
    queryKey: keys.book(loadedBookId ?? ''),
    queryFn: () => api.book(loadedBookId!),
    enabled: !!loadedBookId,
  });
  useEffect(() => {
    const fresh = bookDetail.data;
    const s = stateRef.current;
    if (!fresh || !s.book || !s.edition || fresh.id !== s.book.id) return;
    const next = fresh.editions.find((e) => e.id === s.edition!.id);
    if (!next || !followAlongChanged(s.edition, next)) return;
    patch({ book: fresh, edition: next });
  }, [bookDetail.data, bookDetail.dataUpdatedAt, patch]);

  // Media Session: the lock screen, Control Center, headphones, a watch or a car (D64, D190).
  useMediaSession(controller, state, audioRef);

  // Inside the iOS app: what native may play on by itself while this page sleeps (D181).
  useNativeQueue(audioRef, state, !!joinedParty, selfId);

  return (
    <AudioContext.Provider value={controller}>
      <AudioTransportPlayingContext.Provider value={joinedParty ? (intendedPlaying() ?? joinedParty.playing) : state.playing}>
        <AudioStateContext.Provider value={state}>{children}</AudioStateContext.Provider>
      </AudioTransportPlayingContext.Provider>
      {/*
        The one audio element. Not inside the routes, so navigation never stops playback. Inside
        the iOS app `audioRef.current` already holds the bridged native player (set above, before
        this first renders): nothing here would replace it, but rendering it too would, once
        committed, hand its ref callback the DOM node instead.
      */}
      {!native && <audio ref={audioRef} preload="metadata" data-testid="audio-element" aria-hidden="true" />}
    </AudioContext.Provider>
  );
}

/** The stable controller (play, seek, …). */
export function useAudio(): AudioController {
  const ctl = useContext(AudioContext);
  if (!ctl) throw new Error('useAudio outside AudioProvider');
  return ctl;
}

/**
 * `useAudio`, but `null` outside an `AudioProvider` instead of throwing: for a component (a note's
 * media player, player/pauseWhile.ts) that is harmless without the real audiobook player around
 * it — a unit test rendering it alone, say — and should simply do nothing to pause, rather than
 * require every such test to wrap itself in the one app-wide player.
 */
export function useAudioMaybe(): AudioController | null {
  return useContext(AudioContext);
}

/** Live player state; components using it re-render as playback moves. */
export function useAudioState(): AudioState {
  return useContext(AudioStateContext);
}

/** The state toggled by transport buttons; useAudioState().playing remains actual local playback. */
export function useAudioTransportPlaying(): boolean {
  return useContext(AudioTransportPlayingContext);
}
