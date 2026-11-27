import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteMediaComposer } from './NoteMediaComposer';

function carPlayConnection(connected?: boolean) {
  window.BookClubNative = { postMessage: vi.fn(), carPlayConnected: connected };
  window.dispatchEvent(new Event('bookclub:carplay-connection'));
}

afterEach(() => {
  cleanup();
  delete window.BookClubNative;
  vi.unstubAllGlobals();
});

it('blocks capture in the ordinary note composer when CarPlay is connected and restores it after disconnect', () => {
  vi.stubGlobal('MediaRecorder', class {});
  vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia: vi.fn() } });
  carPlayConnection(true);
  render(<NoteMediaComposer bookId="book" attachments={[]} onChange={vi.fn()} />);

  expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Video' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Photo' })).toBeTruthy();

  act(() => carPlayConnection(false));
  expect(screen.getByRole('button', { name: 'Voice' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Video' })).toBeTruthy();
});

it('stops a live note microphone in the connection event, before the recorder unmounts', async () => {
  const stop = vi.fn();
  vi.stubGlobal('MediaRecorder', class { start() {} });
  vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
  carPlayConnection(false);
  render(<NoteMediaComposer bookId="book" attachments={[]} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Voice' }));
  fireEvent.click(screen.getByTestId('voice-record-start'));
  await screen.findByRole('button', { name: 'Pause' });

  act(() => {
    carPlayConnection(true);
    expect(stop).toHaveBeenCalledOnce();
  });
  expect(screen.queryByTestId('voice-recorder')).toBeNull();
});

describe('voice capture from the listening sheet', () => {
  it.each([true, undefined])('does not request the mic from a native shell with car state %s', async (connected) => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('Permission denied'));
    vi.stubGlobal('MediaRecorder', class {});
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia } });
    carPlayConnection(connected);

    render(<NoteMediaComposer bookId="book" attachments={[]} onChange={vi.fn()} recordVoice />);
    await act(async () => {});
    expect(screen.queryByTestId('voice-recorder')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('releases the mic if CarPlay connects while a recording permission is in flight', async () => {
    const stop = vi.fn();
    let grant!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => { grant = resolve; });
    const getUserMedia = vi.fn(() => permission);
    vi.stubGlobal('MediaRecorder', class {});
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia } });
    carPlayConnection(false);

    render(<NoteMediaComposer bookId="book" attachments={[]} onChange={vi.fn()} recordVoice />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    act(() => carPlayConnection(true));
    expect(screen.queryByTestId('voice-recorder')).toBeNull();
    await act(async () => { grant({ getTracks: () => [{ stop }] } as unknown as MediaStream); });
    expect(stop).toHaveBeenCalledOnce();

    act(() => carPlayConnection(false));
    expect(screen.getByRole('button', { name: 'Voice' })).toBeTruthy();
    expect(screen.queryByTestId('voice-recorder')).toBeNull();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('clears a blocked permission result before the connection event arrives', async () => {
    const stop = vi.fn();
    let grant!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => { grant = resolve; });
    const getUserMedia = vi.fn(() => permission);
    vi.stubGlobal('MediaRecorder', class {});
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia } });
    carPlayConnection(false);
    render(<NoteMediaComposer bookId="book" attachments={[]} onChange={vi.fn()} recordVoice />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    window.BookClubNative = { postMessage: vi.fn(), carPlayConnected: true };
    await act(async () => { grant({ getTracks: () => [{ stop }] } as unknown as MediaStream); });
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('voice-recorder')).toBeNull();
    act(() => carPlayConnection(false));
    expect(screen.getByRole('button', { name: 'Voice' })).toBeTruthy();
  });

  it('does not resume a paused recording after the native state changes', async () => {
    const stop = vi.fn();
    const resume = vi.fn();
    vi.stubGlobal('MediaRecorder', class {
      start() {}
      pause() {}
      resume = resume;
    });
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
    carPlayConnection(false);
    render(<NoteMediaComposer bookId="book" attachments={[]} onChange={vi.fn()} recordVoice />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));

    // A stale button can be pressed before the change notification removes it.
    window.BookClubNative = { postMessage: vi.fn(), carPlayConnected: true };
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(resume).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event('bookclub:carplay-connection')); });
    expect(stop).toHaveBeenCalledOnce();
  });
});
