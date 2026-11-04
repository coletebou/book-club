import type { Edition } from '@bookclub/shared';

/**
 * The fields of an audiobook edition that decide where the text follows the narrator
 * (D46). When forced alignment finishes while the player already holds this edition,
 * these change and the player must take the new snapshot without reloading the track.
 */
export function followAlongFingerprint(
  edition: Pick<Edition, 'alignment' | 'readAlong' | 'sync' | 'units'>,
): string {
  return JSON.stringify({
    method: edition.alignment.method,
    unitToChapter: edition.alignment.unitToChapter,
    readAlong: edition.readAlong,
    sync: edition.sync,
    units: edition.units,
  });
}

/** True when a fresher book detail would change how the pages follow this audiobook. */
export function followAlongChanged(
  was: Pick<Edition, 'alignment' | 'readAlong' | 'sync' | 'units'>,
  next: Pick<Edition, 'alignment' | 'readAlong' | 'sync' | 'units'>,
): boolean {
  return followAlongFingerprint(was) !== followAlongFingerprint(next);
}
