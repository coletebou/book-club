import { type RefObject, useEffect } from 'react';
import { SKIP_BACK_SECONDS, SKIP_FORWARD_SECONDS } from '@bookclub/shared';
import { isIos } from '../components/InstallHint';
import { lockScreenActions } from './media';
import { chapterStep, chapterStops, nowPlayingMetadata, positionStateOf } from './now-playing';
import { chapterNamedAt } from './tracks';
import type { AudioController, AudioState } from './AudioProvider';

/** Element events after which the lock screen's scrubber and play state are told again. */
const POSITION_EVENTS = ['loadedmetadata', 'durationchange', 'play', 'playing', 'pause', 'waiting', 'seeked', 'ratechange', 'ended', 'emptied'] as const;

/** While playing, the scrubber is told again this often too (the system extrapolates in between). */
const POSITION_REFRESH_MS = 10_000;

/**
 * The Media Session (D64, D190): the lock screen, Control Center, headphones, a watch or a car.
 * Inside the iOS app `navigator.mediaSession` is the native bridge's stand-in (native-bridge.ts),
 * so this same code tells native what to show.
 *
 * - Handlers are registered once, for the app's life, and read live state through the controller:
 *   a track change, a chapter change or a new source never drops them, and a button never acts on
 *   a stale place.
 * - The scrubber is set from the element itself on every event that moves it (a seek, a speed
 *   change, play, pause, a new track), never from a rounded copy once a second.
 * - The previous and next buttons are the chapters (chapterStep), not the files.
 */
export function useMediaSession(controller: AudioController, state: AudioState, audioRef: RefObject<HTMLAudioElement | null>): void {
  // Handlers: registered once, reading live state.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const step = (direction: 1 | -1) => {
      const s = controller.state;
      const el = audioRef.current;
      if (!s.book || !s.edition || !el) return;
      const to = chapterStep(chapterStops(s.edition, s.book.chapters), { track: s.track, ms: el.currentTime * 1000 }, direction);
      if (to) controller.setTrack(to.track, to.ms / 1000);
    };
    const all: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => void controller.play()],
      ['pause', () => controller.pause()],
      ['stop', () => controller.pause()],
      ['seekbackward', (d) => controller.seekBy(-(d.seekOffset ?? SKIP_BACK_SECONDS))],
      ['seekforward', (d) => controller.seekBy(d.seekOffset ?? SKIP_FORWARD_SECONDS)],
      ['seekto', (d) => {
        if (typeof d.seekTime !== 'number' || !Number.isFinite(d.seekTime)) return;
        const el = audioRef.current;
        // A drag on the lock screen sends many: the quick, approximate seek while dragging.
        if (d.fastSeek && el && typeof el.fastSeek === 'function' && el.readyState >= 1) el.fastSeek(Math.max(0, d.seekTime));
        else controller.seek(d.seekTime);
      }],
      ['previoustrack', () => step(-1)],
      ['nexttrack', () => step(1)],
    ];
    const offered = new Set(lockScreenActions(isIos(navigator.userAgent, navigator.maxTouchPoints)));
    const handlers = all.filter(([action]) => offered.has(action));
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // action not supported by this browser
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [controller, audioRef]);

  // Metadata: the chapter playing (a file may hold several, FR152); none once the player stops.
  const chapterIndex = state.edition ? chapterNamedAt(state.edition, state.track, state.position * 1000) : null;
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!state.book || !state.edition) {
      ms.metadata = null;
      ms.playbackState = 'none';
      try {
        ms.setPositionState?.();
      } catch {
        // an engine that cannot clear it
      }
      return;
    }
    ms.metadata = new MediaMetadata(nowPlayingMetadata(state.book, state.edition, state.track, chapterIndex, location.href));
  }, [state.book, state.edition, state.track, chapterIndex]);

  // The scrubber and the play state, from the element itself, on every event that moves them.
  const loaded = !!state.edition;
  useEffect(() => {
    const el = audioRef.current;
    if (!('mediaSession' in navigator) || !el || !loaded) return;
    const ms = navigator.mediaSession;
    const tell = () => {
      ms.playbackState = !el.paused && !el.ended ? 'playing' : 'paused';
      const position = positionStateOf(el);
      if (!position || !ms.setPositionState) return;
      try {
        ms.setPositionState(position);
      } catch {
        // a position the engine refuses while a track loads
      }
    };
    let last = 0;
    const onTime = () => {
      if (!el.paused && Date.now() - last >= POSITION_REFRESH_MS) {
        last = Date.now();
        tell();
      }
    };
    const onEvent = () => {
      last = Date.now();
      tell();
    };
    tell();
    for (const type of POSITION_EVENTS) el.addEventListener(type, onEvent);
    el.addEventListener('timeupdate', onTime);
    return () => {
      for (const type of POSITION_EVENTS) el.removeEventListener(type, onEvent);
      el.removeEventListener('timeupdate', onTime);
    };
  }, [audioRef, loaded]);
}
