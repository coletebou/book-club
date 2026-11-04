/** A moment of listening: the place on the shared timeline, how far into the audiobook, and when. */
export interface Heard {
  readonly t: number;
  /** Into the whole audiobook, across its tracks. */
  readonly ms: number;
  /** The clock (performance.now()). */
  readonly at: number;
  readonly track: number;
}

/** What the player shows at one moment. */
export interface PlayerMoment extends Heard {
  readonly playing: boolean;
  /** Within the last half second of its track: where it stops by itself at the track's end. */
  readonly atTrackEnd: boolean;
  /** At the very start of its track. */
  readonly atTrackStart: boolean;
}

/** How far ahead of the clock playback may report itself: position updates come every 250 ms or so. */
const SLACK_MS = 1500;

/**
 * Whether listening carried you past a place on the timeline between two moments, rather than a
 * jump (a seek, a track chosen from the list): playback got no further than the time that passed
 * allows at its speed. Arriving at a place is something heard, never skipped to.
 */
export function listenedPast(before: Heard, now: Heard, t: number, rate: number): boolean {
  return listenedOn(before, now, rate) && passes(before, now, t);
}

/** Playback got from one moment to the next no faster than the clock allows at its speed. */
function listenedOn(before: Heard, now: Heard, rate: number): boolean {
  return now.ms >= before.ms && now.ms - before.ms <= (now.at - before.at) * rate + SLACK_MS;
}

/** The step from one moment to the next reaches a place it was short of. */
function passes(before: Heard, now: Heard, t: number): boolean {
  return before.t < t - 1e-6 && now.t >= t - 1e-6;
}

/**
 * One step of following the player: whether the step from the last moment to this one was heard
 * (so that anything it passed, a chapter's end, was listened to), whether it arrives at a place
 * (t), and the moment the next one is measured from. Listening on is playing, and the pause at a
 * track's end while the next one loads. A pause anywhere else, or a move while paused, breaks the
 * thread: what comes after it was not heard from here.
 */
export function followListening(before: Heard | null, now: PlayerMoment, t: number | null, rate: number): { heard: boolean; arrived: boolean; from: Heard | null } {
  const moment: Heard = { t: now.t, ms: now.ms, at: now.at, track: now.track };
  if (now.playing || now.atTrackEnd) {
    if (!before || !listenedOn(before, moment, rate)) return { heard: false, arrived: false, from: moment };
    return { heard: true, arrived: t !== null && passes(before, moment, t), from: moment };
  }
  // The next track, loaded after the last one ended, about to play on.
  if (before && now.atTrackStart && now.track === before.track + 1) return { heard: false, arrived: false, from: before };
  return { heard: false, arrived: false, from: null };
}
