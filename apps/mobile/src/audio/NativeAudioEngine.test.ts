import { offlineBaseName } from '@bookclub/shared';
import { type AudioStatus } from 'expo-audio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_MODE, LOCK_SCREEN_OPTIONS, NativeAudioEngine } from './NativeAudioEngine';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(), download: vi.fn(), removeFile: vi.fn(), list: vi.fn(), read: vi.fn(), move: vi.fn(),
  player: { addListener: vi.fn(), remove: vi.fn(), play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setPlaybackRate: vi.fn(), setActiveForLockScreen: vi.fn(), clearLockScreenControls: vi.fn(), updateLockScreenMetadata: vi.fn() },
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
