import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The zone every test runs in, whatever the machine's own (D225): UTC, the zone the server runs in
 * (its container sets none), so a run on a laptop and one in CI agree. BOOKCLUB_TEST_TZ names
 * another to try. Set before vitest starts its workers, which take the zone from the environment
 * they inherit.
 */
process.env.TZ = process.env.BOOKCLUB_TEST_TZ || 'UTC';

/**
 * The tests that measure how long the server's thread is held while heavy work runs in worker
 * threads (a book's ingest, a transcript lined up): run after all the others, one file at a time,
 * so that other files' work on the same cores is never counted as the server's.
 */
const RESPONSIVENESS = ['test/chapters-found.test.ts', 'test/ingest.test.ts', 'test/readalong-limits.test.ts', 'test/unit.test.ts'];

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // About twelve cores at most: the box this runs on is shared.
    maxWorkers: 12,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/cli/index.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
    },
    projects: [
      { extends: true, test: { name: 'server', include: ['src/**/*.test.ts', 'test/**/*.test.ts'], exclude: [...configDefaults.exclude, ...RESPONSIVENESS] } },
      { extends: true, test: { name: 'responsiveness', include: RESPONSIVENESS, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
