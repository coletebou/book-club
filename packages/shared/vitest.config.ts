import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
