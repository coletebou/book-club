import { devices, expect, test } from '@playwright/test';
import { allowCal, browserAs, clubWithAlice } from '../helpers/api';
import { useWebKitMicrophoneStandIn } from '../helpers/microphone';

test('Ask Cal from the player and reader dock takes hands-free turns and releases the microphone', async ({ browser, browserName }, testInfo) => {
  const { club, book } = await clubWithAlice([], { audio: 'tiny' });
  await allowCal(club.owner);
  const context = await browserAs(browser, club.owner, {
    ...(browserName === 'webkit' ? devices['iPhone 15'] : {
      viewport: { width: 1280, height: 844 },
      permissions: ['microphone'],
    }),
    audioOnlyView: true,
    serviceWorkers: 'block',
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
    const starts: string[] = [];
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/ws/cal/voice')) return;
      connections.push(socket.url());
      socket.on('framesent', ({ payload }) => {
        if (typeof payload === 'string' && (JSON.parse(payload) as { type?: string }).type === 'start') starts.push(payload);
      });
    });

    await page.goto(`/books/${book.id}/listen`);
    const play = page.getByTestId('play-pause');
    await play.click();
    await expect(play).toHaveAttribute('data-playing', 'true');
    await page.getByRole('button', { name: 'Ask Cal by voice', exact: true }).click();
    const status = page.getByTestId('cal-voice-status');
    await expect(status).toHaveText('Listening…');
    await expect(play).toHaveAttribute('data-playing', 'false');

    const progress = `/api/books/${book.id}/progress`;
    let releaseSave!: () => void;
    const saving = new Promise<void>((resolve) => { releaseSave = resolve; });
    await page.route(`**${progress}`, async (route) => {
      if (route.request().method() === 'PUT') await saving;
      await route.continue();
    });
    const saveRequest = page.waitForRequest((request) => request.method() === 'PUT' && new URL(request.url()).pathname === progress);
    try {
      for (let turn = 1; turn <= 2; turn += 1) {
        await page.waitForTimeout(350); // let the recorder measure the room before speaking
        await page.evaluate(() => { (window as Window & { speechLevel?: number }).speechLevel = 0.1; });
        // A few hundred milliseconds exceed the analyser's sustained-speech threshold.
        await page.waitForTimeout(450);
        await page.evaluate(() => { (window as Window & { speechLevel?: number }).speechLevel = 0; });
        if (turn === 1) {
          await saveRequest;
          expect(starts).toHaveLength(0);
          releaseSave();
        }
        await expect(page.getByTestId('cal-message-assistant')).toHaveCount(turn);
        await expect(status).toHaveText('Listening…');
      }
    } finally {
      releaseSave();
    }
    expect(connections).toHaveLength(1);
    expect(starts).toHaveLength(2);
    await testInfo.attach('hands-free follow-up', { body: await page.getByRole('dialog', { name: 'Ask Cal' }).screenshot(), contentType: 'image/png' });

    await page.getByRole('button', { name: 'Stop voice conversation' }).click();
    await expect(status).toBeEmpty();
    await expect(page.getByRole('button', { name: 'Talk hands-free' })).toBeEnabled();
    await expect(page.getByTestId('cal-input')).toBeEnabled();

    const newSocket = page.waitForEvent('websocket', { predicate: (socket) => socket.url().includes('/ws/cal/voice') });
    await page.getByRole('button', { name: 'Talk hands-free' }).click();
    const closed = (await newSocket).waitForEvent('close');
    await expect(status).toHaveText('Listening…');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Reflect.deleteProperty(document, 'hidden');
    });
    await closed;
    await expect(status).toBeEmpty();
    await expect(page.getByRole('button', { name: 'Talk hands-free' })).toBeEnabled();

    // A WebView has its bridge before the app mounts. Replacing the browser audio engine with
    // a native one mid-page would exercise a different transition from a car connection.
    const durationMs = book.editions.find((edition) => edition.kind === 'audio')!.tracks[0]!.durationMs;
    await page.addInitScript((duration) => {
      const device = window as Window & { __bookClubReceive?: (json: string) => void };
      const report = (event: string, paused: boolean) => queueMicrotask(() => {
        device.__bookClubReceive?.(JSON.stringify({
          type: 'status', event, paused, duration, currentTime: 0, ended: false, playbackRate: 1, readyState: 2,
        }));
      });
      Object.assign(device, {
        BookClubNative: {
          carPlayConnected: false,
          postMessage(json: string) {
            const command = JSON.parse(json) as { type: string; willPlay?: boolean };
            if (command.type === 'load') {
              report('loadedmetadata', !command.willPlay);
              if (command.willPlay) report('play', false);
            } else if (command.type === 'play' || command.type === 'pause') {
              report(command.type, command.type === 'pause');
            }
          },
        },
      });
    }, durationMs / 1000);
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => {
      const device = window as Window & { calCapture?: { opened: number; stopped: number } };
      const capture = { opened: 0, stopped: 0 };
      device.calCapture = capture;
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async (constraints: MediaStreamConstraints) => {
        const stream = await getUserMedia(constraints);
        const tracks = stream.getTracks();
        Object.defineProperty(stream, 'getTracks', { value: () => tracks });
        for (const track of tracks) {
          capture.opened += 1;
          const stop = track.stop.bind(track);
          let stopped = false;
          Object.defineProperty(track, 'stop', { value: () => {
            if (!stopped) capture.stopped += 1;
            stopped = true;
            stop();
          } });
        }
        return stream;
      } });
    });
    await page.getByTestId('listen-here').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('data-playing', 'true');
    await page.getByRole('button', { name: 'Ask Cal by voice about the audiobook' }).click();
    await expect(status).toHaveText('Listening…');
    await page.evaluate(() => {
      const bridge = (window as Window & { BookClubNative?: { carPlayConnected: boolean } }).BookClubNative;
      if (!bridge) throw new Error('The native bridge fixture is missing.');
      bridge.carPlayConnected = true;
      window.dispatchEvent(new Event('bookclub:carplay-connection'));
    });
    await expect(status).toBeEmpty();
    await expect(page.getByTestId('cal-input')).toBeEnabled();
    expect(await page.evaluate(() => (window as Window & { calCapture?: { opened: number; stopped: number } }).calCapture))
      .toEqual({ opened: 1, stopped: 1 });
  } finally {
    await context.close();
  }
});

test('Ask Cal from the player with CarPlay connected opens a typed chat', async ({ browser, browserName }) => {
  const { club, book } = await clubWithAlice([], { audio: 'tiny' });
  await allowCal(club.owner);
  const context = await browserAs(browser, club.owner, {
    ...(browserName === 'webkit' ? devices['iPhone 15'] : {}),
    audioOnlyView: true,
    serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const device = window as Window & { microphoneRequests?: number };
      Object.assign(window, { BookClubNative: { postMessage() {}, carPlayConnected: true } });
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
    await page.getByRole('button', { name: 'Ask Cal', exact: true }).click();
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
    const microphoneRequests = () => page.evaluate(() => (window as Window & { microphoneRequests?: number }).microphoneRequests);
    expect(await microphoneRequests()).toBe(0);

    for (const interrupt of ['car', 'history']) {
      await page.getByRole('dialog', { name: 'Ask Cal' }).getByRole('button', { name: 'Close' }).click();
      const conversations = `/api/clubs/${club.id}/cal/conversations`;
      let releaseSelection!: () => void;
      const selecting = new Promise<void>((resolve) => { releaseSelection = resolve; });
      await page.route(`**${conversations}`, async (route) => {
        if (route.request().method() === 'GET') await selecting;
        await route.continue();
      });
      try {
        const request = page.waitForRequest((request) => request.method() === 'GET' && new URL(request.url()).pathname === conversations);
        await page.getByRole('button', { name: 'Ask Cal by voice', exact: true }).click();
        await request;
        if (interrupt === 'history') {
          await page.getByRole('button', { name: 'Your chats with Cal' }).click();
        } else {
          await page.evaluate(() => {
            for (const connected of [true, false]) {
              Object.assign(window, { BookClubNative: { postMessage() {}, carPlayConnected: connected } });
              window.dispatchEvent(new Event('bookclub:carplay-connection'));
            }
          });
        }
      } finally {
        releaseSelection();
      }
      await expect(page.getByTestId('cal-new-chat')).toBeEnabled();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByTestId('cal-voice-status')).toBeEmpty();
      await expect(page.getByRole('button', { name: 'Your chats with Cal' })).toBeEnabled();
      expect(await microphoneRequests()).toBe(0);
      await page.unroute(`**${conversations}`);
    }
  } finally {
    await context.close();
  }
});
