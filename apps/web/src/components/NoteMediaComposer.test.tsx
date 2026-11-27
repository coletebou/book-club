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

describe('voice capture from the listening sheet', () => {
  it.each([true, undefined])('does not request the mic from a native shell with car state %s', async (connected) => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('Permission denied'));
    vi.stubGlobal('MediaRecorder', class {});
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia } });
    carPlayConnection(connected);

    render(<NoteMediaComposer bookId="book" attachments={[]} onChange={vi.fn()} recordVoice guardCarPlay />);
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

    render(<NoteMediaComposer bookId="book" attachments={[]} onChange={vi.fn()} recordVoice guardCarPlay />);
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
    render(<NoteMediaComposer bookId="book" attachments={[]} onChange={vi.fn()} recordVoice guardCarPlay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));

    // A stale button can be pressed before the change notification removes it.
    window.BookClubNative = { postMessage: vi.fn(), carPlayConnected: true };
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(resume).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event('bookclub:carplay-connection')); });
    expect(stop).toHaveBeenCalledOnce();
  });
});
