import { describe, expect, it } from 'vitest';
import {
  FINISHED_COVERAGE,
  type Span,
  addSpan,
  normalizeRanges,
  rangesContain,
  rangesCover,
  rangesCoverage,
  rangesFinished,
  rangesFurthest,
  unionRanges,
} from './ranges';

describe('normalizeRanges', () => {
  it('sorts and merges overlapping and touching spans', () => {
    expect(normalizeRanges([[0.5, 0.6], [0.1, 0.2], [0.2, 0.3], [0.55, 0.7]])).toEqual([
      [0.1, 0.3],
      [0.5, 0.7],
    ]);
  });

  it('clamps to [0, 1] and swaps reversed spans', () => {
    expect(normalizeRanges([[-1, 0.2], [1.5, 0.9]])).toEqual([[0, 0.2], [0.9, 1]]);
  });

  it('drops empty and non-finite spans', () => {
    expect(normalizeRanges([[0.3, 0.3], [Number.NaN, 0.5], [0.1, Infinity]])).toEqual([]);
  });

  it('merges spans separated only by floating-point noise', () => {
    const a = 0.1 + 0.2; // 0.30000000000000004
    expect(normalizeRanges([[0, 0.3], [a, 0.4]])).toEqual([[0, 0.4]]);
  });
});

describe('page turning builds one contiguous range', () => {
  it('consecutive visible pages merge', () => {
    let r = addSpan([], [0, 0.01]);
    r = addSpan(r, [0.01, 0.02]);
    r = addSpan(r, [0.02, 0.03]);
    expect(r).toEqual([[0, 0.03]]);
  });

  it('a table-of-contents jump starts a separate range', () => {
    let r = addSpan([], [0, 0.05]);
    r = addSpan(r, [0.8, 0.81]);
    expect(r).toEqual([[0, 0.05], [0.8, 0.81]]);
    expect(rangesContain(r, 0.5)).toBe(false);
  });
});

describe('rangesContain', () => {
  const r = normalizeRanges([[0.1, 0.2], [0.5, 0.6], [0.9, 1]]);

  it('is inclusive at the start and exclusive at the end', () => {
    expect(rangesContain(r, 0.1)).toBe(true);
    expect(rangesContain(r, 0.15)).toBe(true);
    expect(rangesContain(r, 0.2)).toBe(false);
  });

  it('includes the very end of the book', () => {
    expect(rangesContain(r, 1)).toBe(true);
  });

  it('is false outside every range and for non-finite input', () => {
    expect(rangesContain(r, 0.05)).toBe(false);
    expect(rangesContain(r, 0.7)).toBe(false);
    expect(rangesContain(r, Number.NaN)).toBe(false);
    expect(rangesContain([], 0)).toBe(false);
  });
});

describe('summaries', () => {
  it('coverage, furthest and finished', () => {
    const r = normalizeRanges([[0, 0.25], [0.5, 0.75]]);
    expect(rangesCoverage(r)).toBeCloseTo(0.5, 12);
    expect(rangesFurthest(r)).toBe(0.75);
    expect(rangesFinished(r)).toBe(false);
    // Jumping to the last page is not finishing: half the book is unread.
    expect(rangesFinished(addSpan(r, [0.99, 1]))).toBe(false);
    expect(rangesFurthest([])).toBe(0);
  });

  it('finished means the ending and nearly all of the rest', () => {
    expect(rangesFinished([[0, 1]])).toBe(true);
    expect(rangesFinished(normalizeRanges([[0, 0.45], [0.5, 0.95], [0.99, 1]]))).toBe(true);
    expect(rangesFinished(normalizeRanges([[0, 0.8], [0.95, 1]]))).toBe(false);
    expect(rangesFinished([[0, 0.999]])).toBe(false);
    expect(rangesFinished([[0.1, 1]])).toBe(true);
    expect(rangesFinished([[0.2, 1]])).toBe(false);
    expect(FINISHED_COVERAGE).toBe(0.9);
  });

  it('union is commutative and idempotent (offline replay in any order converges)', () => {
    const a = normalizeRanges([[0, 0.1], [0.4, 0.5]]);
    const b = normalizeRanges([[0.05, 0.2], [0.45, 0.6]]);
    expect(unionRanges(a, b)).toEqual(unionRanges(b, a));
    expect(unionRanges(unionRanges(a, b), b)).toEqual(unionRanges(a, b));
  });
});

describe('rangesCover', () => {
  const ranges: Span[] = [
    [0.1, 0.3],
    [0.5, 1],
  ];
  it('is true only when one read stretch holds the whole passage', () => {
    expect(rangesCover(ranges, 0.1, 0.3)).toBe(true);
    expect(rangesCover(ranges, 0.15, 0.2)).toBe(true);
    expect(rangesCover(ranges, 0.25, 0.35)).toBe(false);
    expect(rangesCover(ranges, 0.2, 0.6)).toBe(false);
    expect(rangesCover(ranges, 0.05, 0.2)).toBe(false);
    expect(rangesCover(ranges, 0.9, 1)).toBe(true);
    expect(rangesCover([], 0.1, 0.2)).toBe(false);
  });
  it('treats an empty or backwards passage as its start', () => {
    expect(rangesCover(ranges, 0.2, 0.2)).toBe(true);
    expect(rangesCover(ranges, 0.4, 0.2)).toBe(false);
    expect(rangesCover(ranges, Number.NaN, 0.2)).toBe(false);
  });
});
