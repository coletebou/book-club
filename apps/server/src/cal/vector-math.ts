/**
 * The brute-force half of hybrid search (D161): cosine similarity of a query vector against every
 * one of a club's embedded chunks. Pure so it is directly unit-testable and reusable both inline
 * (a small club) and inside the worker thread (vector-worker.ts) that a larger one dispatches to.
 */

export interface Scored {
  readonly id: string;
  readonly score: number;
}

/** Cosine similarity between a query and every row of a row-major `dim`-wide matrix, top `k` by score. */
export function topKCosine(query: Float32Array, ids: readonly string[], matrix: Float32Array, dim: number, k: number): Scored[] {
  let qNorm = 0;
  for (let d = 0; d < dim; d++) qNorm += query[d]! * query[d]!;
  qNorm = Math.sqrt(qNorm);
  const scores = new Array<Scored>(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const base = i * dim;
    let dot = 0;
    let norm = 0;
    for (let d = 0; d < dim; d++) {
      const v = matrix[base + d]!;
      dot += v * query[d]!;
      norm += v * v;
    }
    const denom = Math.sqrt(norm) * qNorm;
    scores[i] = { id: ids[i]!, score: denom === 0 ? 0 : dot / denom };
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}

/** Flatten a list of same-length vectors into one row-major Float32Array matrix for a worker transfer. */
export function flattenVectors(vectors: readonly Float32Array[], dim: number): Float32Array {
  const matrix = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => matrix.set(v.subarray(0, dim), i * dim));
  return matrix;
}
