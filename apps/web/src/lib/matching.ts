import type { Edition } from '@bookclub/shared';

/**
 * How many of an edition's units were placed between the ones matched to chapters rather than
 * matched themselves: units after the first matched one that no chapter starts at (an intro track
 * before it sits at that chapter's start by design). Its owner is told, and can match them by hand
 * (D77): fidelity review round 13 found LibriVox's Christmas Carol with three of its five tracks
 * placed so, notes across formats opening pages late, and nobody told. A match by hand, a format the
 * book's chapters come from, or one lined up word by word is not counted.
 */
export function placedBetween(edition: Pick<Edition, 'alignment' | 'units'>): number {
  const { method, unitToChapter } = edition.alignment;
  if (method !== 'count' && method !== 'number' && method !== 'title') return 0;
  const first = unitToChapter.findIndex((c) => c !== null);
  if (first < 0) return 0;
  let guessed = 0;
  for (let u = first + 1; u < edition.units.length; u++) if ((unitToChapter[u] ?? null) === null) guessed++;
  return guessed;
}
