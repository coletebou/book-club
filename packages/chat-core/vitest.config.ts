import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // About twelve cores at most: the box this runs on is shared.
    maxWorkers: 12,
    include: ['src/**/*.test.ts'],
    // The core never reaches the network: a test that tries fails loudly instead of hanging.
    setupFiles: ['src/test/no-network.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/test/**'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
