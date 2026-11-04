#!/usr/bin/env -S tsx
/**
 * Measures brute-force cosine search (D161) at corpus sizes from a short book up to well past a
 * whole-series-sized library, so the INLINE_THRESHOLD split (inline vs. a worker thread) and the
 * "sqlite-vec only if measurements demand it" call are both backed by real numbers, not a guess.
 *
 * A whole series (say, ~1.5M words of public-domain text) chunks, at this
 * project's ~420-token windows, to roughly 1500-5000 chunks depending on overlap and prose
 * density; this script also measures 10x and 40x that, since a club that feeds Cal's shelf
 * heavily (D163) or indexes several long series can plausibly reach tens of thousands.
 *
 * Run: pnpm --filter @bookclub/server exec tsx scripts/cal-bench.ts (no keys needed: vectors are
 * synthetic random floats — cosine math does not care what a vector means, only its shape).
 */
import { flattenVectors, topKCosine } from '../src/cal/vector-math';

const DIM = 1536; // text-embedding-3-small's dimension: the default, and the one most clubs will run.

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1;
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

function benchOne(n: number, dim: number, k: number): { buildMs: number; searchMs: number } {
  const vectors = Array.from({ length: n }, () => randomVector(dim));
  const ids = vectors.map((_, i) => `chunk-${i}`);
  const t0 = performance.now();
  const matrix = flattenVectors(vectors, dim);
  const buildMs = performance.now() - t0;
  const query = randomVector(dim);
  const t1 = performance.now();
  const results = topKCosine(query, ids, matrix, dim, k);
  const searchMs = performance.now() - t1;
  if (results.length !== Math.min(k, n)) throw new Error('unexpected result count');
  return { buildMs, searchMs };
}

function run(): void {
  console.log(`cal-bench: brute-force cosine, dim=${DIM}, k=8 (node ${process.version})\n`);
  for (const n of [500, 1_500, 5_000, 20_000, 50_000]) {
    // Each size run three times; the search time (not the one-off matrix build) is what a real
    // request pays repeatedly, so it is reported as the median of the three.
    const searches: number[] = [];
    let buildMs = 0;
    for (let i = 0; i < 3; i++) {
      const r = benchOne(n, DIM, 8);
      buildMs = r.buildMs;
      searches.push(r.searchMs);
    }
    searches.sort((a, b) => a - b);
    console.log(`n=${String(n).padStart(6)}  build=${buildMs.toFixed(1)}ms  search(median of 3)=${searches[1]!.toFixed(2)}ms`);
  }
}

run();
