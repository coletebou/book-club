import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real stack (`docker compose up -d --build --wait`): real server,
 * database, storage and browsers. Nothing is mocked. Retries are off: a flaky test is a failure.
 */
const baseURL = process.env.BOOKCLUB_URL ?? 'http://127.0.0.1:47100';
// Voice/listening-together specs (D153, live.spec.ts): a real (non-silent) fake microphone input,
// so LiveKit's own speaking detection has something to detect (`scripts/fixtures/make-voice-tone.mjs`).
const VOICE_TONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/audio/voice-tone.wav');

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: 0,
  workers: Number(process.env.E2E_WORKERS ?? 4),
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: process.env.E2E_JSON ?? 'test-results/results.json' }]],
  globalSetup: './helpers/global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 860 },
        permissions: ['microphone'],
        // A fake microphone and camera, no real hardware and no permission prompt: real
        // getUserMedia/MediaRecorder over a fake device, so a voice note records for real
        // (media-notes.spec.ts, D149) and a voice call carries a real, non-silent tone
        // (live.spec.ts, D153). `--use-fake-ui-for-media-stream` skips Chromium's own prompt.
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${VOICE_TONE}`],
        },
      },
    },
    {
      name: 'webkit-iphone',
      use: { ...devices['iPhone 15'] },
      // Tests tagged @chromium-only exercise something Playwright's Linux WebKit cannot do; each
      // tag is justified next to its test and listed in docs/RUNBOOK.md (at most five).
      grepInvert: /@chromium-only/,
    },
  ],
});
