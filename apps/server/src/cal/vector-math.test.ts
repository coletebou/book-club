import { describe, expect, it } from 'vitest';
import { flattenVectors, topKCosine } from './vector-math';

describe('topKCosine', () => {
  it('ranks the exact match first and an orthogonal vector last', () => {
    const ids = ['same', 'orthogonal', 'opposite'];
    const matrix = flattenVectors(
      [new Float32Array([1, 0]), new Float32Array([0, 1]), new Float32Array([-1, 0])],
      2,
    );
    const results = topKCosine(new Float32Array([1, 0]), ids, matrix, 2, 3);
    expect(results.map((r) => r.id)).toEqual(['same', 'orthogonal', 'opposite']);
    expect(results[0]!.score).toBeCloseTo(1, 5);
    expect(results[1]!.score).toBeCloseTo(0, 5);
    expect(results[2]!.score).toBeCloseTo(-1, 5);
  });

  it('respects k', () => {
    const ids = ['a', 'b', 'c'];
    const matrix = flattenVectors([new Float32Array([1, 0]), new Float32Array([0.9, 0.1]), new Float32Array([0, 1])], 2);
    const results = topKCosine(new Float32Array([1, 0]), ids, matrix, 2, 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('a');
  });

  it('treats a zero vector as zero similarity rather than NaN', () => {
    const ids = ['zero'];
    const matrix = flattenVectors([new Float32Array([0, 0])], 2);
    const results = topKCosine(new Float32Array([1, 0]), ids, matrix, 2, 1);
    expect(results[0]!.score).toBe(0);
  });
});

describe('flattenVectors', () => {
  it('lays vectors out row-major', () => {
    const matrix = flattenVectors([new Float32Array([1, 2]), new Float32Array([3, 4])], 2);
    expect([...matrix]).toEqual([1, 2, 3, 4]);
  });
});
