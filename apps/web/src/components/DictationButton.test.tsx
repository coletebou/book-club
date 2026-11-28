import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { calApi } from '../lib/cal-api';
import { DictationButton } from './DictationButton';

class Recorder {
  static instances: Recorder[] = [];
  readonly mimeType = 'audio/webm';
  state = 'inactive';
  onerror: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {
    Recorder.instances.push(this);
  }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; }
  static isTypeSupported(type: string) { return type === 'audio/webm'; }
}

function fakeMic(getUserMedia: () => Promise<unknown>) {
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
}

function showComposer() {
  const dictate = vi.spyOn(api, 'dictate').mockResolvedValue({ text: 'unexpected' });
  const consent = vi.spyOn(calApi, 'consent').mockResolvedValue({ enabled: true, allowed: true, hasGrant: true, version: 'current', providers: [] });
  const qc = new QueryClient();
  qc.setQueryData(['cal-status', 'club', 'member'], { dictation: true });
  const onText = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <DictationButton clubId="club" userId="member" onText={onText} />
    </QueryClientProvider>,
  );
  return { consent, dictate, onText };
}

function carConnection(connected: boolean) {
  act(() => {
    window.BookClubNative = { postMessage: vi.fn(), carPlayConnected: connected };
    window.dispatchEvent(new Event('bookclub:carplay-connection'));
  });
}

afterEach(() => {
  cleanup();
  Recorder.instances = [];
  delete window.BookClubNative;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('checks live consent even when the cached status allows capture', async () => {
  const getUserMedia = vi.fn();
  fakeMic(getUserMedia);
  const { consent, dictate } = showComposer();
  consent.mockResolvedValue({ enabled: true, allowed: false, hasGrant: false, version: 'current', providers: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
  await screen.findByRole('dialog', { name: 'Allow AI access for dictation?' });
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(dictate).not.toHaveBeenCalled();
});

it('drops a completed recording when consent changed before upload', async () => {
  const stop = vi.fn();
  fakeMic(async () => ({ getTracks: () => [{ stop }] }));
  const { consent, dictate } = showComposer();
  fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
  await screen.findByRole('button', { name: 'Finish dictation' });
  consent.mockResolvedValue({ enabled: true, allowed: false, hasGrant: false, version: 'current', providers: [] });
  const recorder = Recorder.instances[0]!;
  act(() => {
    recorder.ondataavailable?.({ data: new Blob(['A recording']) });
    recorder.onstop?.();
  });
  await screen.findByRole('dialog', { name: 'Allow AI access for dictation?' });
  expect(stop).toHaveBeenCalledOnce();
  expect(dictate).not.toHaveBeenCalled();
});

it('discards the final data from a failed recorder and releases the microphone', async () => {
  const stopTrack = vi.fn();
  fakeMic(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  const { dictate, onText } = showComposer();

  fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
  await screen.findByRole('button', { name: 'Finish dictation' });
  const recorder = Recorder.instances[0]!;
  act(() => {
    recorder.state = 'inactive';
    recorder.onerror?.();
    recorder.ondataavailable?.({ data: new Blob(['partial recording']) });
    recorder.onstop?.();
  });
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(dictate).not.toHaveBeenCalled();
  expect(onText).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Dictate' }).hasAttribute('disabled')).toBe(false);
});

it('allows an unreported car state and drops an active clip on connection', async () => {
  window.BookClubNative = { postMessage: vi.fn() };
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  fakeMic(getUserMedia);
  const { dictate, onText } = showComposer();

  expect(screen.getByRole('button', { name: 'Dictate' })).toBeTruthy();
  carConnection(true);
  expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();

  carConnection(false);
  fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }));
  await screen.findByRole('button', { name: 'Finish dictation' });
  const recorder = Recorder.instances[0]!;
  carConnection(true);
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(recorder.state).toBe('inactive');
  expect(dictate).not.toHaveBeenCalled();
  expect(onText).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull();
});

it('releases a microphone permission result that arrives after CarPlay connects', async () => {
  carConnection(false);
  const stopTrack = vi.fn();
  let grant!: (stream: unknown) => void;
  const permission = new Promise((resolve) => { grant = resolve; });
  const getUserMedia = vi.fn(() => permission);
  fakeMic(getUserMedia);
  const { dictate } = showComposer();

  fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  carConnection(true);
  await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] }); });
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(Recorder.instances).toHaveLength(0);
  expect(dictate).not.toHaveBeenCalled();
});
