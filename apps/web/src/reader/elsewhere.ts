import type { MemberProgress } from '@bookclub/shared';

/** Places this close on the timeline are one place: well within a page of any book. */
export const SAME_PLACE_T = 0.002;

/**
 * Your saved place moved on another device while this one was open (D70): the place it moved to,
 * or null. The club is told of every place saved, yours too, so what this device saved itself
 * comes back the same way: it is told apart by being one of the places saved here.
 */
export function placeFromElsewhere(
  saved: Pick<MemberProgress, 't' | 'label'> | undefined,
  here: number | null,
  savedHere: readonly number[],
): { t: number; label: string } | null {
  if (!saved || here === null) return null;
  const same = (t: number) => Math.abs(saved.t - t) <= SAME_PLACE_T;
  if (same(here) || savedHere.some(same)) return null;
  return { t: saved.t, label: saved.label };
}

/** Whether a saved place is newer than the one known before (server times, as ISO strings). */
export function newerSave(updatedAt: string | null | undefined, known: string | null): boolean {
  return !!updatedAt && (known === null || updatedAt > known);
}
