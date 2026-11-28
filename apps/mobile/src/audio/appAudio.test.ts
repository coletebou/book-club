import { type AudioStatus } from 'expo-audio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  carCommand: undefined as ((event: { id: string }) => void) | undefined,
  appState: undefined as ((state: string) => void) | undefined,
  setCarPlayModel: vi.fn<(json: string) => void>(),
  widgetJson: null as string | null,
  setWidgetSnapshot: vi.fn<(json: string) => Promise<void>>(),
  createPlayer: vi.fn(),
  removeFile: vi.fn(async (_file: string) => {}),
  fetch: vi.fn<typeof fetch>(),
  nativeConnection: undefined as (() => boolean) | undefined,
  platformVersion: 17,
  setAudioMode: vi.fn(async (_mode: { allowsRecording?: boolean }) => {}),
}));

vi.mock('../../modules/book-club-native', () => ({
  BookClubNative: {
    addListener: (name: string, listener: (event: { id: string }) => void) => {
      if (name === 'onCarPlayCommand') mocks.carCommand = listener;
    },
    clearWidgets: vi.fn(), widgetSnapshot: () => mocks.widgetJson, setWidgetSnapshot: mocks.setWidgetSnapshot,
    setCarPlayModel: mocks.setCarPlayModel, setWatchNowPlaying: vi.fn(),
    get isCarPlayConnected() { return mocks.nativeConnection; },
  },
}));
vi.mock('expo-audio', () => ({ createAudioPlayer: mocks.createPlayer, setAudioModeAsync: mocks.setAudioMode }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///private/', cacheDirectory: null,
  getInfoAsync: vi.fn(async () => ({ exists: false })), deleteAsync: mocks.removeFile,
  readDirectoryAsync: vi.fn(async () => []), writeAsStringAsync: vi.fn(async () => {}),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', get Version() { return mocks.platformVersion; } },
  AppState: { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => { mocks.appState = listener; } },
}));
vi.mock('../config', () => ({ SERVER_URL: 'https://books.test' }));

function controls(): string[] {
  const model = JSON.parse(mocks.setCarPlayModel.mock.calls.at(-1)![0]) as { controls: { buttons: { id: string }[] } };
  return model.controls.buttons.map(({ id }) => id);
}

function audioPlayer() {
  return {
    currentTime: 12, playing: true, addListener: vi.fn<(name: string, listen: (status: AudioStatus) => void) => void>(),
    setPlaybackRate: vi.fn(), setActiveForLockScreen: vi.fn(), play: vi.fn(), pause: vi.fn(),
    clearLockScreenControls: vi.fn(), remove: vi.fn(),
  };
}

describe('CarPlay Cal controls in the app shell', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.widgetJson = null;
    mocks.nativeConnection = undefined;
    mocks.platformVersion = 17;
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps Cal hidden until the account allows it and coalesces checks on connect', async () => {
    mocks.fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })).mockResolvedValueOnce(Response.json({ enabled: true }))
      .mockResolvedValueOnce(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    await import('./appAudio');
    expect(controls()).not.toContain('cal');
    expect(mocks.fetch).not.toHaveBeenCalled();

    mocks.carCommand!({ id: 'connected' });
    mocks.appState!('active');
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('https://books.test/api/cal/spoken/status', {
      credentials: 'include', signal: expect.any(AbortSignal),
    });
    const signal = mocks.fetch.mock.calls[0]![1]!.signal;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(controls()).not.toContain('cal');

    mocks.appState!('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(controls()).toContain('cal');
    expect(controls()).toContain('react');
    mocks.appState!('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(controls()).not.toContain('cal');
  });

  it('uses the native state on the first page and gives it precedence over an older queued edge', async () => {
    let connected = true;
    mocks.nativeConnection = () => connected;
    mocks.fetch.mockResolvedValue(Response.json({ enabled: true }));
    const { attachPage, carPlayConnection } = await import('./appAudio');
    expect(mocks.setAudioMode).toHaveBeenLastCalledWith(expect.objectContaining({ allowsRecording: false }));
    const report = vi.fn();
    attachPage(vi.fn(), report);
    expect(report).toHaveBeenLastCalledWith(true);
    mocks.carCommand!({ id: 'disconnected' });
    expect(report).toHaveBeenLastCalledWith(true);
    connected = false;
    expect(carPlayConnection()).toBe(false);
    mocks.carCommand!({ id: 'disconnected' });
    expect(report).toHaveBeenLastCalledWith(false);
    expect(mocks.setAudioMode).toHaveBeenLastCalledWith(expect.objectContaining({ allowsRecording: true }));
  });

  it.each([
    { version: 16, sheetUnavailable: false },
    { version: 17, sheetUnavailable: true },
  ])('turns off chapter-end sleep without an action sheet on iOS $version', async ({ version, sheetUnavailable }) => {
    vi.setSystemTime(1_000);
    mocks.platformVersion = version;
    mocks.fetch.mockResolvedValue(Response.json({ enabled: false }));
    const player = audioPlayer();
    mocks.createPlayer.mockReturnValue(player);
    const { attachPage, engine } = await import('./appAudio');
    const toPage = vi.fn<(json: string) => void>();
    attachPage(toPage, vi.fn());
    const first = 'https://books.test/first.m4a';
    const next = 'https://books.test/next.m4a';
    const send = (command: object) => engine.handle(JSON.stringify(command));
    send({ type: 'queue', queue: { bookId: 'book', editionId: 'edition', userId: 'reader', advance: false, inParty: false,
      tracks: [{ url: first, title: 'First' }, { url: next, title: 'Next' }] } });
    send({ type: 'load', url: first });
    send({ type: 'play' });
    send({ type: 'sleep', at: null, trackEnd: true, sleepCommandId: 'chapter-end' });
    await vi.advanceTimersByTimeAsync(0);
    const report = player.addListener.mock.calls[0]![1];
    const playing = { isLoaded: true, playing: true, currentTime: 12, duration: 60, playbackRate: 1 } as AudioStatus;
    report(playing);
    const timerReportedToPage = () => toPage.mock.calls.map(([json]) => JSON.parse(json))
      .findLast(({ event }) => event === 'timeupdate');
    expect(timerReportedToPage()).toMatchObject({ sleepUntil: null, sleepAtTrackEnd: true, sleepCommandId: 'chapter-end' });
    mocks.carCommand!({ id: 'connected' });
    mocks.carCommand!({ id: 'control:sleep' });
    await vi.advanceTimersByTimeAsync(0);
    const nav = () => JSON.parse(mocks.setCarPlayModel.mock.calls.at(-1)![0]).nav;
    if (sheetUnavailable) {
      expect(nav()).toMatchObject({ to: 'sheet', message: 'Sleep timer' });
      mocks.carCommand!({ id: 'sheet:unavailable' });
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(nav()).toMatchObject({ to: 'message', message: 'Sleep timer off' });
    expect(engine.sleepTimer()).toEqual({ at: null, trackEnd: false });
    report({ ...playing, currentTime: 13 });
    expect(timerReportedToPage()).toMatchObject({ sleepUntil: null, sleepAtTrackEnd: false, sleepCommandId: 'chapter-end' });
    report({ isLoaded: true, didJustFinish: true, currentTime: 60, duration: 60, playbackRate: 1 } as AudioStatus);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.createPlayer).toHaveBeenLastCalledWith({ uri: next });
  });

  it('applies CarPlay sleep and speed choices while the next audiobook chapter is loading', async () => {
    vi.setSystemTime(1_000);
    mocks.fetch.mockResolvedValue(Response.json({ enabled: false }));
    const first = audioPlayer();
    const next = audioPlayer();
    mocks.createPlayer.mockReturnValueOnce(first).mockReturnValueOnce(next);
    const { engine } = await import('./appAudio');
    const tracks = ['https://books.test/first.m4a', 'https://books.test/next.m4a'];
    const send = (command: object) => engine.handle(JSON.stringify(command));
    send({ type: 'queue', queue: { bookId: 'book', editionId: 'edition', userId: 'reader', advance: true, inParty: false,
      tracks: tracks.map((url) => ({ url, title: 'Chapter' })) } });
    send({ type: 'load', url: tracks[0] });
    send({ type: 'play' });
    send({ type: 'sleep', at: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    const playing = { isLoaded: true, playing: true, currentTime: 12, duration: 60, playbackRate: 1 } as AudioStatus;
    const reportFirst = first.addListener.mock.calls[0]![1];
    reportFirst(playing);
    mocks.carCommand!({ id: 'connected' });
    mocks.carCommand!({ id: 'control:sleep' });
    await vi.advanceTimersByTimeAsync(0);
    const nav = () => JSON.parse(mocks.setCarPlayModel.mock.calls.at(-1)![0]).nav;
    expect(nav()).toMatchObject({ to: 'sheet', message: 'Sleep timer' });

    reportFirst({ ...playing, didJustFinish: true, playing: false, currentTime: 60 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.createPlayer).toHaveBeenLastCalledWith({ uri: tracks[1] });
    expect(engine.livePlace()).toBeNull();
    mocks.carCommand!({ id: 'control:sleep:off' });
    await vi.advanceTimersByTimeAsync(0);
    expect(nav()).toMatchObject({ to: 'message', message: 'Sleep timer off' });
    expect(engine.sleepTimer().at).toBeNull();

    mocks.carCommand!({ id: 'control:speed' });
    expect(next.setPlaybackRate).toHaveBeenLastCalledWith(1.25, 'high');
    mocks.carCommand!({ id: 'control:react' });
    expect(nav()).toMatchObject({ to: 'message', message: 'Nothing is playing' });
    vi.setSystemTime(5_001);
    next.setPlaybackRate.mockClear();
    const reportNext = next.addListener.mock.calls[0]![1];
    reportNext({ ...playing, currentTime: 0 });
    expect(next.setPlaybackRate).toHaveBeenCalledExactlyOnceWith(1.25, 'high');
    reportNext({ ...playing, currentTime: 0.25 });
    expect(next.setPlaybackRate).toHaveBeenCalledTimes(1);
    expect(next.pause).not.toHaveBeenCalled();
  });

  it('hides the car control immediately when the account consent changes on the phone', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ enabled: true })).mockResolvedValueOnce(Response.json({ enabled: false }));
    const { extras } = await import('./appAudio');
    mocks.carCommand!({ id: 'connected' });
    await vi.advanceTimersByTimeAsync(0);
    expect(controls()).toContain('cal');
    mocks.carCommand!({ id: 'control:cal' });
    const navigation = () => (JSON.parse(mocks.setCarPlayModel.mock.calls.at(-1)![0]) as { nav: { to: string } }).nav.to;
    expect(navigation()).toBe('sheet');
    extras.handle(JSON.stringify({ type: 'cal-consent-changed' }));
    expect(controls()).not.toContain('cal');
    expect(navigation()).toBe('dismiss');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(controls()).not.toContain('cal');
  });

  it('aborts stale checks on sign-out and disconnect and starts a fresh one on sign-in', async () => {
    let resolveOld!: (response: Response) => void;
    mocks.fetch.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(Response.json({ enabled: false }))
      .mockReturnValueOnce(new Promise(() => {}));
    const { extras } = await import('./appAudio');
    const snapshot = (signedIn: boolean) => extras.handle(JSON.stringify({ type: 'widgets', snapshot: { current: null }, signedIn }));

    mocks.carCommand!({ id: 'connected' });
    snapshot(false);
    expect(mocks.fetch.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    mocks.appState!('active');
    expect(mocks.fetch).toHaveBeenCalledOnce();

    snapshot(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(controls()).not.toContain('cal');
    resolveOld(Response.json({ enabled: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(controls()).not.toContain('cal');

    mocks.appState!('active');
    mocks.carCommand!({ id: 'disconnected' });
    expect(mocks.fetch.mock.calls[2]![1]!.signal?.aborted).toBe(true);
    expect(controls()).not.toContain('cal');
  });

  it('clears old playback, queues and requests on an account change before publishing new covers', async () => {
    vi.setSystemTime(1_000);
    const player = audioPlayer();
    mocks.createPlayer.mockReturnValue(player);
    mocks.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    mocks.setWidgetSnapshot.mockImplementation(async (json) => { mocks.widgetJson = json; });

    const { engine, extras } = await import('./appAudio');
    const record = {
      bookId: 'shared-book', clubId: 'shared-club', clubName: 'Book Club', title: 'Shared book', author: 'Author',
      coverUrl: 'https://books.test/cover', t: 0.12, percent: 12, label: 'Chapter 1', format: 'audio', finished: false, at: 1_000, stop: null,
    };
    const snapshot = (userId: string) => extras.handle(JSON.stringify({
      type: 'widgets', signedIn: true, userId, snapshot: { generatedAt: 1_000, current: record, others: [] },
    }));
    const bookRows = () => (JSON.parse(mocks.setCarPlayModel.mock.calls.at(-1)![0]) as { books: { playable: boolean }[] }).books;
    const queue = {
      bookId: record.bookId, editionId: 'edition-old', userId: 'old-reader', advance: true,
      tracks: [{ url: 'https://books.test/old-audio.m4a', title: 'Chapter 1' }],
    };
    snapshot(queue.userId);
    await vi.advanceTimersByTimeAsync(0);
    mocks.carCommand!({ id: 'connected' });
    engine.handle(JSON.stringify({ type: 'queue', queue }));
    const playing = engine.playFromCar(queue, { title: 'Chapter 1' }, 0, 0);
    await vi.advanceTimersByTimeAsync(0);
    player.addListener.mock.calls[0]![1]({ isLoaded: true, playing: true, currentTime: 12, duration: 60, playbackRate: 1 } as AudioStatus);
    await expect(playing).resolves.toBe(true);
    expect(await engine.keptPlace()).toMatchObject({ userId: queue.userId });
    expect(bookRows()).toEqual([expect.objectContaining({ playable: true })]);

    const prewarm = engine.prewarmCarStart({ ...queue, tracks: [{ url: 'https://books.test/media/editions/edition-old/tracks/0', title: 'Chapter 1' }] }, 0, () => true);
    await vi.advanceTimersByTimeAsync(0);
    const signalFor = (url: string) => mocks.fetch.mock.calls.find(([input]) => String(input).endsWith(url))?.[1]?.signal;
    const oldConsent = signalFor('/api/cal/spoken/status');
    const oldTicket = signalFor('/api/media/ticket');
    expect(oldConsent?.aborted).toBe(false);
    expect(oldTicket?.aborted).toBe(false);

    let finishCover!: () => void;
    mocks.setWidgetSnapshot.mockImplementationOnce(async (json) => {
      await new Promise<void>((resolve) => { finishCover = resolve; });
      mocks.widgetJson = json;
    });
    snapshot('new-reader');
    expect(engine.drivenByCar()).toBe(false);
    expect(engine.livePlace()).toBeNull();
    expect(await engine.keptPlace()).toBeNull();
    expect(bookRows()).toEqual([]);
    expect(player.remove).toHaveBeenCalledOnce();
    expect(oldConsent?.aborted).toBe(true);
    expect(oldTicket?.aborted).toBe(true);
    await prewarm;
    expect(mocks.removeFile.mock.calls.map(([file]) => file)).toEqual(expect.arrayContaining([
      'file:///private/bookclub-kept-queues.json', 'file:///private/bookclub-kept-place.json',
    ]));

    finishCover();
    await vi.advanceTimersByTimeAsync(0);
    expect(bookRows()).toEqual([expect.objectContaining({ playable: false })]);
    expect(mocks.fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/cal/spoken/status'))).toHaveLength(2);
  });
});
