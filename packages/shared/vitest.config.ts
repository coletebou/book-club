import { defineConfig } from 'vitest/config';

/**
 * The zone every test runs in, whatever the machine's own (D225): New York, so a run on a laptop
 * and one in CI (UTC) agree, and a date shown on the local clock where it should not be is wrong
 * here too, as it would be for a member west of Greenwich. BOOKCLUB_TEST_TZ names another to try.
 * Set before vitest starts its workers, which take the zone from the environment they inherit.
 */
process.env.TZ = process.env.BOOKCLUB_TEST_TZ || 'America/New_York';

export default defineConfig({
  test: {
    // Pure functions with no module state shared between files: one module graph per worker thread
    // (isolate off) takes the suite from 5.8 s and 300 MB to 3.1 s and 214 MB (test-ci.sh's two
    // workers, measured 2026-11-26). Worker threads take their heap limit from the parent process,
    // so under test-ci.sh's 128 MiB coordinator a file that needs more must run in forks (as epub's
    // crafted-archive tests do).
    pool: 'threads',
    isolate: false,
    // About twelve cores at most: the box this runs on is shared.
    maxWorkers: 12,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
    },
  },
});
