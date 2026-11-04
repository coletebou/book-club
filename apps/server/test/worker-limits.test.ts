import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

/**
 * The work-limit tests (readalong-limits.test.ts and friends) only prove anything when a Worker's
 * own `resourceLimits` are what bounds its heap. A process-wide V8 old-space flag
 * (`NODE_OPTIONS=--max-old-space-size=…`, or the same flag on the command line) silently replaces
 * them, even with `execArgv: []`: on Node 24 a Worker asking for 32 MiB got 280 MiB under
 * `--max-old-space-size=256`. This fails fast instead of letting those tests pass for the wrong
 * reason (scripts/test-ci.sh).
 */
describe('worker resource limits', () => {
  it('bound a worker heap by what it asks for, not by a process-wide heap flag', async () => {
    const worker = new Worker(
      "require('node:worker_threads').parentPort.postMessage(require('node:v8').getHeapStatistics().heap_size_limit);",
      { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 16 } },
    );
    try {
      const limit = await new Promise<number>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      expect(limit / 2 ** 20).toBeLessThan(100);
    } finally {
      await worker.terminate();
    }
  });
});
