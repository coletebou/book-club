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
  onclose: (() => void) | null = null;
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(navigator, 'mediaDevices'); });

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

  it.each(['socket error', 'socket close', 'server error'] as const)('releases the speaking hold on %s before a reply completes', async (failure) => {
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
      else if (failure === 'socket close') ws.onclose?.();
      else ws.onmessage?.({ data: JSON.stringify({ type: 'error' }) });
    });
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
      ws.onclose?.();
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
