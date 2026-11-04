/**
 * The lock-screen and headphone actions the player offers (the Media Session). iOS puts track
 * buttons where the skip-back and skip-ahead ones go whenever an app offers both, and an
 * audiobook wants the skips there, as Apple's Books has them: on an iPhone or iPad, chapters
 * change in the app (the track list, the chapter buttons), not on the lock screen (D64).
 */
export function lockScreenActions(ios: boolean): MediaSessionAction[] {
  const always: MediaSessionAction[] = ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto'];
  return ios ? always : [...always, 'previoustrack', 'nexttrack'];
}
