import { describe, expect, it } from 'vitest';
import { newerSave, placeFromElsewhere } from './elsewhere';

describe('a place saved on another device', () => {
  const saved = (t: number) => ({ t, label: `Chapter ${Math.ceil(t * 12)} · ${Math.round(t * 100)}%` });

  it('is the place it moved to when it is somewhere else than here', () => {
    expect(placeFromElsewhere(saved(0.67), 0.52, [0.5, 0.52])).toEqual({ t: 0.67, label: 'Chapter 9 · 67%' });
    // Back as well as ahead: the other device decides where you are.
    expect(placeFromElsewhere(saved(0.3), 0.52, [0.52])).toEqual({ t: 0.3, label: 'Chapter 4 · 30%' });
  });

  it('is nothing when it is where this device is, or one of the places this device saved (its own news coming back)', () => {
    expect(placeFromElsewhere(saved(0.5201), 0.52, [])).toBeNull();
    expect(placeFromElsewhere(saved(0.51), 0.52, [0.505, 0.51])).toBeNull();
    expect(placeFromElsewhere(undefined, 0.52, [])).toBeNull();
    expect(placeFromElsewhere(saved(0.67), null, [])).toBeNull();
  });

  it('counts only a save newer than the one known', () => {
    expect(newerSave('2026-10-24T10:00:01.000Z', '2026-10-24T10:00:00.000Z')).toBe(true);
    expect(newerSave('2026-10-24T10:00:00.000Z', '2026-10-24T10:00:00.000Z')).toBe(false);
    expect(newerSave('2026-10-24T09:59:59.000Z', '2026-10-24T10:00:00.000Z')).toBe(false);
    expect(newerSave('2026-10-24T09:59:59.000Z', null)).toBe(true);
    expect(newerSave(null, null)).toBe(false);
  });
});
