/**
 * Keep the screen on while something long goes on, as an upload of an audiobook from a phone (iOS
 * stops Safari's page when the screen locks; D107): a screen wake lock, asked for again each time
 * the page is seen again, since the browser lets it go whenever the page is hidden. Returns what
 * lets it go, once the work is done, has failed or is stopped. A browser without wake locks, or
 * one refusing it (a page not on screen, a power saver), changes nothing: the upload dialog says to
 * keep the screen on all the same.
 */
export function holdScreenOn(): () => void {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator) || !navigator.wakeLock) return () => undefined;
  const wakeLock = navigator.wakeLock;
  let held: WakeLockSentinel | null = null;
  let asking = false;
  let done = false;
  const ask = () => {
    if (done || asking || (held && !held.released) || document.visibilityState !== 'visible') return;
    asking = true;
    wakeLock.request('screen').then(
      (sentinel) => {
        asking = false;
        if (done) void sentinel.release().catch(() => undefined);
        else held = sentinel;
      },
      () => {
        asking = false;
      },
    );
  };
  const seen = () => {
    if (document.visibilityState === 'visible') ask();
  };
  document.addEventListener('visibilitychange', seen);
  ask();
  return () => {
    done = true;
    document.removeEventListener('visibilitychange', seen);
    if (held && !held.released) void held.release().catch(() => undefined);
    held = null;
  };
}
