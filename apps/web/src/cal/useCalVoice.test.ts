import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCalVoice } from './useCalVoice';

class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readyState = 1;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url = '') { FakeSocket.last = this; }
}

class FakeAudio {
  static last: FakeAudio | null = null;
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  constructor() { FakeAudio.last = this; }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(navigator, 'mediaDevices'); delete window.BookClubNative; });

describe('Cal voice replies', () => {
  it('unmount disposes the mic, recorder, socket and separate reply player before a hold can resume the book', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('Audio', FakeAudio);
    const stopRecorder = vi.fn();
    vi.stubGlobal('MediaRecorder', Object.assign(class { state = 'recording'; start = vi.fn(); stop = stopRecorder; }, { isTypeSupported: () => true }));
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) }, configurable: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unmount');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const { result, unmount } = renderHook(() => useCalVoice('club', 'conversation'));
    await act(async () => { await result.current.start(); });
    const ws = FakeSocket.last!;
    act(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: new Uint8Array([1]).buffer });
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) });
    });
    const player = FakeAudio.last!;
    expect(result.current.replying).toBe(true);
    unmount();
    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledOnce();
    expect(ws.onmessage).toBeNull();
    expect(player.pause).toHaveBeenCalled();
    expect(player.removeAttribute).toHaveBeenCalledWith('src');
    expect(player.onended).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:unmount');
  });

  it('releases a microphone permission result arriving after unmount without opening a socket', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.last = null;
    const stopTrack = vi.fn();
    let resolve!: (stream: MediaStream) => void;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockReturnValue(new Promise<MediaStream>((done) => { resolve = done; })) }, configurable: true });
    const { result, unmount } = renderHook(() => useCalVoice('club', 'conversation'));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    unmount();
    await act(async () => { resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream); await starting; });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeSocket.last).toBeNull();
  });

  it('keeps the microphone closed on CarPlay and cancels a spoken turn when the car connects', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const stopRecorder = vi.fn();
    vi.stubGlobal('MediaRecorder', Object.assign(class { state = 'recording'; start = vi.fn(); stop = stopRecorder; }, { isTypeSupported: () => true }));
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    const setCar = (connected?: boolean) => act(() => {
      window.BookClubNative = { postMessage: vi.fn(), ...(connected === undefined ? {} : { carPlayConnected: connected }) };
      window.dispatchEvent(new Event('bookclub:carplay-connection'));
    });

    setCar(true);
    const { result } = renderHook(() => useCalVoice('club', 'conversation'));
    expect(result.current.supported).toBe(false);
    await act(async () => { await result.current.start(); });
    expect(getUserMedia).not.toHaveBeenCalled();

    setCar();
    await act(async () => { await result.current.start(); });
    const ws = FakeSocket.last!;
    act(() => ws.onopen?.());
    expect(result.current.recording).toBe(true);

    setCar(true);
    expect(result.current.recording).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('discards a permission request that outlives a connect and disconnect', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.last = null;
    window.BookClubNative = { postMessage: vi.fn(), carPlayConnected: false };
    let grant!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => { grant = resolve; });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => permission }, configurable: true });
    const { result } = renderHook(() => useCalVoice('club', 'conversation'));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    expect(result.current.busy).toBe(true);
    act(() => {
      window.BookClubNative = { postMessage: vi.fn(), carPlayConnected: true };
      window.dispatchEvent(new Event('bookclub:carplay-connection'));
      window.BookClubNative = { postMessage: vi.fn(), carPlayConnected: false };
      window.dispatchEvent(new Event('bookclub:carplay-connection'));
    });
    expect(result.current.busy).toBe(false);

    const stopTrack = vi.fn();
    await act(async () => {
      grant({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
      await starting;
    });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeSocket.last).toBeNull();
  });

  it.each(['spoken stop', 'server limit', 'hidden tab', 'car during reply', 'car during save', 'late answer after interruption'])('detects speech over the room floor and handles %s', async (ending) => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('WebSocket', FakeSocket);
      vi.stubGlobal('Audio', FakeAudio);
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:continuous');
      vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
      const recorders: Recorder[] = [];
      class Recorder {
        mimeType = 'audio/mp4';
        state = 'inactive';
        ondataavailable: ((e: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        constructor() { recorders.push(this); }
        static isTypeSupported() { return true; }
        start() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob([new Uint8Array(70_000)], { type: this.mimeType }) });
          this.onstop?.();
        }
      }
      vi.stubGlobal('MediaRecorder', Recorder);
      let level = 0.035;
      vi.stubGlobal('AudioContext', class {
        createMediaStreamSource = () => ({ connect() {} });
        createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(level) });
        resume = vi.fn().mockResolvedValue(undefined);
        close = vi.fn().mockResolvedValue(undefined);
      });
      const stopTrack = vi.fn();
      const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
      let saveProgress!: () => void;
      const beforeTurn = vi.fn(() => new Promise<void>((resolve) => { saveProgress = resolve; }));
      const onTurnDone = vi.fn();
      const { result } = renderHook(() => useCalVoice('club', 'conversation', undefined, { beforeTurn, onTurnDone }));
      await act(async () => { await result.current.start(undefined, 'hands-free'); });
      const ws = FakeSocket.last!;
      act(() => ws.onopen?.());
      expect(result.current.handsFree).toBe(true);
      expect(recorders[0]!.state).toBe('recording');
      expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      act(() => { vi.advanceTimersByTime(1400); });
      expect(ws.send).not.toHaveBeenCalled();
      expect(beforeTurn).not.toHaveBeenCalled();
      level = 0.1;
      act(() => { vi.advanceTimersByTime(300); });
      level = 0.035;
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(beforeTurn).toHaveBeenCalledOnce();
      expect(stopTrack).toHaveBeenCalledOnce();
      expect(ws.send).not.toHaveBeenCalled();
      const connectCar = () => {
        window.BookClubNative = { postMessage: vi.fn(), carPlayConnected: true };
        window.dispatchEvent(new Event('bookclub:carplay-connection'));
      };
      if (ending === 'car during save') {
        act(connectCar);
        await act(async () => { saveProgress(); });
        expect(ws.send).not.toHaveBeenCalled();
        expect(ws.close).toHaveBeenCalledOnce();
        expect(result.current.handsFree).toBe(false);
        return;
      }
      await act(async () => { saveProgress(); });
      expect(ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data).type : data.size)).toEqual(['start', 65_536, 4_464, 'end']);

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'speakingStart' }) });
        ws.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
        ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) });
        if (ending !== 'late answer after interruption') ws.onmessage?.({ data: JSON.stringify({ type: 'turnDone', outcome: 'answered', limitReached: ending === 'server limit' }) });
      });
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(result.current.replying).toBe(true);
      if (ending === 'late answer after interruption') {
        act(() => {
          result.current.bargeIn();
          ws.onmessage?.({ data: JSON.stringify({ type: 'turnDone', outcome: 'answered' }) });
          ws.onmessage?.({ data: JSON.stringify({ type: 'turnDone', outcome: 'aborted' }) });
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(getUserMedia).toHaveBeenCalledTimes(2);
        expect(recorders).toHaveLength(2);
        act(connectCar);
        expect(stopTrack).toHaveBeenCalledTimes(2);
        expect(ws.close).toHaveBeenCalledOnce();
        return;
      }
      expect(onTurnDone).toHaveBeenCalledWith('conversation');
      if (ending === 'hidden tab' || ending === 'car during reply') {
        const player = FakeAudio.last!;
        const hidden = ending === 'hidden tab' ? vi.spyOn(document, 'hidden', 'get').mockReturnValue(true) : null;
        act(() => {
          if (ending === 'car during reply') connectCar();
          else document.dispatchEvent(new Event('visibilitychange'));
        });
        hidden?.mockRestore();
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(ws.close).toHaveBeenCalledOnce();
        expect(player.pause).toHaveBeenCalledOnce();
        expect(result.current.handsFree).toBe(false);
        expect(getUserMedia).toHaveBeenCalledOnce();
        return;
      }
      await act(async () => { FakeAudio.last!.onended?.(); });
      if (ending === 'server limit') {
        expect(result.current.error).toContain('Tap Talk hands-free');
        expect(result.current.handsFree).toBe(false);
        expect(ws.close).toHaveBeenCalledOnce();
        expect(getUserMedia).toHaveBeenCalledOnce();
        return;
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(499); });
      expect(getUserMedia).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(FakeSocket.last).toBe(ws);
      expect(result.current.recording).toBe(true);

      act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'turnDone', outcome: 'stopped' }) }));
      expect(ws.close).toHaveBeenCalledOnce();
      expect(result.current.handsFree).toBe(false);
      expect(result.current.recording).toBe(false);
      expect(stopTrack).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires an initial hands-free permission request after ten minutes', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('WebSocket', FakeSocket);
      FakeSocket.last = null;
      let asked!: () => void;
      let grant!: (stream: MediaStream) => void;
      const request = new Promise<void>((resolve) => { asked = resolve; });
      const permission = new Promise<MediaStream>((resolve) => { grant = resolve; });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { asked(); return permission; } } });
      const { result } = renderHook(() => useCalVoice('club', 'conversation'));
      let starting!: Promise<void>;
      await act(async () => { starting = result.current.start(undefined, 'hands-free'); await request; });
      await act(async () => { await vi.advanceTimersByTimeAsync(599_999); });
      expect(result.current.handsFree).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(result.current.error).toContain('Tap Talk hands-free');
      const stop = vi.fn();
      await act(async () => { grant({ getTracks: () => [{ stop }] } as unknown as MediaStream); await starting; });
      expect(stop).toHaveBeenCalledOnce();
      expect(FakeSocket.last).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays "talking" from speakingStart until his queued reply audio has finished playing', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('MediaRecorder', Object.assign(class { start = vi.fn(); stop = vi.fn(); }, { isTypeSupported: () => true }));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) }, configurable: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reply');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const { result } = renderHook(() => useCalVoice('club', 'conversation'));
    await act(async () => { await result.current.start(); });
    const ws = FakeSocket.last!;
    const talking = () => result.current.speaking || result.current.replying;
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'speakingStart' }) }));
    expect(talking()).toBe(true);
    act(() => {
      ws.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) });
    });
    expect(result.current.speaking).toBe(false);
    expect(result.current.replying).toBe(true); // His reply only starts playing now.
    act(() => FakeAudio.last!.onended?.());
    expect(talking()).toBe(false);

    act(() => {
      ws.onmessage?.({ data: new Uint8Array([4]).buffer });
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) });
    });
    expect(result.current.replying).toBe(true);
    act(() => result.current.bargeIn());
    expect(talking()).toBe(false);
  });

  it('clears reply playback when a replacement turn cannot access the microphone', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('MediaRecorder', Object.assign(class { start = vi.fn(); stop = vi.fn(); }, { isTypeSupported: () => true }));
    const getUserMedia = vi.fn().mockResolvedValueOnce({ getTracks: () => [] }).mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reply');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const { result } = renderHook(() => useCalVoice('club', 'conversation'));
    await act(async () => { await result.current.start(); });
    const ws = FakeSocket.last!;
    act(() => {
      ws.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) });
    });
    expect(result.current.replying).toBe(true);

    await act(async () => { await result.current.start(); });
    expect(result.current.error).toBe('Could not use the microphone.');
    expect(result.current.replying).toBe(false);
    expect(result.current.busy).toBe(false);
  });

  it('plays a reply in the narrator’s voice at the rate it is given for that voice, pitch kept, and Cal’s own at his (D223)', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('MediaRecorder', Object.assign(class { start = vi.fn(); stop = vi.fn(); }, { isTypeSupported: () => true }));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) }, configurable: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reply');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const replyRate = vi.fn((v: { kind: string }) => (v.kind === 'narrator' ? 1.5 : 1));
    const { result } = renderHook(() => useCalVoice('club', 'conversation', undefined, { replyRate }));
    const narrator = { kind: 'narrator', narrator: 'Kris Reader', source: 'designed' } as const;

    await act(async () => { await result.current.start(); });
    let ws = FakeSocket.last!;
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'speakingStart', voice: narrator }) }));
    expect(result.current.replyVoice).toEqual(narrator);
    act(() => {
      ws.onmessage?.({ data: new Uint8Array([1]).buffer });
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) });
    });
    const player = FakeAudio.last! as FakeAudio & { playbackRate?: number; preservesPitch?: boolean };
    expect(player.playbackRate).toBe(1.5);
    expect(player.preservesPitch).toBe(true);
    expect(replyRate).toHaveBeenLastCalledWith(narrator);

    // A server that names no voice (before D223) is Cal's.
    act(() => player.onended?.());
    await act(async () => { await result.current.start(); });
    expect(result.current.replyVoice).toBeNull();
    ws = FakeSocket.last!;
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingStart' }) });
      ws.onmessage?.({ data: new Uint8Array([2]).buffer });
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) });
    });
    expect(result.current.replyVoice).toEqual({ kind: 'cal' });
    expect((FakeAudio.last! as FakeAudio & { playbackRate?: number }).playbackRate).toBe(1);
  });

  it.each(['socket error', 'socket close', 'server error', 'signed out', 'revoked'] as const)('releases the speaking hold on %s before a reply completes', async (failure) => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('MediaRecorder', Object.assign(class { start = vi.fn(); stop = vi.fn(); }, { isTypeSupported: () => true }));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) }, configurable: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reply');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const { result } = renderHook(() => useCalVoice('club', 'conversation'));
    await act(async () => { await result.current.start(); });
    const ws = FakeSocket.last!;
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingStart' }) });
      ws.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
    });
    expect(result.current.speaking).toBe(true);
    act(() => {
      if (failure === 'socket error') ws.onerror?.();
      else if (failure === 'socket close') ws.onclose?.({ code: 1000 });
      else if (failure === 'signed out') ws.onclose?.({ code: 4001 });
      else if (failure === 'revoked') ws.onclose?.({ code: 4003 });
      else ws.onmessage?.({ data: JSON.stringify({ type: 'error' }) });
    });
    if (failure === 'signed out') expect(result.current.error).toContain('Sign in again');
    if (failure === 'revoked') expect(result.current.error).toContain('Cal AI access');
    expect(result.current.speaking || result.current.replying).toBe(false);
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) }));
    expect(result.current.replying).toBe(false); // Discard incomplete audio, don't play it after failure.
  });

  it('holds through normal socket close while reply audio plays, then releases on media error', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('MediaRecorder', Object.assign(class { start = vi.fn(); stop = vi.fn(); }, { isTypeSupported: () => true }));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) }, configurable: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reply');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const { result } = renderHook(() => useCalVoice('club', 'conversation'));
    await act(async () => { await result.current.start(); });
    const ws = FakeSocket.last!;
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingStart' }) });
      ws.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) });
      ws.onclose?.({ code: 1000 });
    });
    expect(result.current.speaking).toBe(false);
    expect(result.current.replying).toBe(true);
    act(() => FakeAudio.last!.onerror?.());
    expect(result.current.replying).toBe(false);
    expect(revoke).toHaveBeenCalledWith('blob:reply');
  });

  function stubVoiceDevices() {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('MediaRecorder', Object.assign(class { state = 'recording'; start = vi.fn(); stop = vi.fn(); }, { isTypeSupported: () => true }));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) }, configurable: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:busy');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  }

  it('refreshes an answered turn before closing hands-free mode when audio playback rejects', async () => {
    stubVoiceDevices();
    vi.stubGlobal('Audio', class extends FakeAudio {
      override play = vi.fn().mockRejectedValue(new Error('autoplay denied'));
    });
    const onTurnDone = vi.fn();
    const { result } = renderHook(() => useCalVoice('club', 'conversation', undefined, { onTurnDone }));
    await act(async () => { await result.current.start(undefined, 'hands-free'); });
    const ws = FakeSocket.last!;
    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingStart' }) });
      ws.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) });
    });
    expect(ws.close).not.toHaveBeenCalled();
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'turnDone', outcome: 'answered' }) }));
    expect(onTurnDone).toHaveBeenCalledWith('conversation');
    expect(ws.close).toHaveBeenCalledOnce();
    expect(result.current.handsFree).toBe(false);
    expect(result.current.error).toContain('could not play');
  });

  it('drops a partial question when the microphone stops before the member finishes', async () => {
    stubVoiceDevices();
    const recorders: Recorder[] = [];
    class Recorder {
      static isTypeSupported() { return true; }
      state = 'recording';
      start() {}
      stop() {}
      onstop: (() => void) | null = null;
      constructor() { recorders.push(this); }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    const beforeTurn = vi.fn();
    const { result } = renderHook(() => useCalVoice('club', 'conversation', undefined, { beforeTurn }));
    await act(async () => { await result.current.start(); });
    const ws = FakeSocket.last!;
    act(() => ws.onopen?.());
    expect(result.current.recording).toBe(true);
    const recorder = recorders[0]!;
    act(() => {
      recorder.state = 'inactive';
      recorder.onstop?.();
    });
    expect(result.current.recording).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(beforeTurn).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('is busy (D183) from the start of a turn, through the wait after release, until the reply has been sent', async () => {
    stubVoiceDevices();
    const { result } = renderHook(() => useCalVoice('club', 'conversation'));
    expect(result.current.busy).toBe(false);
    await act(async () => { await result.current.start('thread_new'); });
    const ws = FakeSocket.last!;
    act(() => ws.onopen?.());
    expect(result.current.busy).toBe(true);
    // Released: no longer recording, but Cal has not answered yet — still the same thread's turn.
    act(() => result.current.stop());
    expect(result.current.recording).toBe(false);
    expect(result.current.busy).toBe(true);
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'Why is he late?' }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'speakingStart' }) });
    });
    expect(result.current.busy).toBe(true);
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'speakingEnd' }) }));
    expect(result.current.busy).toBe(false);
  });

  it('starts in the thread it is given, and a turn that heard nothing or failed is over', async () => {
    stubVoiceDevices();
    const { result } = renderHook(() => useCalVoice('club', null));
    await act(async () => { await result.current.start('thread_new'); });
    // A thread only just created is used before a re-render could have passed it in.
    expect(FakeSocket.last!.url).toContain('conversationId=thread_new');
    const ws = FakeSocket.last!;
    act(() => ws.onopen?.());
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: '  ' }) }));
    expect(result.current.busy).toBe(false);

    await act(async () => { await result.current.start('thread_new'); });
    const second = FakeSocket.last!;
    act(() => second.onopen?.());
    expect(result.current.busy).toBe(true);
    act(() => second.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'nope' }) }));
    expect(result.current.busy).toBe(false);
  });
});
