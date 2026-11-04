import { describe, expect, it } from 'vitest';
import {
  SyncMapError,
  assertValidSyncMap,
  isValidSyncMap,
  linearSyncMap,
  mToT,
  syncMapFromTiePoints,
  tToM,
} from './syncmap';

describe('linearSyncMap', () => {
  it('maps the start and end of the range onto 0 and 1', () => {
    const map = linearSyncMap(100, 1100);
    expect(mToT(map, 100)).toBe(0);
    expect(mToT(map, 1100)).toBe(1);
    expect(mToT(map, 600)).toBeCloseTo(0.5, 12);
  });

  it('rejects an empty range', () => {
    expect(() => linearSyncMap(5, 5)).toThrow(SyncMapError);
  });
});

describe('mToT', () => {
  const map = { points: [{ m: 0, t: 0 }, { m: 10, t: 0.5 }, { m: 30, t: 1 }] };

  it('interpolates inside each segment', () => {
    expect(mToT(map, 5)).toBeCloseTo(0.25, 12);
    expect(mToT(map, 20)).toBeCloseTo(0.75, 12);
  });

  it('hits tie points exactly', () => {
    expect(mToT(map, 10)).toBe(0.5);
  });

  it('clamps before and after the map', () => {
    expect(mToT(map, -50)).toBe(0);
    expect(mToT(map, 1e9)).toBe(1);
  });

  it('works with many tie points (binary search)', () => {
    const points = Array.from({ length: 1001 }, (_, i) => ({ m: i * 10, t: i / 1000 }));
    const big = { points };
    for (const m of [0, 1, 4999, 5000, 9995, 10000]) expect(mToT(big, m)).toBeCloseTo(m / 10000, 12);
  });
});

describe('tToM', () => {
  it('inverts mToT on increasing segments', () => {
    const map = { points: [{ m: 0, t: 0 }, { m: 10, t: 0.5 }, { m: 30, t: 1 }] };
    for (const m of [0, 2.5, 10, 17, 30]) expect(tToM(map, mToT(map, m))).toBeCloseTo(m, 9);
  });

  it('returns the start of a flat stretch', () => {
    // An intro track (m 0..300) that sits at the first chapter's start.
    const map = { points: [{ m: 0, t: 0.1 }, { m: 300, t: 0.1 }, { m: 1300, t: 1 }] };
    expect(tToM(map, 0.1)).toBe(0);
    expect(tToM(map, 0.55)).toBeCloseTo(800, 9);
  });

  it('clamps outside the map', () => {
    const map = { points: [{ m: 50, t: 0.2 }, { m: 150, t: 0.8 }] };
    expect(tToM(map, 0)).toBe(50);
    expect(tToM(map, 1)).toBe(150);
  });

  it('handles a target equal to a tie point in the middle', () => {
    const map = { points: [{ m: 0, t: 0 }, { m: 10, t: 0.4 }, { m: 20, t: 1 }] };
    expect(tToM(map, 0.4)).toBe(10);
  });
});

describe('validation', () => {
  it('accepts a well-formed map', () => {
    expect(isValidSyncMap({ points: [{ m: 0, t: 0 }, { m: 1, t: 1 }] })).toBe(true);
  });

  it.each([
    ['one point', [{ m: 0, t: 0 }]],
    ['non-increasing m', [{ m: 0, t: 0 }, { m: 0, t: 1 }]],
    ['decreasing t', [{ m: 0, t: 0.5 }, { m: 1, t: 0.4 }]],
    ['t above 1', [{ m: 0, t: 0 }, { m: 1, t: 1.2 }]],
    ['NaN', [{ m: 0, t: 0 }, { m: Number.NaN, t: 1 }]],
  ])('rejects %s', (_label, points) => {
    expect(isValidSyncMap({ points })).toBe(false);
    expect(() => assertValidSyncMap({ points })).toThrow(SyncMapError);
  });
});

describe('syncMapFromTiePoints', () => {
  it('sorts, clamps and drops points that would break monotonicity', () => {
    const map = syncMapFromTiePoints([
      { m: 20, t: 0.6 },
      { m: 0, t: -0.1 },
      { m: 10, t: 0.7 }, // same m as the next point: after sorting, only the lower t survives
      { m: 10, t: 0.3 },
      { m: 30, t: 1.4 },
    ]);
    expect(map.points).toEqual([
      { m: 0, t: 0 },
      { m: 10, t: 0.3 },
      { m: 20, t: 0.6 },
      { m: 30, t: 1 },
    ]);
  });

  it('throws when fewer than two points survive', () => {
    expect(() => syncMapFromTiePoints([{ m: 1, t: 0 }])).toThrow(SyncMapError);
  });
});
