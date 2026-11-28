import { expect, test } from '@playwright/test';
import { SYNTHETIC_DIR, audioFolder, browserAs, makeClub, uploadBook } from '../helpers/api';
import { goInApp } from '../helpers/open';

interface PlaybackSample {
  observed: Set<string>;
  commits: Record<string, number>;
  clockEvents: number;
  active: boolean;
}

interface PlaybackWindow extends Window {
  __perfPlaybackSample: PlaybackSample;
  __perfPlaybackCommit(name: string): void;
}

test('profile sustained audio playback on the speed sheet and library', async ({ browser }) => {
  const club = await makeClub([]);
  const book = await uploadBook(club.owner, club.id, 'audio', audioFolder(SYNTHETIC_DIR), {
    title: 'Performance audio', author: 'Fixture',
  });
  const context = await browserAs(browser, club.owner, { serviceWorkers: 'block' });
  try {
    await context.addInitScript(() => {
      const sample: PlaybackSample = { observed: new Set(), commits: {}, clockEvents: 0, active: false };
      const page = window as unknown as PlaybackWindow;
      page.__perfPlaybackSample = sample;
      // An instrumented production build can report named React commits.
      page.__perfPlaybackCommit = (name) => {
        sample.observed.add(name);
        if (sample.active) sample.commits[name] = (sample.commits[name] ?? 0) + 1;
      };
      document.addEventListener('timeupdate', () => {
        if (sample.active) sample.clockEvents++;
      }, true);
    });
    const page = await context.newPage();
    const cdp = browser.browserType().name() === 'chromium' ? await context.newCDPSession(page) : null;
    await cdp?.send('Performance.enable');
    const taskSeconds = async () => (await cdp?.send('Performance.getMetrics'))?.metrics
      .find((metric) => metric.name === 'TaskDuration')?.value;
    const measure = async (controls: string[]) => {
      const before = await taskSeconds();
      const sample = await page.evaluate(async (expected) => {
        const probe = (window as unknown as PlaybackWindow).__perfPlaybackSample;
        const observed = expected.every((name) => probe.observed.has(name));
        probe.commits = {};
        probe.clockEvents = 0;
        probe.active = true;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        probe.active = false;
        return {
          clockEvents: probe.clockEvents,
          commits: observed ? { ...Object.fromEntries(expected.map((name) => [name, 0])), ...probe.commits } : null,
        };
      }, controls);
      const after = await taskSeconds();
      expect(sample.clockEvents).toBeGreaterThan(0);
      if (process.env.BOOKCLUB_AUDIO_COMMITS === '1') {
        expect(sample.commits, 'the controls must report an initial commit').not.toBeNull();
      }
      return {
        commits: sample.commits,
        clockEvents: sample.clockEvents,
        rendererTaskMs: before !== undefined && after !== undefined ? Math.round((after - before) * 1000) : null,
      };
    };
    await page.goto(`/books/${book.id}/listen`);
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await page.getByTestId('speed').click();
    await expect(page.getByRole('dialog', { name: 'Playback speed' })).toBeVisible();
    const speedSheet = await measure(['SpeedButton', 'SpeedSheet']);
    await page.keyboard.press('Escape');
    await goInApp(page, `/clubs/${club.id}`);
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await expect(page.getByTestId('mini-player')).toBeVisible();
    console.log(JSON.stringify({ speedSheet, library: await measure(['LibraryPage', 'MiniPlayer']) }));
  } finally {
    await context.close();
  }
});
