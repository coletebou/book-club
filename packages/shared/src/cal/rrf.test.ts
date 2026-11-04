import { describe, expect, it } from 'vitest';
import { fuseRanked, fuseRanks } from './rrf';

describe('fuseRanks', () => {
  it('scores an id only appearing first in one list higher than one appearing nowhere else as highly', () => {
    const scores = fuseRanks([
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ id: 'b' }, { id: 'a' }, { id: 'd' }],
    ]);
    // 'a' is #1 then #2; 'b' is #2 then #1 - by symmetry they tie.
    expect(scores.get('a')).toBeCloseTo(scores.get('b')!, 10);
    // Both outrank 'c' and 'd', which each appear in only one list and lower.
    expect(scores.get('a')!).toBeGreaterThan(scores.get('c')!);
    expect(scores.get('a')!).toBeGreaterThan(scores.get('d')!);
  });

  it('rewards an id both lists agree on over one only one list likes', () => {
    const scores = fuseRanks([
      [{ id: 'agree' }, { id: 'bm25-only' }],
      [{ id: 'agree' }, { id: 'vector-only' }],
    ]);
    expect(scores.get('agree')!).toBeGreaterThan(scores.get('bm25-only')!);
    expect(scores.get('agree')!).toBeGreaterThan(scores.get('vector-only')!);
  });
});

describe('fuseRanked', () => {
  it('returns ids best-first, deduplicated', () => {
    const fused = fuseRanked([
      [{ id: 'x' }, { id: 'y' }],
      [{ id: 'x' }, { id: 'z' }],
    ]);
    expect(fused[0]).toBe('x');
    expect(new Set(fused)).toEqual(new Set(['x', 'y', 'z']));
  });

  it('honors a limit', () => {
    const fused = fuseRanked([[{ id: 'a' }, { id: 'b' }, { id: 'c' }]], 60, 2);
    expect(fused).toHaveLength(2);
  });

  it('is stable for a solitary list: the fused order matches the input order', () => {
    const list = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
    expect(fuseRanked([list])).toEqual(['first', 'second', 'third']);
  });

  it('breaks ties by first-seen order rather than arbitrarily', () => {
    // Two single-element lists of equal rank (#1 each): tie broken by which list came first.
    const fused = fuseRanked([[{ id: 'later' }], [{ id: 'earlier' }]]);
    // Both are rank-1 in their own list, so scores tie; input order of the lists (and within
    // each list) decides, which is what makes the fusion deterministic and testable.
    expect(fused).toEqual(['later', 'earlier']);
  });
});
