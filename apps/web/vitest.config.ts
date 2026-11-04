import { defineConfig } from 'vitest/config';
import { pdfjsResources } from './pdfjs-resources.ts';

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
