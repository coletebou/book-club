import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { realtime } from '../lib/realtime';
import { type VoiceSession, useVoiceSession } from '../live/voiceStore';
import PartyVoiceSync from './PartyVoiceSync';

vi.mock('../lib/realtime', () => ({ realtime: vi.fn() }));
vi.mock('../live/voiceStore', () => ({ useVoiceSession: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('ducks and reports an existing room only during playback in its own club', () => {
  const element = document.createElement('audio');
  element.volume = 0.75;
  const report = vi.fn();
  vi.mocked(realtime).mockReturnValue({ sendPartySpeaking: report } as unknown as ReturnType<typeof realtime>);
  let remoteSpeaking: ((value: boolean) => void) | undefined;
  const stopRemote = vi.fn();
  const stopLocal = vi.fn();
  const voice = {
    clubId: 'club',
    handle: {
      room: { activeSpeakers: [{ identity: 'Ana' }], localParticipant: { identity: 'me', isSpeaking: true } },
      onRemoteSpeaking: (callback: (value: boolean) => void) => { remoteSpeaking = callback; return stopRemote; },
      onLocalSpeaking: () => stopLocal,
    },
  } as unknown as VoiceSession;
  vi.mocked(useVoiceSession).mockReturnValue(voice);
  const view = (clubId: string) => <PartyVoiceSync bookId="book" clubId={clubId} element={element} />;
  const { rerender } = render(view('another-club'));
  expect(element.volume).toBe(0.75);
  expect(report).not.toHaveBeenCalled();

  rerender(view('club'));
  expect(element.volume).toBe(0.25);
  expect(report).toHaveBeenCalledWith('club', 'book', true);
  act(() => { remoteSpeaking?.(false); });
  expect(element.volume).toBe(0.75);
  act(() => { remoteSpeaking?.(true); });

  rerender(view('another-club'));
  expect(element.volume).toBe(0.75);
  expect(stopRemote).toHaveBeenCalledOnce();
  expect(stopLocal).toHaveBeenCalledOnce();
  expect(report).toHaveBeenLastCalledWith('club', 'book', false);
});
