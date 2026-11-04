/*
 * The worker thread that scores a query vector against a club's embedded chunks (D161): brute-
 * force cosine, off the main thread so a club with tens of thousands of chunks never blocks the
 * event loop that serves everyone else's requests. Bundled, as dist/vector-worker.mjs (build.mjs)
 * or in memory from the sources (vector-search.ts), the same way track-worker.ts and
 * align-worker.ts are.
 */
import { parentPort } from 'node:worker_threads';
import { type Scored, topKCosine } from './vector-math';

export interface VectorRequest {
  readonly id: number;
  readonly query: Float32Array;
  readonly ids: readonly string[];
  readonly matrix: Float32Array;
  readonly dim: number;
  readonly k: number;
}

export type VectorReply = { readonly id: number; readonly results: readonly Scored[] } | { readonly id: number; readonly error: string };

const port = parentPort;
if (port) {
  port.on('message', (request: VectorRequest) => {
    try {
      const results = topKCosine(request.query, request.ids, request.matrix, request.dim, request.k);
      port.postMessage({ id: request.id, results } satisfies VectorReply);
    } catch (err) {
      port.postMessage({ id: request.id, error: err instanceof Error ? err.message : String(err) } satisfies VectorReply);
    }
  });
}
