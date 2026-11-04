import { type EditionUnit } from '@bookclub/shared';

/** Units of an edition that fall inside its story, with their indices in the full list. */
export function storyUnits(units: readonly EditionUnit[], story: { start: number; end: number }): { unit: EditionUnit; index: number }[] {
  const out: { unit: EditionUnit; index: number }[] = [];
  units.forEach((unit, index) => {
    if (unit.m < story.start - 1e-9 || unit.m >= story.end) return;
    const prev = out[out.length - 1];
    // Several TOC entries at one position (a part heading and its first chapter): keep the last.
    if (prev && Math.abs(prev.unit.m - unit.m) < 1e-9) out[out.length - 1] = { unit, index };
    else out.push({ unit, index });
  });
  return out;
}
