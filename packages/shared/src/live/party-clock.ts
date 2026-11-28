import type { PartyState } from './party';

/** Where the party's position is right now, projected from the server's last update. */
export function projectPosition(state: Pick<PartyState, 'position' | 'playing' | 'rate' | 'updatedAt'>, now: number): number {
  if (!state.playing) return state.position;
  return state.position + ((Math.max(0, now - state.updatedAt) / 1000) * state.rate);
}

/** How far off the party's clock a local player may drift before it is corrected (the spec's 0.75 s). */
export const DRIFT_SEEK_THRESHOLD_S = 0.75;
/** Below the threshold, nudge playback rate by this fraction instead of seeking (no audible jump). */
export const DRIFT_NUDGE_FRACTION = 0.05;
/** Close enough that nudging the rate would do more harm (float jitter) than good. */
export const DRIFT_IGNORE_S = 0.05;

export interface DriftCorrection {
  /** Seek the local player here (big drift); null when a seek is not called for. */
  readonly seekTo: number | null;
  /** The rate to actually play at (the party's rate, nudged a little to close a small drift). */
  readonly rate: number;
}

/** join/leave mid-way, drift correction (D155): seek past the threshold, else nudge rate, else nothing. */
export function driftCorrection(localPosition: number, expectedPosition: number, partyRate: number): DriftCorrection {
  const diff = expectedPosition - localPosition;
  if (Math.abs(diff) > DRIFT_SEEK_THRESHOLD_S) return { seekTo: expectedPosition, rate: partyRate };
  if (Math.abs(diff) <= DRIFT_IGNORE_S) return { seekTo: null, rate: partyRate };
  return { seekTo: null, rate: partyRate * (1 + Math.sign(diff) * DRIFT_NUDGE_FRACTION) };
}
