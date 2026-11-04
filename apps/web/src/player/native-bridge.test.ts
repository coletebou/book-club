import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type BookClubNativeBridge, SEEK_HOLD_MS, askNativeKept, createNativeAudioElement, installNativeMediaSessionShim, installNativeNavigationBridge, isNativeApp, nativeAudioSource, observedAt, sendNativeQueue, sendNativeSleep } from './native-bridge';

/*
 * The iOS app's bridge (D131, D132): a `BookClubNative` object stands in for the page's postMessage
 * channel to native; these tests stand in for native itself, checking what the web side sends and
 * that an incoming status update reaches the element's listeners with the right state already set.
 */

function install(): { bridge: BookClubNativeBridge; sent: () => unknown[] } {
  const calls: unknown[] = [];
  const bridge: BookClubNativeBridge = { postMessage: vi.fn((json: string) => calls.push(JSON.parse(json))) };
  window.BookClubNative = bridge;
  return { bridge, sent: () => calls };
}

function receive(msg: Record<string, unknown>): void {
  window.__bookClubReceive?.(JSON.stringify(msg));
}

const STATUS = { currentTime: 0, duration: 0, paused: true, ended: false, playbackRate: 1, readyState: 0 };

beforeEach(() => {
  delete window.BookClubNative;
  delete window.__bookClubReceive;
  delete window.__bookClubNavigate;
});

describe('isNativeApp', () => {
  it('is false in a plain browser and true once the app injects its bridge', () => {
    expect(isNativeApp()).toBe(false);
    install();
    expect(isNativeApp()).toBe(true);
  });
});

describe('the native audio element (D131)', () => {
  it('loads the resolved URL of whatever is assigned to src, and src reads it back (AudioProvider.loadTrack relies on this)', () => {
    const { sent } = install();
    const el = createNativeAudioElement();
    el.src = '/media/editions/e1/tracks/0';
    expect(el.src).toBe(new URL('/media/editions/e1/tracks/0', location.href).href);
    expect(sent()).toEqual([{ type: 'load', url: el.src }]);
  });

  it('forwards play, pause, seek and rate changes as commands, and seek updates currentTime at once', () => {
    const { sent } = install();
    const el = createNativeAudioElement();
    void el.play();
    el.pause();
    el.currentTime = 42;
    el.playbackRate = 1.5;
    expect(sent()).toEqual([{ type: 'play' }, { type: 'pause' }, { type: 'seek', time: 42 }, { type: 'setRate', rate: 1.5 }]);
    expect(el.currentTime).toBe(42);
    expect(el.playbackRate).toBe(1.5);
  });

  it('removeAttribute("src") unloads and resets the element as a real one would on stop()', () => {
    const { sent } = install();
    const el = createNativeAudioElement();
    el.src = 'https://example.test/a.mp3';
    el.removeAttribute('src');
    expect(el.src).toBe('');
    expect(el.readyState).toBe(0);
    expect(el.paused).toBe(true);
    expect(sent().at(-1)).toEqual({ type: 'unload' });
  });

  it('removeAttribute of anything else does nothing', () => {
    const { sent } = install();
    const el = createNativeAudioElement();
    el.src = 'https://example.test/a.mp3';
    el.removeAttribute('autoplay');
    expect(el.src).not.toBe('');
    expect(sent().some((c) => (c as { type: string }).type === 'unload')).toBe(false);
  });

  it('a status update from native sets the element’s fields before dispatching the matching event', () => {
    install();
    const el = createNativeAudioElement();
    const seen: Record<string, unknown>[] = [];
    el.addEventListener('loadedmetadata', () => seen.push({ currentTime: el.currentTime, duration: el.duration, readyState: el.readyState }));
    receive({ type: 'status', event: 'loadedmetadata', ...STATUS, duration: 125.4, readyState: 1 });
    expect(seen).toEqual([{ currentTime: 0, duration: 125.4, readyState: 1 }]);
    expect(el.duration).toBe(125.4);
  });

  it('dispatches play/pause/ended/waiting/playing/error/ratechange/timeupdate as their own events', () => {
    install();
    const el = createNativeAudioElement();
    const heard = new Set<string>();
    for (const type of ['play', 'pause', 'ended', 'waiting', 'playing', 'error', 'ratechange', 'timeupdate']) el.addEventListener(type, () => heard.add(type));
    for (const type of ['play', 'pause', 'ended', 'waiting', 'playing', 'error', 'ratechange', 'timeupdate'] as const) {
      receive({ type: 'status', event: type, ...STATUS });
    }
    expect(heard).toEqual(new Set(['play', 'pause', 'ended', 'waiting', 'playing', 'error', 'ratechange', 'timeupdate']));
  });

  it('forwards only validated native diagnostics and remembers the active local/network source', () => {
    install();
    const el = createNativeAudioElement();
    const events: unknown[] = [];
    el.addEventListener('native-diagnostic', (event) => events.push((event as CustomEvent).detail));
    expect(nativeAudioSource(el)).toBe('native-unknown'); // Older app builds remain compatible.
    receive({ type: 'diagnostic', diagnostic: { event: 'native-source', source: 'native-local' } });
    expect(nativeAudioSource(el)).toBe('native-local');
    receive({ type: 'diagnostic', diagnostic: { event: 'native-seek', outcome: 'started' } });
    expect(el.seeking).toBe(true);
    receive({ type: 'diagnostic', diagnostic: { event: 'native-seek', outcome: 'ok', durationMs: 500 } });
    expect(el.seeking).toBe(false);
    receive({ type: 'diagnostic', diagnostic: { event: 'native-source', source: 'native-network', url: 'secret' } });
    expect(events).toHaveLength(3);
    expect(nativeAudioSource(el)).toBe('native-local');
    el.src = '/next';
    expect(nativeAudioSource(el)).toBe('native-unknown');
    expect(el.readyState).toBe(0);
  });

  it('removeEventListener stops a listener from hearing further status updates', () => {
    install();
    const el = createNativeAudioElement();
    const handler = vi.fn();
    el.addEventListener('playing', handler);
    receive({ type: 'status', event: 'playing', ...STATUS });
    el.removeEventListener('playing', handler);
    receive({ type: 'status', event: 'playing', ...STATUS });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('what native plays on into by itself while the page sleeps (D181)', () => {
  const queue = { bookId: 'b1', editionId: 'e1', advance: true, tracks: [{ url: 'https://example.test/t0', title: 'One' }, { url: 'https://example.test/t1', title: 'Two' }] };

  it('tells a native player the queue and the sleep timer’s end, and an <audio> element nothing', () => {
    const { sent } = install();
    const el = createNativeAudioElement();
    sendNativeQueue(el, queue);
    sendNativeSleep(el, 1_800_000_000_000);
    sendNativeQueue(el, null);
    sendNativeSleep(el, null);
    expect(sent()).toEqual([{ type: 'queue', queue }, { type: 'sleep', at: 1_800_000_000_000 }, { type: 'queue', queue: null }, { type: 'sleep', at: null }]);
    const browser = document.createElement('audio');
    sendNativeQueue(browser, queue);
    sendNativeSleep(browser, 1);
    expect(sent()).toHaveLength(4);
  });

  it('when native went on by itself, the element’s source is the new track before the old one’s `ended`, with nothing loaded again', () => {
    const { sent } = install();
    const el = createNativeAudioElement();
    el.src = 'https://example.test/t0';
    const atEnded: string[] = [];
    el.addEventListener('ended', () => atEnded.push(el.src));
    receive({ type: 'advanced', url: 'https://example.test/t1' });
    receive({ type: 'status', event: 'ended', ...STATUS, currentTime: 60, duration: 60, ended: true });
    expect(atEnded).toEqual(['https://example.test/t1']);
    expect(el.currentTime).toBe(60); // The finished track's end, for its last stretch heard.
    expect(sent()).toEqual([{ type: 'load', url: 'https://example.test/t0' }]);
  });
});

describe('the place, as native says it and as the page moves it (D196)', () => {
  const seeked = (outcome: 'ok' | 'failed' = 'ok') => receive({ type: 'diagnostic', diagnostic: { event: 'native-seek', outcome, durationMs: 40 } });

  it('a track opened at 12:34 is at 12:34 from the page’s seek on, not at the 0:00 native still says until it has seeked', () => {
    install();
    const el = createNativeAudioElement();
    const times: number[] = [];
    el.addEventListener('timeupdate', () => times.push(el.currentTime));
    el.src = '/media/editions/e1/tracks/4';
    // Native's new player: its metadata and a time update, both at its start.
    receive({ type: 'status', event: 'loadedmetadata', ...STATUS, duration: 900, readyState: 2 });
    el.currentTime = 754; // AudioProvider's seek on that metadata
    receive({ type: 'status', event: 'timeupdate', ...STATUS, duration: 900, readyState: 2 });
    expect(el.currentTime).toBe(754);
    // Native has seeked: its new place, then the seek's answer.
    receive({ type: 'diagnostic', diagnostic: { event: 'native-seek', outcome: 'started' } });
    receive({ type: 'status', event: 'timeupdate', ...STATUS, currentTime: 754.02, duration: 900, readyState: 2 });
    seeked();
    expect(el.currentTime).toBe(754.02);
    // And from then on native's word is the place, as before.
    receive({ type: 'status', event: 'timeupdate', ...STATUS, currentTime: 755.5, duration: 900, readyState: 2, paused: false });
    expect(times).toEqual([754, 754.02, 755.5]);
  });

  it('a seek answered before its new place came waits for native’s next word, wherever the seek landed', () => {
    install();
    const el = createNativeAudioElement();
    el.src = '/media/editions/e1/tracks/0';
    receive({ type: 'status', event: 'loadedmetadata', ...STATUS, duration: 900, readyState: 2 });
    el.currentTime = 300;
    seeked();
    expect(el.currentTime).toBe(300);
    receive({ type: 'status', event: 'timeupdate', ...STATUS, currentTime: 296.4, duration: 900, readyState: 2 });
    expect(el.currentTime).toBe(296.4);
  });

  it('holds a seek native never answers (no player at that moment) no longer than SEEK_HOLD_MS', () => {
    vi.useFakeTimers();
    try {
      install();
      const el = createNativeAudioElement();
      el.src = '/media/editions/e1/tracks/0';
      el.currentTime = 120;
      receive({ type: 'status', event: 'timeupdate', ...STATUS, currentTime: 3, readyState: 2 });
      expect(el.currentTime).toBe(120);
      vi.advanceTimersByTime(SEEK_HOLD_MS + 1);
      receive({ type: 'status', event: 'timeupdate', ...STATUS, currentTime: 3.5, readyState: 2 });
      expect(el.currentTime).toBe(3.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('native going on to the next track by itself ends a seek it can no longer answer', () => {
    install();
    const el = createNativeAudioElement();
    el.src = '/media/editions/e1/tracks/0';
    el.currentTime = 638;
    receive({ type: 'advanced', url: '/media/editions/e1/tracks/1' });
    receive({ type: 'status', event: 'ended', ...STATUS, currentTime: 640, ended: true, readyState: 2 });
    expect(el.currentTime).toBe(640);
    receive({ type: 'status', event: 'timeupdate', ...STATUS, currentTime: 0.5, readyState: 2, paused: false });
    expect(el.currentTime).toBe(0.5);
  });

  it('a new source ends any seek still held', () => {
    install();
    const el = createNativeAudioElement();
    el.src = '/media/editions/e1/tracks/0';
    el.currentTime = 500;
    el.src = '/media/editions/e1/tracks/1';
    receive({ type: 'status', event: 'timeupdate', ...STATUS, currentTime: 0.4, readyState: 2 });
    expect(el.currentTime).toBe(0.4);
  });

  it('says when native was where it says, the page’s own seek meanwhile, and now for an <audio> element', () => {
    install();
    const el = createNativeAudioElement();
    el.src = '/media/editions/e1/tracks/0';
    receive({ type: 'status', event: 'timeupdate', ...STATUS, currentTime: 61, readyState: 2, at: 1_700_000_000_000 });
    expect(observedAt(el)).toBe(1_700_000_000_000);
    const before = Date.now();
    el.currentTime = 90;
    expect(observedAt(el)).toBeGreaterThanOrEqual(before);
    // An older build sends no time: when the page heard it.
    receive({ type: 'status', event: 'timeupdate', ...STATUS, currentTime: 90, readyState: 2 });
    expect(observedAt(el)).toBeGreaterThanOrEqual(before);
    const audio = document.createElement('audio');
    expect(observedAt(audio)).toBeGreaterThanOrEqual(before);
  });

  it('asks native for the place it kept, and hands its answer to the page as a native-kept event', () => {
    const { sent } = install();
    const el = createNativeAudioElement();
    const kept: unknown[] = [];
    el.addEventListener('native-kept', (e) => kept.push((e as CustomEvent).detail));
    askNativeKept(el);
    expect(sent()).toEqual([{ type: 'tellKept' }]);
    const place = { bookId: 'b1', editionId: 'e1', userId: 'u1', locator: { kind: 'audio', track: 3, ms: 61_234 }, at: 1_700_000_000_000, spans: [] };
    receive({ type: 'kept', kept: place });
    receive({ type: 'kept', kept: null });
    expect(kept).toEqual([place, null]);
    // Nothing for an <audio> element.
    askNativeKept(document.createElement('audio'));
    expect(sent()).toHaveLength(1);
  });
});

describe('the native media session shim (D131)', () => {
  it('sends the artwork largest first, for native shows the first (D190)', () => {
    const { sent } = install();
    installNativeMediaSessionShim();
    navigator.mediaSession.metadata = {
      title: 'Chapter', artist: 'A', album: 'B',
      artwork: [96, 512, 256].map((s) => ({ src: `https://example.test/cover?w=${s}`, sizes: `${s}x${s}`, type: 'image/webp' })),
    };
    expect((sent()[0] as { artwork: string[] }).artwork).toEqual(['https://example.test/cover?w=512', 'https://example.test/cover?w=256', 'https://example.test/cover?w=96']);
  });

  it('sends metadata as native wants it (title, artist, album, and artwork as plain URLs)', () => {
    const { sent } = install();
    installNativeMediaSessionShim();
    // A plain object of the same shape: jsdom (unlike WebKit) has no MediaMetadata constructor.
    navigator.mediaSession.metadata = {
      title: 'Alice’s Adventures in Wonderland',
      artist: 'Lewis Carroll',
      album: 'Alice’s Adventures in Wonderland',
      artwork: [{ src: 'https://example.test/cover.webp', sizes: '320x480', type: 'image/webp' }],
    };
    expect(sent()).toEqual([
      { type: 'metadata', title: 'Alice’s Adventures in Wonderland', artist: 'Lewis Carroll', album: 'Alice’s Adventures in Wonderland', artwork: ['https://example.test/cover.webp'] },
    ]);
  });

  it('sends playbackState and positionState changes', () => {
    const { sent } = install();
    installNativeMediaSessionShim();
    navigator.mediaSession.playbackState = 'playing';
    navigator.mediaSession.setPositionState({ duration: 300, playbackRate: 1, position: 12 });
    expect(sent()).toEqual([{ type: 'playbackState', state: 'playing' }, { type: 'positionState', duration: 300, playbackRate: 1, position: 12 }]);
  });

  it('routes a remote command relayed from native to the handler AudioProvider registered', () => {
    install();
    const session = installNativeMediaSessionShim();
    // `window.__bookClubReceive` (where a `remote-action` message arrives) is registered by the
    // audio element, not the session itself: created here exactly as `AudioProvider` creates it,
    // passing the same session along so it can route to whatever handler was registered.
    createNativeAudioElement(session);
    const onSeekTo = vi.fn();
    navigator.mediaSession.setActionHandler('seekto', onSeekTo);
    const onPlay = vi.fn();
    navigator.mediaSession.setActionHandler('play', onPlay);
    receive({ type: 'remote-action', action: 'seekto', seekTime: 83 });
    expect(onSeekTo).toHaveBeenCalledWith(expect.objectContaining({ action: 'seekto', seekTime: 83 }));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('a handler cleared with null is not called', () => {
    install();
    const session = installNativeMediaSessionShim();
    createNativeAudioElement(session);
    const handler = vi.fn();
    navigator.mediaSession.setActionHandler('pause', handler);
    navigator.mediaSession.setActionHandler('pause', null);
    receive({ type: 'remote-action', action: 'pause' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the native navigation bridge (D134)', () => {
  it('does nothing outside the app', () => {
    installNativeNavigationBridge();
    expect(window.__bookClubNavigate).toBeUndefined();
  });

  it('moves the browser to a push notification’s path and fires popstate for the router to pick up', () => {
    install();
    history.pushState({}, '', '/');
    installNativeNavigationBridge();
    const heard = vi.fn();
    window.addEventListener('popstate', heard);
    window.__bookClubNavigate?.('/books/b1#note-n1');
    expect(location.pathname + location.hash).toBe('/books/b1#note-n1');
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener('popstate', heard);
  });
});
