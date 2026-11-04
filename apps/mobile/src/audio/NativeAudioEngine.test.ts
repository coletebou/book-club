import { type AudioStatus } from 'expo-audio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_MODE, LOCK_SCREEN_OPTIONS, NativeAudioEngine } from './NativeAudioEngine';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(), download: vi.fn(), removeFile: vi.fn(),
  player: { addListener: vi.fn(), remove: vi.fn(), play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setPlaybackRate: vi.fn(), setActiveForLockScreen: vi.fn(), clearLockScreenControls: vi.fn(), updateLockScreenMetadata: vi.fn() },
  create: vi.fn(),
}));
vi.mock('expo-audio', () => ({ createAudioPlayer: mocks.create, setAudioModeAsync: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///private/', getInfoAsync: mocks.lookup, downloadAsync: mocks.download, deleteAsync: mocks.removeFile, makeDirectoryAsync: vi.fn() }));

let messages: Record<string, unknown>[];
let engine: NativeAudioEngine;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockReturnValue(mocks.player);
  mocks.lookup.mockResolvedValue({ exists: true });
  mocks.download.mockResolvedValue({ status: 200 });
  mocks.player.seekTo.mockResolvedValue(undefined);
  messages = [];
  engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>));
});
afterEach(() => { engine.handle(JSON.stringify({ type: 'unload' })); });
const load = () => engine.handle(JSON.stringify({ type: 'load', url: 'https://private.test/media/track?token=secret' }));
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const diagnostics = () => messages.filter((m) => m.type === 'diagnostic').map((m) => m.diagnostic);

function status(partial: Partial<AudioStatus>): AudioStatus {
  return { playing: false, isLoaded: true, isBuffering: false, playbackRate: 1, error: null, didJustFinish: false, currentTime: 10, duration: 100, ...partial } as AudioStatus;
}

describe('native audio diagnostics (mocked Expo modules)', () => {
  it('reports local file playback, without transmitting the URL/path/credentials', async () => {
    load(); await tick();
    expect(diagnostics()).toEqual([{ event: 'native-source', source: 'native-local' }]);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).not.toContain('secret');
    expect(JSON.stringify(messages)).not.toContain('/private/');
  });

  it('reports network playback and the background download result', async () => {
    mocks.lookup.mockResolvedValueOnce({ exists: false }).mockResolvedValue({ exists: true });
    load(); await tick(); await tick();
    expect(diagnostics()).toContainEqual({ event: 'native-source', source: 'native-network' });
    expect(diagnostics()).toContainEqual({ event: 'native-download', outcome: 'started' });
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'native-download', outcome: 'ok' }));
    expect(JSON.stringify(messages)).not.toContain('private.test');
  });

  it('measures seeks and records failure without raw native errors', async () => {
    load(); await tick();
    mocks.player.seekTo.mockRejectedValue(new Error('secret native file path'));
    engine.handle(JSON.stringify({ type: 'seek', time: 40 }));
    await tick();
    expect(diagnostics()).toContainEqual({ event: 'native-seek', outcome: 'started' });
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'native-seek', outcome: 'failed', durationMs: expect.any(Number) }));
    expect(JSON.stringify(diagnostics())).not.toContain('secret');
  });

  it('emits buffering transitions even when playing changes in the same status', async () => {
    load(); await tick();
    const onStatus = mocks.player.addListener.mock.calls[0]![1] as (s: AudioStatus) => void;
    onStatus(status({ playing: true, isBuffering: true }));
    expect(messages.filter((m) => m.type === 'status').map((m) => m.event)).toContain('waiting');
    expect(messages.filter((m) => m.type === 'status').map((m) => m.event)).not.toContain('playing');
    onStatus(status({ playing: true, isBuffering: false }));
    expect(messages.filter((m) => m.type === 'status').map((m) => m.event)).toContain('playing');
  });

  it('unload invalidates an in-flight file lookup so it cannot resurrect a player', async () => {
    let resolve!: (info: { exists: boolean }) => void;
    mocks.lookup.mockReturnValue(new Promise((r) => { resolve = r; }));
    load();
    engine.handle(JSON.stringify({ type: 'unload' }));
    resolve({ exists: true }); await tick();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('native playback speed (D195, mocked Expo modules)', () => {
  const setRate = (rate: unknown) => engine.handle(JSON.stringify({ type: 'setRate', rate }));

  it('plays any offered speed exactly, 0.05 steps too, with high-quality pitch correction', async () => {
    load(); await tick();
    for (const rate of [1.35, 1.05, 0.55, 2.5, 3]) setRate(rate);
    expect(mocks.player.setPlaybackRate.mock.calls.slice(1)).toEqual([[1.35, 'high'], [1.05, 'high'], [0.55, 'high'], [2.5, 'high'], [3, 'high']]);
  });

  it('gives the chosen speed to each new track as its player is made, before the page says so again', async () => {
    load(); await tick();
    setRate(1.35);
    mocks.player.setPlaybackRate.mockClear();
    load(); await tick();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.player.setPlaybackRate).toHaveBeenCalledWith(1.35, 'high');
    // It is set before the lock screen is claimed, so Now Playing never shows the new track at 1×.
    expect(mocks.player.setPlaybackRate.mock.invocationCallOrder[0]!).toBeLessThan(mocks.player.setActiveForLockScreen.mock.invocationCallOrder.at(-1)!);
  });

  it('a speed chosen before any track loads is the first track\'s', async () => {
    setRate(1.6);
    load(); await tick();
    expect(mocks.player.setPlaybackRate).toHaveBeenCalledWith(1.6, 'high');
  });

  it('ignores what is not a speed, rather than pausing or dropping to 1×', async () => {
    load(); await tick();
    setRate(1.5);
    mocks.player.setPlaybackRate.mockClear();
    for (const bad of [0, -1, null, 'fast', Number.NaN]) setRate(bad);
    engine.handle('{"type":"setRate","rate":1e999}');
    expect(mocks.player.setPlaybackRate).not.toHaveBeenCalled();
    load(); await tick();
    expect(mocks.player.setPlaybackRate).toHaveBeenCalledWith(1.5, 'high');
  });

  it('reports the rate native actually plays, so the page and Now Playing agree with it', async () => {
    load(); await tick();
    const onStatus = mocks.player.addListener.mock.calls[0]![1] as (s: AudioStatus) => void;
    onStatus(status({ playing: true, playbackRate: 1.35 }));
    const rates = messages.filter((m) => m.type === 'status' && m.event === 'ratechange').map((m) => m.playbackRate);
    expect(rates).toEqual([1.35]);
  });
});

describe('the lock screen and playing on while the page sleeps (D181, D182)', () => {
  const T0 = 'https://books.test/media/editions/e1/tracks/0';
  const T1 = 'https://books.test/media/editions/e1/tracks/1';
  const queue = (advance = true) => ({ type: 'queue', queue: { bookId: 'b1', editionId: 'e1', advance, tracks: [{ url: T0, title: 'One' }, { url: T1, title: 'Two' }] } });
  const send = (cmd: object) => engine.handle(JSON.stringify(cmd));
  const listener = () => mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void;
  const events = () => messages.filter((m) => m.type === 'status' || m.type === 'advanced').map((m) => (m.type === 'advanced' ? `advanced ${String(m.url)}` : m.event));

  it('asks iOS for a session that does not mix with other apps: only then is it the Now Playing app', () => {
    expect(AUDIO_MODE).toEqual(expect.objectContaining({ interruptionMode: 'doNotMix', shouldPlayInBackground: true, playsInSilentMode: true }));
    expect(LOCK_SCREEN_OPTIONS).toEqual(expect.objectContaining({ showSeekForward: true, showSeekBackward: true, seekForwardIntervalSeconds: 30, seekBackwardIntervalSeconds: 15, showNextTrack: false }));
  });

  it('shows the first (largest) artwork the page sends', async () => {
    send({ type: 'metadata', title: 'One', artist: 'A', album: 'B', artwork: ['https://books.test/cover?w=512', 'https://books.test/cover?w=96'] });
    send({ type: 'load', url: T0 }); await tick();
    expect(mocks.player.setActiveForLockScreen).toHaveBeenCalledWith(true, expect.objectContaining({ artworkUrl: 'https://books.test/cover?w=512', title: 'One' }), LOCK_SCREEN_OPTIONS);
  });

  it('gives each new player the speed chosen, as the page asleep cannot', async () => {
    send({ type: 'setRate', rate: 1.75 });
    send({ type: 'load', url: T0 }); await tick();
    expect(mocks.player.setPlaybackRate).toHaveBeenLastCalledWith(1.75);
  });

  it('goes on to the next track by itself: tells the page first, then plays it with its title', async () => {
    send(queue());
    send({ type: 'metadata', title: 'One', artist: 'A', album: 'B', artwork: [] });
    send({ type: 'load', url: T0 }); await tick();
    listener()(status({ playing: true, currentTime: 59 }));
    mocks.create.mockClear();
    listener()(status({ playing: false, didJustFinish: true, currentTime: 60, duration: 60 }));
    expect(events().slice(-2)).toEqual([`advanced ${T1}`, 'ended']);
    await tick(); await tick();
    expect(mocks.create).toHaveBeenCalledWith({ uri: expect.stringContaining('tracks_1') });
    expect(mocks.player.play).toHaveBeenCalled();
    expect(mocks.player.setActiveForLockScreen).toHaveBeenLastCalledWith(true, expect.objectContaining({ title: 'Two' }), LOCK_SCREEN_OPTIONS);
  });

  it('stops at a track’s end when the page says so (a party, sleeping at the track’s end), and at the last', async () => {
    send(queue(false));
    send({ type: 'load', url: T0 }); await tick();
    mocks.create.mockClear();
    listener()(status({ didJustFinish: true }));
    expect(events().at(-1)).toBe('ended');
    expect(events()).not.toContain(`advanced ${T1}`);
    send(queue());
    send({ type: 'load', url: T1 }); await tick();
    mocks.create.mockClear();
    listener()(status({ didJustFinish: true }));
    await tick();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('ignores a queue it cannot read', async () => {
    send({ type: 'queue', queue: { bookId: 'b1', tracks: 'no' } });
    send({ type: 'load', url: T0 }); await tick();
    listener()(status({ didJustFinish: true }));
    expect(events()).not.toContain(`advanced ${T1}`);
  });

  it('pauses itself when the sleep timer ends', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      send({ type: 'sleep', at: 5_000 });
      send({ type: 'load', url: T0 }); await tick();
      listener()(status({ playing: true }));
      expect(mocks.player.pause).not.toHaveBeenCalled();
      vi.setSystemTime(5_001);
      listener()(status({ playing: true }));
      expect(mocks.player.pause).toHaveBeenCalledTimes(1);
      listener()(status({ playing: true })); // once: a Play after it plays on
      expect(mocks.player.pause).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves the place itself while the app is in the background, for the page’s book and edition', async () => {
    let now = 10_000;
    const put = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const own: Record<string, unknown>[] = [];
    const background = new NativeAudioEngine((json) => own.push(JSON.parse(json) as Record<string, unknown>), { now: () => now, progress: { serverUrl: 'https://books.test', fetch: put, now: () => now, inBackground: () => true } });
    background.handle(JSON.stringify(queue()));
    background.handle(JSON.stringify({ type: 'load', url: T0 })); await tick();
    background.backgrounded();
    const onStatus = listener();
    for (let s = 0; s <= 62; s++) { onStatus(status({ playing: true, currentTime: s / 2 })); now += 500; }
    onStatus(status({ playing: false, currentTime: 31 }));
    await tick();
    expect(put.mock.calls.map((c) => c[0])).toEqual(['https://books.test/api/books/b1/progress', 'https://books.test/api/books/b1/progress']);
    const last = JSON.parse((put.mock.calls.at(-1)![1] as { body: string }).body) as { editionId: string; locator: unknown };
    expect(last).toEqual(expect.objectContaining({ editionId: 'e1', locator: { kind: 'audio', track: 0, ms: 31_000 } }));
    background.handle(JSON.stringify({ type: 'unload' }));
  });
});

describe('the place kept on the device, for the page opened again (D196)', () => {
  const T0 = 'https://books.test/media/editions/e1/tracks/0';
  const queue = { type: 'queue', queue: { bookId: 'b1', editionId: 'e1', userId: 'u1', advance: true, tracks: [{ url: T0, title: 'One' }] } };

  it('says when native saw the player so, in every status it sends', async () => {
    let now = 42_000;
    const own: Record<string, unknown>[] = [];
    const timed = new NativeAudioEngine((json) => own.push(JSON.parse(json) as Record<string, unknown>), { now: () => now });
    timed.handle(JSON.stringify({ type: 'load', url: T0 })); await tick();
    const onStatus = mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void;
    onStatus(status({ playing: true, currentTime: 5 }));
    now = 43_000;
    onStatus(status({ playing: true, currentTime: 6 }));
    const times = own.filter((m) => m.type === 'status' && m.event === 'timeupdate').map((m) => [m.currentTime, m.at]);
    expect(times).toEqual([[5, 42_000], [6, 43_000]]);
    timed.handle(JSON.stringify({ type: 'unload' }));
  });

  it('keeps what it hears on the device, and tells the page loaded again what an earlier run kept', async () => {
    let now = 100_000;
    const files: string[] = [];
    const own: Record<string, unknown>[] = [];
    const keeper = new NativeAudioEngine((json) => own.push(JSON.parse(json) as Record<string, unknown>), {
      now: () => now,
      progress: { serverUrl: 'https://books.test', fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }), now: () => now, inBackground: () => false, keep: (json) => { files.push(json); } },
    });
    keeper.handle(JSON.stringify(queue));
    keeper.handle(JSON.stringify({ type: 'load', url: T0 })); await tick();
    const onStatus = mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void;
    for (let s = 0; s <= 20; s++) { onStatus(status({ playing: true, currentTime: 60 + s / 2 })); now += 500; }
    onStatus(status({ playing: false, currentTime: 70.25 }));
    const kept = JSON.parse(files.at(-1)!) as { userId: string; locator: unknown; spans: unknown[] };
    expect(kept).toEqual(expect.objectContaining({ bookId: 'b1', editionId: 'e1', userId: 'u1', locator: { kind: 'audio', track: 0, ms: 70_250 } }));
    expect(kept.spans).toEqual([{ from: { kind: 'audio', track: 0, ms: 60_000 }, to: { kind: 'audio', track: 0, ms: 70_250 } }]);
    // Written every couple of seconds while playing, not on every status.
    expect(files.length).toBeLessThan(10);
    keeper.handle(JSON.stringify({ type: 'unload' }));

    // The app ended and started again: the page asks, and hears what was kept.
    const again: Record<string, unknown>[] = [];
    const next = new NativeAudioEngine((json) => again.push(JSON.parse(json) as Record<string, unknown>), {
      progress: { serverUrl: 'https://books.test', fetch: vi.fn(), now: () => now, inBackground: () => false },
      readKept: () => Promise.resolve(files.at(-1)!),
    });
    next.handle(JSON.stringify({ type: 'tellKept' }));
    await tick();
    expect(again).toEqual([{ type: 'kept', kept: expect.objectContaining({ bookId: 'b1', userId: 'u1', locator: { kind: 'audio', track: 0, ms: 70_250 } }) }]);
  });

  it('answers that nothing was kept, and never what it cannot read', async () => {
    const own: Record<string, unknown>[] = [];
    const empty = new NativeAudioEngine((json) => own.push(JSON.parse(json) as Record<string, unknown>), {
      progress: { serverUrl: 'https://books.test', fetch: vi.fn(), now: () => 1, inBackground: () => false },
      readKept: () => Promise.resolve('{"bookId": "b1", "half-written'),
    });
    empty.handle(JSON.stringify({ type: 'tellKept' }));
    await tick();
    expect(own).toEqual([{ type: 'kept', kept: null }]);
  });
});
