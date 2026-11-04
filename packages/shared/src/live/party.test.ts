import { describe, expect, it } from 'vitest';
import { DRIFT_SEEK_THRESHOLD_S, driftCorrection, projectPosition } from './party';

describe('projectPosition', () => {
  it('holds still while paused', () => {
    expect(projectPosition({ position: 42, playing: false, rate: 1.5, updatedAt: 1000 }, 5000)).toBe(42);
  });

  it('advances by elapsed time times the rate while playing', () => {
    expect(projectPosition({ position: 10, playing: true, rate: 2, updatedAt: 1000 }, 4000)).toBe(10 + 3 * 2);
  });

  it('never runs backwards from a clock that moved before updatedAt (a clock skew, not a real elapse)', () => {
    expect(projectPosition({ position: 10, playing: true, rate: 1, updatedAt: 5000 }, 1000)).toBe(10);
  });
});

describe('driftCorrection', () => {
  const RATE = 1;

  it('does nothing when the local player is already close enough', () => {
    expect(driftCorrection(100, 100.02, RATE)).toEqual({ seekTo: null, rate: RATE });
  });

  it('nudges the rate, not a seek, for a small drift under the threshold', () => {
    const ahead = driftCorrection(100, 100.3, RATE);
    expect(ahead.seekTo).toBeNull();
    expect(ahead.rate).toBeGreaterThan(RATE);
    const behind = driftCorrection(100.3, 100, RATE);
    expect(behind.seekTo).toBeNull();
    expect(behind.rate).toBeLessThan(RATE);
  });

  it(`seeks once the drift passes ${DRIFT_SEEK_THRESHOLD_S}s, in either direction`, () => {
    expect(driftCorrection(100, 101, RATE)).toEqual({ seekTo: 101, rate: RATE });
    expect(driftCorrection(101, 100, RATE)).toEqual({ seekTo: 100, rate: RATE });
  });

  it('nudges around the party rate, not always 1x', () => {
    const corrected = driftCorrection(100, 100.3, 1.5);
    expect(corrected.rate).toBeGreaterThan(1.5);
  });
});
