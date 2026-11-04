import { Worker } from 'node:worker_threads';
import { workerFromSources } from '../lib/worker-source';
import { type EmbeddedChunk } from './store';
import { flattenVectors, type Scored, topKCosine } from './vector-math';
import { type VectorReply, type VectorRequest } from './vector-worker';

/** The worker: beside the bundle once built (build.mjs); from the sources, bundled here in memory. */
const BUILT = import.meta.url.endsWith('.ts') ? null : new URL('./vector-worker.mjs', import.meta.url);

/**
 * A long-lived worker thread that scores cosine similarity (D161), one at a time: small clubs
 * answer in well under a millisecond of actual work, so a pool of several threads would only add
 * complexity for no measured benefit (docs/DECISIONS.md D161, the scripts/cal-bench.ts numbers).
 */
class VectorSearchPool {
  private worker: Worker | null = null;
  private nextId = 0;

  private async start(): Promise<Worker> {
    const options = { resourceLimits: { maxOldGenerationSizeMb: 512 } };
    const worker = BUILT
      ? new Worker(BUILT, options)
      : new Worker(await workerFromSources(new URL('./vector-worker.ts', import.meta.url)), { ...options, eval: true, execArgv: ['--input-type=module'] });
    worker.unref();
    worker.on('error', () => this.drop(worker));
    worker.on('exit', () => this.drop(worker));
    return worker;
  }

  private drop(worker: Worker): void {
    if (this.worker === worker) this.worker = null;
    void worker.terminate();
  }

  async search(query: Float32Array, ids: readonly string[], matrix: Float32Array, dim: number, k: number): Promise<Scored[]> {
    const worker = (this.worker ??= await this.start());
    const id = ++this.nextId;
    // The matrix (and only the matrix: ids are small strings, cheap to clone) transfers without a
    // copy; it is sent fresh each request since cal_chunks can change between searches.
    const matrixCopy = matrix.slice();
    return new Promise<Scored[]>((resolve, reject) => {
      const onMessage = (reply: VectorReply) => {
        if (reply.id !== id) return;
        settle();
        if ('error' in reply) reject(new Error(reply.error));
        else resolve(reply.results as Scored[]);
      };
      const onError = (err: Error) => {
        settle();
        reject(err);
      };
      const onExit = (code: number) => {
        settle();
        reject(new Error(`the vector search worker stopped (exit code ${code})`));
      };
      const settle = () => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage({ id, query, ids, matrix: matrixCopy, dim, k } satisfies VectorRequest, [matrixCopy.buffer]);
    });
  }

  async terminate(): Promise<void> {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }
}

/**
 * Below this many candidates, scoring inline is faster than a worker round trip (object clone +
 * message latency); above it, the worker keeps a big club's search from blocking the event loop.
 * Chosen from scripts/cal-bench.ts's numbers (docs/DECISIONS.md D161).
 */
export const INLINE_THRESHOLD = 1500;

const pool = new VectorSearchPool();

/** Brute-force cosine search over a club's embedded chunks: inline for a small club, a worker thread above INLINE_THRESHOLD. */
export async function vectorSearch(query: Float32Array, candidates: readonly EmbeddedChunk[], k: number): Promise<Scored[]> {
  if (candidates.length === 0) return [];
  const dim = candidates[0]!.vector.length;
  if (candidates.length <= INLINE_THRESHOLD) {
    const ids = candidates.map((c) => c.id);
    const matrix = flattenVectors(candidates.map((c) => c.vector), dim);
    return topKCosine(query, ids, matrix, dim, k);
  }
  const ids = candidates.map((c) => c.id);
  const matrix = flattenVectors(candidates.map((c) => c.vector), dim);
  return pool.search(query, ids, matrix, dim, k);
}

/** For tests and graceful shutdown: stop the pool's worker, if one was started. */
export async function closeVectorSearchPool(): Promise<void> {
  await pool.terminate();
}
