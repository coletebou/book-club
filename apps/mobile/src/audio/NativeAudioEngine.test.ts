import { offlineBaseName } from '@bookclub/shared';
import { type AudioStatus } from 'expo-audio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_MODE, CAR_AUDIO_MODE, LOCK_SCREEN_OPTIONS, NativeAudioEngine } from './NativeAudioEngine';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(), download: vi.fn(), removeFile: vi.fn(), list: vi.fn(), read: vi.fn(), move: vi.fn(),
  player: { currentTime: 0, currentStatus: undefined as AudioStatus | undefined, playing: false, addListener: vi.fn(), remove: vi.fn(), replace: vi.fn(), play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setPlaybackRate: vi.fn(), setActiveForLockScreen: vi.fn(), clearLockScreenControls: vi.fn(), updateLockScreenMetadata: vi.fn() },
  create: vi.fn(),
}));
vi.mock('expo-audio', () => ({ createAudioPlayer: mocks.create, setAudioModeAsync: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///private/', getInfoAsync: mocks.lookup, downloadAsync: mocks.download, deleteAsync: mocks.removeFile, makeDirectoryAsync: vi.fn(), readDirectoryAsync: mocks.list, readAsStringAsync: mocks.read, moveAsync: mocks.move }));

const URL_ = 'https://private.test/media/track?token=secret';
const DIR = 'file:///private/bookclub-audio/';
const BASE = offlineBaseName(URL_);
/** The first bytes of real files, as expo-file-system reads them (base64). */
const MP3_HEAD = 'SUQzBAAAAAAAIlRT'; // ID3
const M4A_HEAD = 'AAAAHGZ0eXBNNEEg'; // ....ftypM4A
const HTML_HEAD = 'PCFkb2N0eXBlIGh0'; // <!doctype ht

let messages: Record<string, unknown>[];
let engine: NativeAudioEngine;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.player.currentTime = 0;
  mocks.player.currentStatus = undefined;
  mocks.player.playing = false;
  mocks.player.addListener.mockReturnValue({ remove: vi.fn() });
  mocks.create.mockReturnValue(mocks.player);
  mocks.lookup.mockResolvedValue({ exists: true });
  mocks.list.mockResolvedValue([`${BASE}.mp3`]);
  mocks.read.mockResolvedValue(MP3_HEAD);
  mocks.move.mockResolvedValue(undefined);
  mocks.removeFile.mockResolvedValue(undefined);
  mocks.download.mockResolvedValue({ status: 200 });
  mocks.player.seekTo.mockResolvedValue(undefined);
  messages = [];
  engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>));
});
afterEach(() => { engine.handle(JSON.stringify({ type: 'unload' })); });
const load = () => engine.handle(JSON.stringify({ type: 'load', url: URL_ }));
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
    mocks.list.mockResolvedValueOnce([]);
    load(); await tick(); await tick(); await tick();
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
    let resolve!: (entries: string[]) => void;
    mocks.list.mockReturnValue(new Promise((r) => { resolve = r; }));
    load();
    engine.handle(JSON.stringify({ type: 'unload' }));
    resolve([`${BASE}.mp3`]); await tick();
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
    // While a car is connected the same session, without recording (D232, Apple's CarPlay guide).
    expect(CAR_AUDIO_MODE).toEqual({ ...AUDIO_MODE, allowsRecording: false });
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
    // No copy of track 1 on the device (the listing has only another track's): it streams.
    expect(mocks.create).toHaveBeenCalledWith({ uri: T1 });
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

describe('offline copies iOS can open (D219, mocked Expo modules)', () => {
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const uris = () => mocks.create.mock.calls.map((c) => (c[0] as { uri: string }).uri);
  const statusEvents = () => messages.filter((m) => m.type === 'status').map((m) => m.event);
  const listener = (n: number) => mocks.player.addListener.mock.calls[n]![1] as (s: AudioStatus) => void;

  it('plays a typed copy from the device', async () => {
    load(); await settle();
    expect(uris()).toEqual([`${DIR}${BASE}.mp3`]);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('gives a copy kept by an earlier build (no extension, which iOS cannot open) the extension its bytes say, and plays it', async () => {
    mocks.list.mockResolvedValue([BASE]);
    load(); await settle();
    expect(mocks.read).toHaveBeenCalledWith(`${DIR}${BASE}`, { encoding: 'base64', position: 0, length: 12 });
    expect(mocks.move).toHaveBeenCalledWith({ from: `${DIR}${BASE}`, to: `${DIR}${BASE}.mp3` });
    expect(uris()).toEqual([`${DIR}${BASE}.mp3`]);
    expect(diagnostics()).toContainEqual({ event: 'native-source', source: 'native-local' });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('never plays an extensionless file: one that is not audio is deleted, and the track streams', async () => {
    mocks.list.mockResolvedValueOnce([BASE]).mockResolvedValue([]);
    mocks.read.mockResolvedValueOnce(HTML_HEAD).mockResolvedValue(M4A_HEAD);
    load(); await settle();
    expect(mocks.removeFile).toHaveBeenCalledWith(`${DIR}${BASE}`, { idempotent: true });
    expect(uris()).toEqual([URL_]);
    expect(uris().some((u) => u === `${DIR}${BASE}`)).toBe(false);
  });

  it('drops a leftover untyped copy when a typed one is there too', async () => {
    mocks.list.mockResolvedValue([BASE, `${BASE}.m4a`]);
    load(); await settle();
    expect(mocks.removeFile).toHaveBeenCalledWith(`${DIR}${BASE}`, { idempotent: true });
    expect(uris()).toEqual([`${DIR}${BASE}.m4a`]);
  });

  it('downloads under a name it never plays, and keeps it under the extension its bytes say', async () => {
    mocks.list.mockResolvedValue([]);
    mocks.read.mockResolvedValue(M4A_HEAD);
    load(); await settle();
    expect(mocks.download).toHaveBeenCalledWith(URL_, `${DIR}${BASE}.part`);
    expect(mocks.move).toHaveBeenCalledWith({ from: `${DIR}${BASE}.part`, to: `${DIR}${BASE}.m4a` });
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'native-download', outcome: 'ok' }));
  });

  it('keeps no copy of a 200 whose body is not audio (a sign-in page), nor of an error status', async () => {
    mocks.list.mockResolvedValue([]);
    mocks.read.mockResolvedValue(HTML_HEAD);
    load(); await settle();
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.removeFile).toHaveBeenCalledWith(`${DIR}${BASE}.part`, { idempotent: true });
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'native-download', outcome: 'failed' }));
    mocks.download.mockResolvedValue({ status: 401 });
    engine.handle(JSON.stringify({ type: 'load', url: `${URL_}2` })); await settle();
    expect(mocks.move).not.toHaveBeenCalled();
  });

  it('a kept copy that fails to play: reported content-free, dropped, and the same track goes on from the network, no error for the page', async () => {
    load(); await settle();
    engine.handle(JSON.stringify({ type: 'play' }));
    listener(0)(status({ isLoaded: false, playing: false, currentTime: 0, error: 'Cannot Open /private/var/x secret', errorDomain: 'AVFoundationErrorDomain', errorCode: -11828 } as Partial<AudioStatus>));
    await settle();
    expect(diagnostics()).toContainEqual({ event: 'native-error', outcome: 'failed', source: 'native-local', recovered: true, errorDomain: 'AVFoundationErrorDomain', errorCode: -11828 });
    expect(statusEvents()).not.toContain('error');
    expect(uris()).toEqual([`${DIR}${BASE}.mp3`, URL_]);
    expect(mocks.player.play).toHaveBeenCalledTimes(2); // the page's play, then the recovery's
    expect(mocks.removeFile).toHaveBeenCalledWith(`${DIR}${BASE}.mp3`, { idempotent: true });
    expect(mocks.download).not.toHaveBeenCalled(); // not again this run
    expect(JSON.stringify(messages)).not.toContain('secret');
    expect(JSON.stringify(messages)).not.toContain('Cannot Open');
  });

  it('resumes where a kept copy failed partway, paused if it was paused', async () => {
    load(); await settle();
    listener(0)(status({ isLoaded: true, currentTime: 0 }));
    listener(0)(status({ isLoaded: true, currentTime: 0, error: 'truncated' }));
    await settle();
    expect(uris()[1]).toBe(URL_);
    expect(mocks.player.play).not.toHaveBeenCalled();
    load(); await settle();
    const n = mocks.player.addListener.mock.calls.length - 1;
    listener(n)(status({ isLoaded: true, currentTime: 754 }));
    expect(uris().at(-1)).toBe(URL_); // this run, the track whose copy failed streams
    // the same flow mid-chapter, from a fresh engine with a good typed copy
    engine.handle(JSON.stringify({ type: 'unload' }));
    engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>));
    mocks.player.seekTo.mockClear();
    load(); await settle();
    const m = mocks.player.addListener.mock.calls.length - 1;
    listener(m)(status({ isLoaded: true, currentTime: 754 }));
    listener(m)(status({ isLoaded: true, currentTime: 754, error: 'decode' }));
    await settle();
    expect(mocks.player.seekTo).toHaveBeenCalledWith(754);
  });

  it('a stream that fails is the page’s error, as before, reported as streamed', async () => {
    mocks.list.mockResolvedValue([]);
    load(); await settle();
    listener(0)(status({ isLoaded: false, error: 'offline', errorDomain: 'NSURLErrorDomain', errorCode: -1009 } as Partial<AudioStatus>));
    expect(statusEvents()).toContain('error');
    expect(diagnostics()).toContainEqual({ event: 'native-error', outcome: 'failed', source: 'native-network', errorDomain: 'NSURLErrorDomain', errorCode: -1009 });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('a seek in flight when a kept copy fails: resumed there, and nothing reaches the page until the player is there (D196)', async () => {
    load(); await settle();
    listener(0)(status({ isLoaded: true, currentTime: 600 }));
    let land!: () => void;
    mocks.player.seekTo.mockReturnValueOnce(new Promise<void>(() => {})) // the page's seek, never made by the failing player
      .mockReturnValueOnce(new Promise<void>((r) => { land = r; })); // the recovery's
    engine.handle(JSON.stringify({ type: 'seek', time: 2400 }));
    listener(0)(status({ isLoaded: true, currentTime: 600, error: 'damaged' }));
    await settle();
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(2400);
    const before = messages.length;
    const n = mocks.player.addListener.mock.calls.length - 1;
    listener(n)(status({ isLoaded: true, currentTime: 0 }));
    expect(messages.slice(before).filter((m) => m.type === 'status')).toEqual([]); // no 0:00 for the page
    land(); await settle();
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'native-seek', outcome: 'ok' })); // the page's seek answered
    listener(n)(status({ isLoaded: true, currentTime: 2400 }));
    expect(messages.filter((m) => m.type === 'status').at(-1)).toMatchObject({ currentTime: 2400 });
  });

  it('resumes playing when the failing copy stopped by itself just before its error', async () => {
    load(); await settle();
    listener(0)(status({ isLoaded: true, playing: true, currentTime: 30 }));
    listener(0)(status({ isLoaded: true, playing: false, currentTime: 30 }));
    listener(0)(status({ isLoaded: true, playing: false, currentTime: 30, error: 'decode' }));
    await settle();
    expect(uris().at(-1)).toBe(URL_);
    expect(mocks.player.play).toHaveBeenCalled();
  });

  it('but stays paused when the person paused it', async () => {
    load(); await settle();
    listener(0)(status({ isLoaded: true, playing: true, currentTime: 30 }));
    engine.handle(JSON.stringify({ type: 'pause' }));
    listener(0)(status({ isLoaded: true, playing: false, currentTime: 30 }));
    listener(0)(status({ isLoaded: true, playing: false, currentTime: 30, error: 'decode' }));
    await settle();
    expect(uris().at(-1)).toBe(URL_);
    expect(mocks.player.play).not.toHaveBeenCalled();
  });

  it('downloads a response that is not audio once a run, not on every load', async () => {
    mocks.list.mockResolvedValue([]);
    mocks.read.mockResolvedValue(HTML_HEAD);
    load(); await settle();
    load(); await settle();
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });

  it('names an .aac audiobook tagged with ID3 by what follows the tag', async () => {
    mocks.list.mockResolvedValue([]);
    mocks.read.mockImplementation(async (_: string, o: { position: number }) => (o.position === 0 ? 'SUQzBAAAAAAAIlRT' : '//lcYA==')); // ID3 (0x22 long), then ADTS
    load(); await settle();
    expect(mocks.read).toHaveBeenCalledWith(`${DIR}${BASE}.part`, { encoding: 'base64', position: 10 + 0x22, length: 4 });
    expect(mocks.move).toHaveBeenCalledWith({ from: `${DIR}${BASE}.part`, to: `${DIR}${BASE}.aac` });
  });
});

describe('going on to the next track from its kept copy (D181, D219)', () => {
  it('plays the next track from the device when it has a copy', async () => {
    const T0 = 'https://books.test/media/editions/e1/tracks/0';
    const T1 = 'https://books.test/media/editions/e1/tracks/1';
    mocks.list.mockResolvedValue([`${offlineBaseName(T0)}.m4a`, `${offlineBaseName(T1)}.m4a`]);
    engine.handle(JSON.stringify({ type: 'queue', queue: { bookId: 'b1', editionId: 'e1', advance: true, tracks: [{ url: T0, title: 'One' }, { url: T1, title: 'Two' }] } }));
    engine.handle(JSON.stringify({ type: 'load', url: T0 })); for (let i = 0; i < 6; i++) await tick();
    const listen = mocks.player.addListener.mock.calls[0]![1] as (s: AudioStatus) => void;
    listen(status({ playing: true, currentTime: 59 }));
    mocks.create.mockClear();
    listen(status({ playing: false, didJustFinish: true, currentTime: 60, duration: 60 }));
    for (let i = 0; i < 6; i++) await tick();
    expect(mocks.create).toHaveBeenCalledWith({ uri: `${DIR}${offlineBaseName(T1)}.m4a` });
    expect(mocks.player.play).toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});

describe('streaming with a media ticket (D219, mocked Expo modules)', () => {
  const T = 'https://books.test/media/editions/ed_00001/tracks/3';
  const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
  const editionOf = (url: string) => (url.startsWith('https://books.test/') ? (/\/editions\/([^/]+)\/tracks\//.exec(url)?.[1] ?? null) : null);
  const tickets = () => ({ editionOf, get: vi.fn(async () => 'tkt'), invalidate: vi.fn() });

  it('gives AVPlayer the ticket as a request header, for a streamed track only', async () => {
    mocks.list.mockResolvedValue([]);
    const tk = tickets();
    engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>), { tickets: tk });
    engine.handle(JSON.stringify({ type: 'load', url: T })); await settle();
    expect(tk.get).toHaveBeenCalledWith('ed_00001');
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: T, headers: { 'x-bookclub-media-ticket': 'tkt' } });
    expect(JSON.stringify(messages)).not.toContain('tkt');
    // a kept copy needs none
    mocks.list.mockResolvedValue([`${offlineBaseName(T)}.mp3`]);
    engine.handle(JSON.stringify({ type: 'load', url: T })); await settle();
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: `${DIR}${offlineBaseName(T)}.mp3` });
    expect(tk.get).toHaveBeenCalledTimes(1);
  });

  it('a stream that fails is tried once more with a fresh ticket, where it was, before the page hears of it', async () => {
    mocks.list.mockResolvedValue([]);
    const tk = tickets();
    engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>), { tickets: tk });
    engine.handle(JSON.stringify({ type: 'load', url: T })); await settle();
    engine.handle(JSON.stringify({ type: 'play' }));
    const first = mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void;
    first(status({ isLoaded: false, playing: false, currentTime: 0, error: 'auth', errorDomain: 'NSURLErrorDomain', errorCode: -1013 } as Partial<AudioStatus>));
    await settle();
    expect(tk.invalidate).toHaveBeenCalledWith('ed_00001');
    expect(tk.get).toHaveBeenCalledTimes(2);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(messages.filter((m) => m.type === 'status').map((m) => m.event)).not.toContain('error');
    expect(diagnostics()).toContainEqual({ event: 'native-error', outcome: 'failed', source: 'native-network', recovered: true, errorDomain: 'NSURLErrorDomain', errorCode: -1013 });
    expect(mocks.player.play).toHaveBeenCalledTimes(2);
    // and a second failure is the page's error: no loop
    const second = mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void;
    second(status({ isLoaded: false, error: 'auth again' }));
    await settle();
    expect(messages.filter((m) => m.type === 'status').map((m) => m.event)).toContain('error');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('refreshes a stale recovery ticket without losing the position of the pending seek', async () => {
    mocks.list.mockResolvedValue([`${offlineBaseName(T)}.mp3`]);
    const tk = tickets();
    engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>), { tickets: tk });
    engine.handle(JSON.stringify({ type: 'load', url: T })); await settle();
    const listener = () => mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void;
    listener()(status({ playing: true, currentTime: 37.5 }));
    mocks.player.seekTo.mockReturnValueOnce(new Promise<void>(() => {}));
    listener()(status({ currentTime: 37.5, error: 'damaged download' }));
    await settle();
    listener()(status({ isLoaded: false, currentTime: 0, error: 'expired ticket' }));
    await settle();
    expect(tk.get).toHaveBeenCalledTimes(2);
    expect(mocks.player.seekTo.mock.calls).toEqual([[37.5], [37.5]]);
  });

  it('a server without tickets: streamed as before, with no header', async () => {
    mocks.list.mockResolvedValue([]);
    const tk = { editionOf, get: vi.fn(async () => null), invalidate: vi.fn() };
    engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>), { tickets: tk });
    engine.handle(JSON.stringify({ type: 'load', url: T })); await settle();
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: T });
  });

  it('never sends a ticket to another host', async () => {
    mocks.list.mockResolvedValue([]);
    const tk = tickets();
    engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>), { tickets: tk });
    const elsewhere = 'https://evil.example/media/editions/ed_00001/tracks/3';
    engine.handle(JSON.stringify({ type: 'load', url: elsewhere })); await settle();
    expect(tk.get).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: elsewhere });
  });

  it('a track that fails at the same place again is the page’s error, not another ticket; one that played on may be tried again', async () => {
    mocks.list.mockResolvedValue([]);
    const tk = tickets();
    engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>), { tickets: tk });
    engine.handle(JSON.stringify({ type: 'load', url: T })); await settle();
    const fail = (at: number) => (mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void)(status({ isLoaded: true, currentTime: at, error: `bad range ${at}` }));
    const report = (at: number) => (mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void)(status({ isLoaded: true, currentTime: at }));
    report(100); fail(100); await settle(); // retried
    expect(tk.get).toHaveBeenCalledTimes(2);
    report(101); fail(101); await settle(); // loaded again, but no further: the page's error
    expect(tk.get).toHaveBeenCalledTimes(2);
    expect(messages.filter((m) => m.type === 'status').map((m) => m.event)).toContain('error');
    // a fresh load that plays well past it may be retried once more
    engine.handle(JSON.stringify({ type: 'load', url: T })); await settle();
    report(100); report(140); fail(140); await settle();
    expect(tk.get).toHaveBeenCalledTimes(4); // the fresh load's own ticket, then the retry's
  });
});


describe('CarPlay drives the player (D221)', () => {
  const T0 = 'https://books.test/media/editions/e1/tracks/0';
  const T1 = 'https://books.test/media/editions/e1/tracks/1';
  const carQueue = { bookId: 'b1', editionId: 'e1', userId: 'u1', advance: true, tracks: [{ url: T0, title: 'One' }, { url: T1, title: 'Two' }] };
  const meta = { title: 'One', artist: 'Ursula', albumTitle: 'Earthsea', artworkUrl: 'https://books.test/cover' };
  const send = (cmd: object) => engine.handle(JSON.stringify(cmd));
  const listener = () => mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void;
  const toPage = () => messages.filter((m) => m.type !== 'kept');

  async function startAtSpeechPlace(fromCar: boolean, place = 42.5) {
    const started = fromCar ? engine.playFromCar(carQueue, meta, 0, 0) : undefined;
    if (!fromCar) {
      send({ type: 'queue', queue: carQueue });
      send({ type: 'load', url: T0 });
    }
    await tick();
    mocks.player.currentTime = place;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: place }));
    await started;
    const answer = engine.withCarSpeech(engine.livePlace()!, new AbortController(), (play) => play('file:///answer.mp3'));
    listener()(status({ playing: true, currentTime: 0.3, duration: 1.2 }));
    return { answer, plays: mocks.player.play.mock.calls.length };
  }

  it('lets native actions read the live place, pause, resume and set the rate without returning the player to the page', async () => {
    send({ type: 'queue', queue: carQueue });
    engine.playFromCar(carQueue, meta, 1, 42_000); await tick();
    expect(engine.livePlace()).toBeNull(); // still loading or seeking
    await tick();
    mocks.player.currentTime = 42.687;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    expect(engine.livePlace()).toEqual({ bookId: 'b1', editionId: 'e1', userId: 'u1', locator: { kind: 'audio', track: 1, ms: 42_687 }, trackUrl: T1, playing: true });
    mocks.player.play.mockClear();
    engine.pause();
    engine.setRate(1.5);
    engine.resume();
    expect(mocks.player.pause).toHaveBeenCalledTimes(1);
    expect(mocks.player.setPlaybackRate).toHaveBeenLastCalledWith(1.5, 'high');
    expect(mocks.player.play).toHaveBeenCalledTimes(1);
    expect(engine.playbackRate()).toBe(1.5);
    expect(engine.drivenByCar()).toBe(true);
    expect(toPage()).toEqual([]);
  });

  it('keeps the car sleep timer across another chapter and stops the car player when it expires', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      engine.playFromCar(carQueue, meta, 0, 0); await tick();
      engine.setSleepTimer(5_000);
      engine.playFromCar(carQueue, meta, 1, 0); await tick();
      listener()(status({ playing: true }));
      expect(mocks.player.pause).not.toHaveBeenCalled();
      vi.setSystemTime(5_001);
      listener()(status({ playing: true }));
      expect(mocks.player.pause).toHaveBeenCalledTimes(1);
      expect(engine.drivenByCar()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears an expired sleep timer when resuming from a pause', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const started = engine.playFromCar(carQueue, meta, 0, 0); await tick();
      listener()(status({ playing: true }));
      await started;
      engine.setSleepTimer(5_000);
      engine.pause();
      vi.setSystemTime(5_001);
      engine.resume();
      listener()(status({ playing: true }));
      expect(mocks.player.pause).toHaveBeenCalledTimes(1);
      expect(mocks.player.play).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the phone speed and timer when the car disconnects without any page changes', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      send({ type: 'queue', queue: carQueue });
      send({ type: 'setRate', rate: 1.25 });
      send({ type: 'sleep', at: 8_000 });
      const opening = engine.playFromCar(carQueue, meta, 0, 0); await tick();
      listener()(status({ playing: true }));
      await opening;
      engine.setRate(1.5);
      engine.setSleepTimer(5_000);
      engine.carDisconnected();
      expect(mocks.player.setPlaybackRate).toHaveBeenLastCalledWith(1.25, 'high');
      vi.setSystemTime(5_001);
      listener()(status({ playing: true }));
      expect(mocks.player.pause).not.toHaveBeenCalled();
      vi.setSystemTime(8_001);
      listener()(status({ playing: true }));
      expect(mocks.player.pause).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays a track from a place with its lock-screen title, and tells a page that has another book nothing', async () => {
    mocks.list.mockResolvedValue([]);
    engine.playFromCar(carQueue, meta, 1, 42_500); await tick(); await tick();
    expect(mocks.create).toHaveBeenCalledWith({ uri: T1 });
    expect(mocks.player.seekTo).toHaveBeenCalledWith(42.5);
    expect(mocks.player.play).toHaveBeenCalled();
    expect(mocks.player.setActiveForLockScreen).toHaveBeenCalledWith(true, { ...meta, title: 'Two' }, LOCK_SCREEN_OPTIONS);
    expect(engine.drivenByCar()).toBe(true);
    listener()(status({ playing: true, currentTime: 43 }));
    expect(toPage()).toEqual([]);
  });

  it('acknowledges a start only once the player actually plays', async () => {
    const opening = engine.playFromCar(carQueue, meta, 0, 0);
    const acknowledged = vi.fn();
    void opening.then(acknowledged);
    await tick();
    listener()(status({ playing: false }));
    await tick();
    expect(acknowledged).not.toHaveBeenCalled();
    listener()(status({ playing: true }));
    await expect(opening).resolves.toBe(true);
  });

  it('waits through a failed kept copy and reports a failure if streaming cannot start either', async () => {
    mocks.list.mockResolvedValue([`${offlineBaseName(T0)}.mp3`]);
    const opening = engine.playFromCar(carQueue, meta, 0, 0);
    const acknowledged = vi.fn();
    void opening.then(acknowledged);
    await tick();
    listener()(status({ isLoaded: false, error: 'bad offline copy' }));
    await tick(); await tick();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(acknowledged).not.toHaveBeenCalled();
    listener()(status({ isLoaded: false, error: 'no network connection' }));
    await expect(opening).resolves.toBe(false);
  });

  it.each([{ started: false, stage: 'at start' }, { started: true, stage: 'mid-drive' }])('returns to the page’s different audiobook after a terminal error $stage', async ({ started }) => {
    const phoneTrack = 'https://books.test/media/editions/phone-edition/tracks/0';
    const phoneQueue = { ...carQueue, editionId: 'phone-edition', tracks: [{ url: phoneTrack, title: 'Earlier chapter' }] };
    mocks.list.mockResolvedValue([]);
    send({ type: 'queue', queue: phoneQueue });
    send({ type: 'metadata', title: 'Earlier chapter', album: 'Earlier book' });
    send({ type: 'load', url: phoneTrack }); await tick();
    mocks.player.currentTime = 31.5;
    listener()(status({ currentTime: 31.5 }));
    send({ type: 'setRate', rate: 1.25 });
    send({ type: 'sleep', at: Date.now() + 5_000 });
    const opening = engine.playFromCar(carQueue, meta, 0, 0); await tick();
    if (started) {
      listener()(status({ playing: true }));
      await expect(opening).resolves.toBe(true);
    }
    engine.setRate(1.5);
    listener()(status({ isLoaded: false, error: 'no connection' }));
    if (!started) await expect(opening).resolves.toBe(false);
    expect(engine.drivenByCar()).toBe(false);
    expect(engine.playbackRate()).toBe(1.25);
    const plays = mocks.player.play.mock.calls.length;
    send({ type: 'play' }); await tick(); await tick();
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: phoneTrack });
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(31.5);
    expect(mocks.player.play).toHaveBeenCalledTimes(plays + 1);
  });

  it('returns to the phone’s intended recovery position and remembers that it was playing', async () => {
    const phoneTrack = 'https://books.test/media/editions/phone-edition/tracks/0';
    const phoneQueue = { ...carQueue, bookId: 'phone-book', editionId: 'phone-edition', tracks: [{ url: phoneTrack, title: 'Earlier chapter' }] };
    mocks.list.mockResolvedValue([`${offlineBaseName(phoneTrack)}.mp3`]);
    send({ type: 'queue', queue: phoneQueue });
    send({ type: 'load', url: phoneTrack }); await tick();
    listener()(status({ playing: true, currentTime: 37.5 }));
    mocks.player.seekTo.mockReturnValueOnce(new Promise<void>(() => {}));
    listener()(status({ currentTime: 37.5, error: 'damaged download' }));
    await tick(); await tick();
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(37.5);

    mocks.player.currentTime = 0;
    const opening = engine.playFromCar(carQueue, meta, 0, 0); await tick();
    const plays = mocks.player.play.mock.calls.length;
    listener()(status({ isLoaded: false, error: 'no connection' }));
    await expect(opening).resolves.toBe(false);
    await tick(); await tick();
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: phoneTrack });
    expect(mocks.player.seekTo.mock.calls).toEqual([[37.5], [37.5]]);
    expect(mocks.player.play).toHaveBeenCalledTimes(plays + 1);
  });

  it('recovers a one-time error during the initial seek at the requested car position', async () => {
    mocks.list.mockResolvedValue([`${offlineBaseName(T0)}.mp3`]);
    mocks.player.seekTo.mockReturnValueOnce(new Promise<void>(() => {}));
    const opening = engine.playFromCar(carQueue, meta, 0, 42_000);
    await tick();
    expect(mocks.player.seekTo).toHaveBeenCalledWith(42);
    listener()(status({ isLoaded: false, error: 'bad offline copy', currentTime: 0 }));
    await tick(); await tick();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.player.seekTo.mock.calls).toEqual([[42], [42]]);
    listener()(status({ playing: true, currentTime: 42 }));
    await expect(opening).resolves.toBe(true);
  });

  it('speaks through the audiobook player and restores its track and place before resuming', async () => {
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;
    const here = engine.livePlace()!;
    const answer = engine.withCarSpeech(here, new AbortController(), (play) => play('file:///answer.mp3'));
    expect(mocks.player.pause).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.player.replace).toHaveBeenCalledWith({ uri: 'file:///answer.mp3' });
    expect(mocks.player.clearLockScreenControls).toHaveBeenCalledTimes(1);
    engine.skip(15);
    expect(mocks.player.seekTo).not.toHaveBeenCalled();
    listener()(status({ playing: true, currentTime: 0.3 }));
    listener()(status({ playing: false, didJustFinish: true, currentTime: 1.2 }));
    await answer;
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(42.5, 0, 0);
    expect(mocks.player.seekTo.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.player.play.mock.invocationCallOrder.at(-1)!);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(engine.drivenByCar()).toBe(true);
    expect(toPage()).toEqual([]);
  });

  it('respects a pause from the native transport controls while it is speaking', async () => {
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;
    const turn = new AbortController();
    const answer = engine.withCarSpeech(engine.livePlace()!, turn, (play) => play('file:///answer.mp3'));
    listener()(status({ playing: true, currentTime: 0.3 }));
    const plays = mocks.player.play.mock.calls.length;
    listener()(status({ playing: false, currentTime: 0.4 }));
    await expect(answer).rejects.toThrow('Spoken answer stopped');
    expect(turn.signal.aborted).toBe(true);
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(42.5, 0, 0);
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
  });

  it('resumes narration when the player reaches the end of speech before reporting completion', async () => {
    vi.useFakeTimers();
    try {
      const started = engine.playFromCar(carQueue, meta, 0, 0);
      await tick();
      mocks.player.currentTime = 42.5;
      mocks.player.playing = true;
      listener()(status({ playing: true, currentTime: 42.5 }));
      await started;
      const turn = new AbortController();
      const answer = engine.withCarSpeech(engine.livePlace()!, turn, (play) => play('file:///answer.mp3'));
      const completed = answer.then(() => true, () => false);
      listener()(status({ playing: true, currentTime: 0.3, duration: 65.5 }));
      const plays = mocks.player.play.mock.calls.length;
      await vi.advanceTimersByTimeAsync(65_450);
      listener()(status({ playing: false, currentTime: 65.45, duration: 65.5 }));
      await vi.advanceTimersByTimeAsync(50);
      listener()(status({ playing: false, didJustFinish: true, currentTime: 65.5, duration: 65.5 }));
      expect(await completed).toBe(true);
      expect(turn.signal.aborted).toBe(false);
      expect(mocks.player.play).toHaveBeenCalledTimes(plays + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['miss', 'timeout', 'rejection'] as const)('keeps the audiobook usable after an exact restore seek %s', async (failure) => {
    vi.useFakeTimers();
    try {
      const started = engine.playFromCar(carQueue, meta, 0, 0);
      await tick();
      mocks.player.currentTime = 42.5;
      mocks.player.playing = true;
      listener()(status({ playing: true, currentTime: 42.5 }));
      await started;
      const answer = engine.withCarSpeech(engine.livePlace()!, new AbortController(), (play) => play('file:///answer.mp3'));
      const result = answer.then(() => 'restored', () => 'failed');
      listener()(status({ playing: true, currentTime: 0.3 }));
      const plays = mocks.player.play.mock.calls.length;
      mocks.player.seekTo.mockImplementationOnce(async () => {
        mocks.player.currentTime = 42.1;
        if (failure === 'timeout') await new Promise<void>(() => {});
        if (failure === 'rejection') throw new Error('seek failed');
      }).mockRejectedValueOnce(new Error('tolerant seek also failed'));
      listener()(status({ didJustFinish: true }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBe('restored');
      expect(mocks.player.seekTo.mock.calls).toEqual([[42.5, 0, 0], [42.5, 1_000, 1_000]]);
      expect(mocks.player.play).toHaveBeenCalledTimes(plays + 1);
      listener()(status({ playing: true, currentTime: 42.1 }));
      expect(engine.livePlace()?.locator).toEqual({ kind: 'audio', track: 0, ms: 42_100 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns to the page’s audiobook if the player cannot be created after speaking', async () => {
    const phoneTrack = 'https://books.test/media/editions/phone-edition/tracks/0';
    const phoneQueue = { ...carQueue, editionId: 'phone-edition', tracks: [{ url: phoneTrack, title: 'Earlier chapter' }] };
    send({ type: 'queue', queue: phoneQueue });
    send({ type: 'load', url: phoneTrack });
    await tick();
    mocks.player.currentTime = 31.5;
    listener()(status({ currentTime: 31.5 }));
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;
    const answer = engine.withCarSpeech(engine.livePlace()!, new AbortController(), (play) => play('file:///answer.mp3'));
    listener()(status({ playing: true, currentTime: 0.3 }));
    mocks.create.mockImplementationOnce(() => { throw new Error('audio player unavailable'); });
    listener()(status({ didJustFinish: true }));
    await expect(answer).resolves.toBeUndefined();
    await tick();
    expect(engine.drivenByCar()).toBe(false);
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: phoneTrack });
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(31.5);
    const plays = mocks.player.play.mock.calls.length;
    send({ type: 'play' });
    expect(mocks.player.play).toHaveBeenCalledTimes(plays + 1);
  });

  it('hands playback back without playing or recording 0:00 after both return seeks miss', async () => {
    const keep = vi.fn<(json: string) => void>();
    let now = 1_000_000;
    engine = new NativeAudioEngine((json) => messages.push(JSON.parse(json) as Record<string, unknown>), {
      progress: { serverUrl: 'https://books.test', now: () => now, inBackground: () => true, keep, fetch: async () => ({ ok: true, status: 200 }) },
    });
    const { answer, plays } = await startAtSpeechPlace(true);
    mocks.player.currentTime = 0;
    mocks.player.currentStatus = status({ currentTime: 0 });
    mocks.player.seekTo.mockRejectedValue(new Error('could not seek'));
    listener()(status({ didJustFinish: true }));
    await answer;
    now += 60_000;
    listener()(status({ playing: true, currentTime: 0 }));
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
    expect(engine.drivenByCar()).toBe(false);
    const kept = keep.mock.calls.map(([json]) => (JSON.parse(json) as { locator: { ms: number } }).locator.ms);
    expect(kept).toContain(42_500);
    expect(kept).not.toContain(0);
  });

  it('loads the phone’s audiobook once at the saved place after its speech restore throws', async () => {
    const { answer, plays } = await startAtSpeechPlace(false);
    mocks.create.mockImplementationOnce(() => { throw new Error('cannot create player'); });
    listener()(status({ didJustFinish: true }));
    await answer;
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: T0 });
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(42.5);
    expect(mocks.player.play).toHaveBeenCalledTimes(plays + 1);
  });

  it('tells the page to pause and shows an error if both phone restore loads throw', async () => {
    const { answer, plays } = await startAtSpeechPlace(false);
    mocks.create.mockImplementation(() => { throw new Error('cannot create player'); });
    listener()(status({ didJustFinish: true }));
    await answer;
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
    expect(toPage()).toContainEqual(expect.objectContaining({ type: 'status', event: 'pause', paused: true, currentTime: 42.5 }));
    expect(toPage()).toContainEqual(expect.objectContaining({ type: 'status', event: 'error', errorMessage: 'Audiobook playback could not be restored' }));
  });

  it('removes the clip if the page changes editions without loading a track', async () => {
    const { answer, plays } = await startAtSpeechPlace(false);
    const ended = expect(answer).rejects.toThrow('Spoken answer stopped');
    send({ type: 'queue', queue: { ...carQueue, editionId: 'next-edition', tracks: [{ url: T1, title: 'New book' }] } });
    await ended;
    send({ type: 'play' });
    expect(mocks.player.remove).toHaveBeenCalledOnce();
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
  });

  it('cancels a return seek when the page changes editions before it finishes', async () => {
    const { answer, plays } = await startAtSpeechPlace(false);
    let finishSeek!: () => void;
    mocks.player.seekTo.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSeek = resolve; }));
    listener()(status({ didJustFinish: true }));
    await tick(); await tick();
    expect(mocks.player.seekTo).toHaveBeenCalledWith(42.5, 0, 0);
    send({ type: 'queue', queue: { ...carQueue, editionId: 'next-edition', tracks: [{ url: T1, title: 'New book' }] } });
    finishSeek();
    await answer;
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
  });

  it('reports the initial player error after an ordinary reload at 0:00 without a third load', async () => {
    mocks.list.mockResolvedValue([`${offlineBaseName(T0)}.mp3`]);
    const { answer } = await startAtSpeechPlace(false, 0);
    mocks.create.mockImplementationOnce(() => { throw new Error('cannot create player'); });
    listener()(status({ didJustFinish: true }));
    await answer;
    listener()(status({ isLoaded: false, currentTime: 0, error: 'cannot open track' }));
    await tick(); await tick();
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(toPage()).toContainEqual(expect.objectContaining({ type: 'status', event: 'pause', currentTime: 0 }));
    expect(toPage()).toContainEqual(expect.objectContaining({ type: 'status', event: 'error' }));
  });

  it('leaves the audiobook paused when handing the car-owned book back during a clip', async () => {
    send({ type: 'queue', queue: carQueue });
    const { answer, plays } = await startAtSpeechPlace(true);
    send({ type: 'setRate', rate: 1.25 });
    await expect(answer).rejects.toThrow('Spoken answer stopped');
    expect(engine.drivenByCar()).toBe(false);
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(42.5, 0, 0);
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
  });

  it('finishes a playing clip at its duration without a separate completion event', async () => {
    const { answer, plays } = await startAtSpeechPlace(true);
    listener()(status({ currentTime: 1.2, duration: 1.2, didJustFinish: false }));
    await answer;
    expect(mocks.player.play).toHaveBeenCalledTimes(plays + 1);
  });

  it.each([
    { supportsHandoff: true, expectedUrl: T1, expectedPosition: 42.5 },
    { supportsHandoff: false, expectedUrl: T0, expectedPosition: 20 },
  ])('returns the same book after a terminal error (page handoff support: $supportsHandoff)', async ({ supportsHandoff, expectedUrl, expectedPosition }) => {
    send({ type: 'queue', queue: { ...carQueue, ...(supportsHandoff ? { acceptsHandoff: true } : {}) } });
    send({ type: 'load', url: T0 });
    await tick();
    mocks.player.currentTime = 20;
    listener()(status({ playing: true, currentTime: 20 }));
    const started = engine.playFromCar(carQueue, meta, 1, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;
    listener()(status({ isLoaded: false, error: 'no connection', currentTime: 0 }));
    await tick(); await tick();
    expect(engine.drivenByCar()).toBe(false);
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: expectedUrl });
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(expectedPosition);
    if (supportsHandoff) expect(toPage()).toContainEqual({ type: 'advanced', url: T1, handoff: 42.5, at: expect.any(Number) });
    else expect(toPage()).not.toContainEqual(expect.objectContaining({ type: 'advanced' }));
  });

  it('retries a failed offline restore at the same verified place before playing', async () => {
    mocks.list.mockResolvedValue([`${offlineBaseName(T0)}.mp3`]);
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;

    const answer = engine.withCarSpeech(engine.livePlace()!, new AbortController(), (play) => play('file:///answer.mp3'));
    listener()(status({ playing: true, currentTime: 0.3 }));
    mocks.player.seekTo.mockReturnValueOnce(new Promise<void>(() => {}));
    let finishSeek!: () => void;
    mocks.player.seekTo.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSeek = resolve; }));
    listener()(status({ playing: false, didJustFinish: true, currentTime: 1.2 }));
    await tick(); await tick();
    const plays = mocks.player.play.mock.calls.length;
    mocks.player.currentTime = 0;
    listener()(status({ isLoaded: false, currentTime: 0, error: 'damaged download' }));
    await tick(); await tick();

    expect(mocks.create).toHaveBeenLastCalledWith({ uri: T0 });
    expect(mocks.player.seekTo.mock.calls).toEqual([[42.5, 0, 0], [42.5, 0, 0]]);
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
    mocks.player.currentTime = 42.5;
    finishSeek();
    await answer;
    expect(mocks.player.play).toHaveBeenCalledTimes(plays + 1);
  });

  it('cancels the spoken answer and never restores the signed-out account’s audiobook', async () => {
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;
    const answer = engine.withCarSpeech(engine.livePlace()!, new AbortController(), (play) => play('file:///answer.mp3'));
    expect(mocks.player.replace).toHaveBeenCalledTimes(1);
    const plays = mocks.player.play.mock.calls.length;
    engine.forgetAccount();
    await expect(answer).rejects.toThrow('Spoken answer stopped');
    expect(engine.livePlace()).toBeNull();
    expect(engine.drivenByCar()).toBe(false);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.player.remove).toHaveBeenCalledTimes(1);
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
  });

  it('pauses ordinary narration before releasing its native player on sign-out', async () => {
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.playing = true;
    listener()(status({ playing: true }));
    await started;
    engine.forgetAccount();
    expect(mocks.player.pause).toHaveBeenCalledOnce();
    expect(mocks.player.pause.mock.invocationCallOrder[0]!).toBeLessThan(mocks.player.remove.mock.invocationCallOrder[0]!);
  });

  it('stops a spoken answer when the car disconnects with no page open', async () => {
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;
    const answer = engine.withCarSpeech(engine.livePlace()!, new AbortController(), (play) => play('file:///answer.mp3'));
    listener()(status({ playing: true, currentTime: 0.3 }));
    const plays = mocks.player.play.mock.calls.length;
    engine.carDisconnected();
    await expect(answer).rejects.toThrow('Spoken answer stopped');
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(42.5, 0, 0);
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
  });

  it('stays paused if the car disconnects while the return seek is in flight', async () => {
    send({ type: 'queue', queue: carQueue });
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;
    const answer = engine.withCarSpeech(engine.livePlace()!, new AbortController(), (play) => play('file:///answer.mp3'));
    listener()(status({ playing: true, currentTime: 0.3 }));
    let finishSeek!: () => void;
    mocks.player.seekTo.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSeek = resolve; }));
    listener()(status({ didJustFinish: true }));
    await tick(); await tick();
    expect(mocks.player.seekTo).toHaveBeenCalledWith(42.5, 0, 0);
    const plays = mocks.player.play.mock.calls.length;
    engine.carDisconnected();
    mocks.player.playing = false;
    mocks.player.currentStatus = status({ playing: false, currentTime: 42.5 });
    finishSeek();
    await answer;
    expect(mocks.player.play).toHaveBeenCalledTimes(plays);
    expect(engine.drivenByCar()).toBe(false);
    expect(engine.livePlace()).toMatchObject({ playing: false, locator: { ms: 42_500 } });
    expect(toPage()).toContainEqual(expect.objectContaining({ type: 'status', event: 'timeupdate', currentTime: 42.5 }));
  });

  it('returns ownership when creating a replacement for a failed download throws mid-drive', async () => {
    const phoneTrack = 'https://books.test/media/editions/phone-edition/tracks/0';
    const phoneQueue = { ...carQueue, editionId: 'phone-edition', tracks: [{ url: phoneTrack, title: 'Earlier chapter' }] };
    mocks.list.mockResolvedValue([ `${offlineBaseName(T0)}.mp3` ]);
    send({ type: 'queue', queue: phoneQueue });
    send({ type: 'load', url: phoneTrack });
    await tick();
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    listener()(status({ playing: true }));
    await started;
    mocks.create.mockImplementationOnce(() => { throw new Error('replacement player unavailable'); });
    listener()(status({ isLoaded: false, error: 'damaged download' }));
    await tick(); await tick();
    expect(engine.drivenByCar()).toBe(false);
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: phoneTrack });
  });

  it('lets the page scrub its audiobook while Cal is speaking without seeking the clip', async () => {
    send({ type: 'queue', queue: carQueue });
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;
    const turn = new AbortController();
    const answer = engine.withCarSpeech(engine.livePlace()!, turn, (play) => play('file:///answer.mp3'));
    const finished = answer.catch(() => undefined);
    listener()(status({ playing: true, currentTime: 0.3 }));
    send({ type: 'seek', time: 75 });
    try {
      expect(turn.signal.aborted).toBe(true);
      expect(engine.drivenByCar()).toBe(false);
      expect(mocks.player.seekTo).not.toHaveBeenCalled();
      await tick(); await tick();
      expect(mocks.player.seekTo.mock.calls).toEqual([[75]]);
    } finally {
      turn.abort();
      await finished;
    }
  });

  it('applies the page’s speed change to a player already seeking back from speech', async () => {
    send({ type: 'queue', queue: carQueue });
    const started = engine.playFromCar(carQueue, meta, 0, 0);
    await tick();
    mocks.player.currentTime = 42.5;
    mocks.player.playing = true;
    listener()(status({ playing: true, currentTime: 42.5 }));
    await started;
    const answer = engine.withCarSpeech(engine.livePlace()!, new AbortController(), (play) => play('file:///answer.mp3'));
    listener()(status({ playing: true, currentTime: 0.3 }));
    let finishSeek!: () => void;
    mocks.player.seekTo.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSeek = resolve; }));
    listener()(status({ didJustFinish: true }));
    await tick(); await tick();
    expect(mocks.player.seekTo).toHaveBeenCalledWith(42.5, 0, 0);
    send({ type: 'setRate', rate: 1.75 });
    finishSeek();
    await answer;
    expect(engine.drivenByCar()).toBe(false);
    expect(mocks.player.setPlaybackRate).toHaveBeenLastCalledWith(1.75, 'high');
  });

  it('times out a stuck car start without playing it later after the failure message', async () => {
    vi.useFakeTimers();
    try {
      let found!: (entries: string[]) => void;
      mocks.list.mockReturnValue(new Promise<string[]>((resolve) => { found = resolve; }));
      const opening = engine.playFromCar(carQueue, meta, 0, 0);
      const acknowledged = vi.fn();
      void opening.then(acknowledged);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(acknowledged).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(opening).resolves.toBe(false);
      expect(engine.drivenByCar()).toBe(false);
      found([]);
      await tick();
      expect(mocks.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a start still waiting on a file lookup when CarPlay disconnects', async () => {
    let found!: (entries: string[]) => void;
    mocks.list.mockReturnValue(new Promise<string[]>((resolve) => { found = resolve; }));
    const opening = engine.playFromCar(carQueue, meta, 0, 0);
    const acknowledged = vi.fn();
    void opening.then(acknowledged);
    engine.carDisconnected();
    found([]);
    await tick(); await tick();
    expect(acknowledged).toHaveBeenCalledWith(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(engine.drivenByCar()).toBe(false);
  });

  it('lets a first car seek finish after the usual start deadline without playing at zero', async () => {
    vi.useFakeTimers();
    try {
      let land!: () => void;
      mocks.player.seekTo.mockReturnValueOnce(new Promise<void>((resolve) => { land = resolve; }));
      const opening = engine.playFromCar(carQueue, meta, 0, 31_500);
      const acknowledged = vi.fn();
      void opening.then(acknowledged);
      await vi.advanceTimersByTimeAsync(20_001);
      expect(acknowledged).not.toHaveBeenCalled();
      expect(mocks.player.play).not.toHaveBeenCalled();
      land(); await tick();
      expect(mocks.player.play).toHaveBeenCalledOnce();
      listener()(status({ playing: true, currentTime: 31.5 }));
      await expect(opening).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('obeys nothing from the page but a track of its own, which takes the player back', async () => {
    engine.playFromCar(carQueue, meta, 0, 0); await tick();
    const created = mocks.create.mock.calls.length;
    send({ type: 'pause' });
    send({ type: 'queue', queue: null });
    send({ type: 'unload' });
    send({ type: 'setRate', rate: 2 });
    expect(mocks.player.pause).not.toHaveBeenCalled();
    expect(mocks.player.remove).not.toHaveBeenCalled();
    expect(mocks.player.setPlaybackRate).not.toHaveBeenCalledWith(2, expect.anything());
    send({ type: 'tellKept' }); await tick();
    expect(messages.filter((m) => m.type === 'kept')).toHaveLength(1);
    send({ type: 'load', url: T0 }); await tick();
    expect(engine.drivenByCar()).toBe(false);
    expect(mocks.create.mock.calls.length).toBe(created + 1);
    listener()(status({ playing: true }));
    expect(toPage().map((m) => m.event)).toContain('play');
  });

  it('goes on into the next track without a page to tell', async () => {
    engine.playFromCar(carQueue, meta, 0, 0); await tick();
    listener()(status({ playing: true, currentTime: 99 }));
    listener()(status({ playing: false, didJustFinish: true, currentTime: 100 })); await tick(); await tick();
    expect(mocks.create).toHaveBeenLastCalledWith({ uri: T1 });
    expect(mocks.player.setActiveForLockScreen).toHaveBeenLastCalledWith(true, { ...meta, title: 'Two' }, LOCK_SCREEN_OPTIONS);
    expect(messages.some((m) => m.type === 'advanced')).toBe(false);
  });

  it('ignores a track the queue does not have', async () => {
    engine.playFromCar(carQueue, meta, 5, 0); await tick();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(engine.drivenByCar()).toBe(false);
  });

  it('tells CarPlay each queue and the book’s metadata as the page sends them, never one book’s with another’s', async () => {
    const heard: unknown[] = [];
    const e = new NativeAudioEngine(() => {}, { onQueue: (q, m) => heard.push([q.bookId, m?.albumTitle ?? null]) });
    e.handle(JSON.stringify({ type: 'queue', queue: carQueue }));
    e.handle(JSON.stringify({ type: 'load', url: T0 })); await tick();
    e.handle(JSON.stringify({ type: 'metadata', title: 'One', artist: 'Ursula', album: 'Earthsea' }));
    // Another book's metadata comes before its queue (the page's effects' order): not kept as this one's.
    e.handle(JSON.stringify({ type: 'load', url: 'https://books.test/media/editions/e9/tracks/0' })); await tick();
    e.handle(JSON.stringify({ type: 'metadata', title: 'Other', artist: 'X', album: 'Dune' }));
    e.handle(JSON.stringify({ type: 'queue', queue: null }));
    expect(heard).toEqual([['b1', null], ['b1', 'Earthsea']]);
    e.handle(JSON.stringify({ type: 'unload' }));
  });

  it('hands the player back when the page acts on the car’s own book, telling it the track and place', async () => {
    send({ type: 'queue', queue: { ...carQueue, advance: false } }); // the page's own queue: a party, say
    engine.playFromCar(carQueue, meta, 1, 0); await tick();
    listener()(status({ playing: true, currentTime: 12 }));
    send({ type: 'sleep', at: 99_000 });
    expect(toPage()).toEqual([]);
    send({ type: 'pause' });
    expect(engine.drivenByCar()).toBe(false);
    expect(mocks.player.pause).toHaveBeenCalled();
    expect(messages).toContainEqual({ type: 'advanced', url: T1 });
    expect(toPage().filter((m) => m.type === 'status').map((m) => m.event)).toEqual(['loadedmetadata', 'play', 'timeupdate']);
    // The page's queue now: no advance at the track's end.
    listener()(status({ playing: false, didJustFinish: true, currentTime: 100 })); await tick();
    expect(messages.some((m) => m.type === 'advanced' && m.url !== T1)).toBe(false);
  });

  it('keeps ignoring a page on another book, and gives it its own queue when it loads', async () => {
    const other = { bookId: 'b2', editionId: 'e2', userId: 'u1', advance: true, tracks: [{ url: 'https://books.test/media/editions/e2/tracks/0', title: 'X' }] };
    const opening = engine.playFromCar(carQueue, meta, 0, 0); await tick();
    listener()(status({ playing: true }));
    await opening;
    send({ type: 'queue', queue: other });
    send({ type: 'play' });
    engine.carDisconnected();
    expect(engine.drivenByCar()).toBe(true);
    send({ type: 'load', url: other.tracks[0]!.url }); await tick();
    expect(engine.drivenByCar()).toBe(false);
    listener()(status({ playing: false, didJustFinish: true, currentTime: 100 })); await tick();
    expect(messages.filter((m) => m.type === 'advanced')).toEqual([]); // its queue has no next track
  });

  it('gives the page the player back when the car disconnects, if the page is on the car’s book', async () => {
    send({ type: 'queue', queue: carQueue });
    engine.playFromCar(carQueue, meta, 0, 0); await tick();
    listener()(status({ playing: true, currentTime: 5 }));
    engine.carDisconnected();
    expect(engine.drivenByCar()).toBe(false);
    expect(messages).toContainEqual({ type: 'advanced', url: T0 });
  });

  it('saves the place of the car’s book itself, the page open or not', async () => {
    let now = 10_000;
    const put = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const car: NativeAudioEngine = new NativeAudioEngine(() => {}, { now: () => now, progress: { serverUrl: 'https://books.test', fetch: put, now: () => now, inBackground: () => car.drivenByCar() } });
    car.playFromCar(carQueue, meta, 0, 0); await tick();
    const onStatus = listener();
    for (let s = 0; s <= 62; s++) { onStatus(status({ playing: true, currentTime: s / 2 })); now += 500; }
    onStatus(status({ playing: false, currentTime: 31 }));
    await tick();
    expect(put).toHaveBeenCalled();
    expect(put.mock.calls[0]![0]).toBe('https://books.test/api/books/b1/progress');
    expect(JSON.parse((put.mock.calls.at(-1)![1] as { body: string }).body)).toEqual(expect.objectContaining({ editionId: 'e1', locator: { kind: 'audio', track: 0, ms: 31_000 } }));
    car.handle(JSON.stringify({ type: 'load', url: T0 }));
    car.handle(JSON.stringify({ type: 'unload' }));
  });
});

describe('a skip from the watch (D222)', () => {
  it('moves the player itself by the lock screen’s own skips, within the track', async () => {
    engine.handle(JSON.stringify({ type: 'load', url: URL_ })); await tick();
    const onStatus = mocks.player.addListener.mock.calls.at(-1)![1] as (s: AudioStatus) => void;
    engine.skip(30);
    expect(mocks.player.seekTo).not.toHaveBeenCalled(); // nothing loaded yet
    onStatus(status({ currentTime: 10, duration: 100 }));
    engine.skip(-15);
    engine.skip(30);
    onStatus(status({ currentTime: 95, duration: 100 }));
    engine.skip(30);
    expect(mocks.player.seekTo.mock.calls.map((c) => c[0])).toEqual([0, 40, 100]);
  });
});
