import { RATE_MAX, RATE_MIN } from './rate';

/**
 * Pure sequencing/download-state logic for the mobile native audio bridge
 * (apps/mobile/src/audio/NativeAudioEngine.ts, D130-D138). Pulled out here, rather than left
 * inline, because the native module itself has no test harness (it talks to real `expo-audio`/
 * `expo-file-system` native modules): this is the part of it that can go wrong on its own,
 * decoupled from anything native, so it is actually tested.
 */

/**
 * Guards against two overlapping `load(url)` calls racing each other's async file lookup
 * (findings review, PR #13): `begin()` is called synchronously the instant a load starts, and
 * `isCurrent(token)` is checked after every `await` a load does before it is allowed to touch
 * shared state (creating/assigning the real player). A load whose token is no longer current has
 * been superseded by a newer one and must do nothing further — in particular, it must not
 * overwrite `this.player` with a stale track once its own await finally resolves.
 */
export class LoadSequencer {
  private generation = 0;

  /** Call synchronously at the very start of a new load; returns its token. */
  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  /** True while no newer `begin()` has happened since `token` was issued. */
  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}

/**
 * Whether a completed `FileSystem.downloadAsync` response is safe to treat as a cached copy of
 * the track (findings review, PR #13). `downloadAsync` resolves for any response that completes,
 * including a 401/404/5xx with an error body; without this check that body gets written to the
 * local cache file and every future `load` of the same URL prefers it over the network forever,
 * permanently replacing real audio with an error page.
 */
export function isCacheableDownload(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The rate the iOS app's player is given for a `setRate` from the page (D195): any speed the page
 * offers, 0.05 steps included, played exactly; a drift nudge (a party's speed a hair off) too. A
 * value that is not a usable rate (missing, not finite, zero or less) is ignored (null), never
 * turned into a pause or a silent 1×; past the range, the nearest end of it.
 */
export function nativeRate(rate: unknown): number | null {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, rate));
}
