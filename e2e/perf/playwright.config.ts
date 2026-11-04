import { defineConfig, devices } from '@playwright/test';

/**
 * Performance measurements against a running stack (not part of the acceptance suite):
 *   BOOKCLUB_URL=… pnpm exec playwright test -c perf/playwright.config.ts
 * Each spec prints what it measured and writes it to reports/perf-*.json.
 */
export default defineConfig({
  testDir: '.',
  timeout: 600_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env.BOOKCLUB_URL ?? 'http://127.0.0.1:47100' },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 15'] } },
  ],
});
