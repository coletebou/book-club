import { devices, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';
import { useWebKitMicrophoneStandIn } from '../helpers/microphone';

test('Ask Cal from the player takes a hands-free follow-up and stops on tap', async ({ browser, browserName }, testInfo) => {
  const { club, book } = await clubWithAlice([], { audio: 'tiny' });
  const context = await browserAs(browser, club.owner, {
    ...(browserName === 'webkit' ? devices['iPhone 15'] : {
      viewport: { width: 1280, height: 844 },
      permissions: ['microphone'],
    }),
    audioOnlyView: true,
  });
  try {
    const page = await context.newPage();
    if (browserName === 'webkit') await useWebKitMicrophoneStandIn(page);
    // Playback stays real. Control only the analyser input, so the fake microphone can have a
    // deterministic end of speech on both engines.
    await page.addInitScript(() => {
      const device = window as Window & { speechLevel?: number };
      device.speechLevel = 0;
      class SpeechAnalyser {
        fftSize = 512;
        getFloatTimeDomainData(samples: Float32Array) { samples.fill(device.speechLevel ?? 0); }
      }
      class CaptureContext {
        createAnalyser() { return new SpeechAnalyser(); }
        createMediaStreamSource() { return { connect() {} }; }
        async resume() {}
        async close() {}
      }
      window.AudioContext = CaptureContext as unknown as typeof AudioContext;
    });
    const connections: string[] = [];
    page.on('websocket', (socket) => {
      if (socket.url().includes('/ws/cal/voice')) connections.push(socket.url());
    });

    await page.goto(`/books/${book.id}/listen`);
    const play = page.getByTestId('play-pause');
    await play.click();
    await expect(play).toHaveAttribute('data-playing', 'true');
    await page.getByRole('button', { name: 'Ask Cal' }).click();
    const status = page.getByTestId('cal-voice-status');
    await expect(status).toHaveText('Listening…');
    await expect(play).toHaveAttribute('data-playing', 'false');

    for (let turn = 1; turn <= 2; turn += 1) {
      await page.evaluate(() => { (window as Window & { speechLevel?: number }).speechLevel = 0.1; });
      // A few hundred milliseconds exceed the analyser's sustained-speech threshold.
      await page.waitForTimeout(450);
      await page.evaluate(() => { (window as Window & { speechLevel?: number }).speechLevel = 0; });
      await expect(page.getByTestId('cal-message-assistant')).toHaveCount(turn);
      await expect(status).toHaveText('Listening…');
    }
    expect(connections).toHaveLength(1);
    await testInfo.attach('hands-free follow-up', { body: await page.getByRole('dialog', { name: 'Ask Cal' }).screenshot(), contentType: 'image/png' });

    await page.getByRole('button', { name: 'Stop voice conversation' }).click();
    await expect(status).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Talk hands-free' })).toBeEnabled();
    await expect(page.getByTestId('cal-input')).toBeEnabled();
  } finally {
    await context.close();
  }
});

test('Ask Cal from the player with unknown CarPlay state opens a typed chat', async ({ browser, browserName }) => {
  const { club, book } = await clubWithAlice([], { audio: 'tiny' });
  const context = await browserAs(browser, club.owner, {
    ...(browserName === 'webkit' ? devices['iPhone 15'] : {}),
    audioOnlyView: true,
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const device = window as Window & { microphoneRequests?: number };
      Object.assign(window, { BookClubNative: { postMessage() {} } });
      device.microphoneRequests = 0;
      // Capability detection must pass in Linux WebKit too, without granting capture.
      window.MediaRecorder ??= class {} as unknown as typeof MediaRecorder;
      window.AudioContext ??= class {} as typeof AudioContext;
      Object.defineProperty(navigator, 'mediaDevices', { value: {
        getUserMedia: async () => {
          device.microphoneRequests! += 1;
          throw new Error('Unexpected microphone request');
        },
      } });
    });
    await page.goto(`/books/${book.id}/listen`);
    await page.getByRole('button', { name: 'Ask Cal' }).click();
    const composer = page.getByTestId('cal-input');
    await expect(composer).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Talk hands-free' })).toHaveCount(0);

    await page.evaluate(() => {
      Object.assign(window, { BookClubNative: { postMessage() {}, carPlayConnected: false } });
      window.dispatchEvent(new Event('bookclub:carplay-connection'));
    });
    await expect(page.getByRole('button', { name: 'Talk hands-free' })).toBeEnabled();
    await composer.fill('What did we hear so far?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('cal-message-assistant')).toHaveCount(1);
    expect(await page.evaluate(() => (window as Window & { microphoneRequests?: number }).microphoneRequests)).toBe(0);
  } finally {
    await context.close();
  }
});
