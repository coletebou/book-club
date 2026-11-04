import { type Chapter, type Locator, chapterLabel, listeningLabel } from '@bookclub/shared';
import { type Db } from '../db/db';
import { fromJson } from '../lib/json';
import { type EditionRow, editionAlignment, editionById, editionTimeline, editionUnits } from '../repos/books';

export { chapterIndexAt, chapterLabel } from '@bookclub/shared';

/**
 * A place's label, as friends see it: chapterLabel, except in an audiobook in the moments before a
 * chapter's words where its own track begins (the recording's announcement), which are that
 * chapter's (listeningLabel), not the end of the one before it on the timeline. A track's chapter
 * is the one its read-along hears it open with (FR161), else its unit's match.
 */
export function placeLabel(chapters: readonly Chapter[], edition: EditionRow | undefined, locator: Locator, t: number): string {
  const tl = edition && locator.kind === 'audio' ? editionTimeline(edition) : null;
  if (!edition || locator.kind !== 'audio' || tl?.geometry.kind !== 'audio') return chapterLabel(chapters, t);
  const m = tl.geometry.trackDurationsMs.slice(0, locator.track).reduce((sum, d) => sum + d, 0) + locator.ms;
  const units = editionUnits(edition);
  let unit = -1;
  for (let i = 0; i < units.length; i++) if (units[i]!.m <= m + 1e-9) unit = i;
  const alignment = editionAlignment(edition);
  // A file with chapters of its own (an M4B) goes by the unit playing.
  const opens = alignment.method === 'forced' && units.length <= tl.geometry.trackDurationsMs.length ? alignment.opensWith?.[locator.track] : null;
  const chapter = opens ?? (unit >= 0 ? (alignment.unitToChapter[unit] ?? null) : null);
  return listeningLabel(chapters, t, chapter);
}

/** The label of a saved place (a progress row): its own edition says how to name it. */
export function savedPlaceLabel(db: Db, chapters: readonly Chapter[], row: { readonly edition_id: string | null; readonly locator_json: string | null; readonly t: number }): string {
  const locator = row.locator_json ? fromJson<Locator | null>(row.locator_json, null) : null;
  if (!row.edition_id || !locator) return chapterLabel(chapters, row.t);
  return placeLabel(chapters, editionById(db, row.edition_id), locator, row.t);
}
