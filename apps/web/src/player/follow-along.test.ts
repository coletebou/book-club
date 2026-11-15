import type { Edition } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { followAlongChanged } from './follow-along';

const base = {
  alignment: { method: 'number' as const, unitToChapter: [0, 1] },
  readAlong: null,
  sync: { points: [{ m: 0, t: 0 }, { m: 1, t: 1 }] },
  units: [{ title: 'I', m: 0 }],
};

describe('followAlongChanged', () => {
  it('is false for the same follow-along fields', () => {
    expect(followAlongChanged(base, { ...base })).toBe(false);
    // Copies of the same fields (a refetched book detail) are no change: the track is not reloaded.
    expect(followAlongChanged(base, { ...base, units: base.units.map((u) => ({ ...u })), sync: { points: base.sync.points.map((p) => ({ ...p })) } })).toBe(false);
  });

  it('notices forced alignment and a read-along arriving', () => {
    const forced = {
      ...base,
      alignment: { method: 'forced' as const, unitToChapter: [0, 0, 1] },
      readAlong: { textEditionId: 'ed_epub', sentences: 120, coverage: 0.98 },
    };
    expect(followAlongChanged(base, forced)).toBe(true);
  });

  it('notices a remapped sync map (chapter drift gone)', () => {
    const remapped = {
      ...base,
      sync: { points: [{ m: 0, t: 0 }, { m: 0.5, t: 0.48 }, { m: 1, t: 1 }] },
    };
    expect(followAlongChanged(base, remapped)).toBe(true);
  });
});

// Keep Edition assignable so a schema drift fails the typecheck, not only a runtime test.
const _editionCheck: Pick<Edition, 'alignment' | 'readAlong' | 'sync' | 'units'> = base;
void _editionCheck;
