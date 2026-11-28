import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  carCommand: undefined as ((event: { id: string }) => void) | undefined,
  appState: undefined as ((state: string) => void) | undefined,
  setCarPlayModel: vi.fn<(json: string) => void>(),
  fetch: vi.fn<typeof fetch>(),
  nativeConnection: undefined as (() => boolean) | undefined,
  setAudioMode: vi.fn(async (_mode: { allowsRecording?: boolean }) => {}),
}));

vi.mock('../../modules/book-club-native', () => ({
  BookClubNative: {
    addListener: (name: string, listener: (event: { id: string }) => void) => {
      if (name === 'onCarPlayCommand') mocks.carCommand = listener;
    },
    clearWidgets: vi.fn(), widgetSnapshot: () => null, setCarPlayModel: mocks.setCarPlayModel, setWatchNowPlaying: vi.fn(),
    get isCarPlayConnected() { return mocks.nativeConnection; },
  },
}));
vi.mock('expo-audio', () => ({ createAudioPlayer: vi.fn(), setAudioModeAsync: mocks.setAudioMode }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///private/', cacheDirectory: null,
  getInfoAsync: vi.fn(async () => ({ exists: false })), deleteAsync: vi.fn(async () => {}),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: 17 },
  AppState: { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => { mocks.appState = listener; } },
}));
vi.mock('../config', () => ({ SERVER_URL: 'https://books.test' }));

function controls(): string[] {
  const model = JSON.parse(mocks.setCarPlayModel.mock.calls.at(-1)![0]) as { controls: { buttons: { id: string }[] } };
  return model.controls.buttons.map(({ id }) => id);
}

describe('CarPlay Cal controls in the app shell', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.nativeConnection = undefined;
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('checks on connect, coalesces refreshes, and retains confirmed controls on an older server', async () => {
    mocks.fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })).mockResolvedValueOnce(Response.json({ enabled: false }))
      .mockResolvedValueOnce(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    await import('./appAudio');
    expect(controls()).toContain('cal');
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
    expect(controls()).toContain('cal');

    mocks.appState!('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(controls()).not.toContain('cal');
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
});
