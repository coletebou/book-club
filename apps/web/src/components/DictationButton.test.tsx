import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { DictationButton } from './DictationButton';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('discards the final data from a failed recorder and releases the microphone', async () => {
  const recorders: Recorder[] = [];
  class Recorder {
    readonly mimeType = 'audio/webm';
    state = 'inactive';
    onerror: (() => void) | null = null;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() {
      recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
    static isTypeSupported(type: string) { return type === 'audio/webm'; }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const dictate = vi.spyOn(api, 'dictate').mockResolvedValue({ text: 'unexpected' });
  const qc = new QueryClient();
  qc.setQueryData(['cal-status', 'club'], { dictation: true });
  const onText = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <DictationButton clubId="club" userId="member" onText={onText} />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
  await screen.findByRole('button', { name: 'Finish dictation' });
  const recorder = recorders[0]!;
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
