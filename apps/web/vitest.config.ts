import { defineConfig } from 'vitest/config';
import { pdfjsResources } from './pdfjs-resources.ts';

/**
 * The zone every test runs in, whatever the machine's own (D225): New York, so a run on a laptop
 * and one in CI (UTC) agree, and a date shown on the local clock where it should not be is wrong
 * here too, as it would be for a member west of Greenwich. BOOKCLUB_TEST_TZ names another to try.
 * Set before vitest starts its workers, which take the zone from the environment they inherit.
 */
process.env.TZ = process.env.BOOKCLUB_TEST_TZ || 'America/New_York';

export default defineConfig({
  plugins: [pdfjsResources()],
  test: {
    // About twelve cores at most: the box this runs on is shared.
    maxWorkers: 12,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/main.tsx', 'src/sw.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
