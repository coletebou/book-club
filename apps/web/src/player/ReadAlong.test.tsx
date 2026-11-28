import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Edition, ReadAlongTrack } from '@bookclub/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { useReadAlong } from '../lib/queries';
import { type AudioController, useAudioMaybe } from './AudioProvider';
import { createNativeAudioElement } from './native-bridge';
import { ReadAlongPanel } from './ReadAlong';

vi.mock('../lib/queries', () => ({ useReadAlong: vi.fn(), useSpokenWords: () => ({ data: undefined }) }));
vi.mock('./AudioProvider', () => ({ useAudioMaybe: vi.fn(() => null) }));
afterEach(() => {
  cleanup();
  delete window.__bookClubReceive;
  vi.mocked(useAudioMaybe).mockReturnValue(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const edition = { id: 'audio', readAlong: { textEditionId: 'epub' } } as Edition;
const track: ReadAlongTrack = {
  audioEditionId: 'audio', textEditionId: 'epub', track: 0,
  sentences: [[0, 0, 12, 100, 1_000], [0, 13, 13, 1_000, 2_000]],
  text: ['First words.', 'Second words.'],
};

function respondWithTrack(data: ReadAlongTrack | undefined) {
  vi.mocked(useReadAlong).mockReturnValue({ data } as ReturnType<typeof useReadAlong>);
}

it('prepares the track once while playback updates within a sentence', () => {
  const prepareTrack = vi.spyOn(track.sentences, 'map');
  respondWithTrack(track);
  const onSeek = vi.fn();
  const player = (ms: number) => <ReadAlongPanel bookId="book" edition={edition} track={0} ms={ms} onSeek={onSeek} inBook />;
  const { rerender } = render(player(100));
  expect(screen.getByTestId('readalong-current').textContent).toBe('First words.');
  for (const ms of [200, 400, 600, 800]) rerender(player(ms));
  expect(prepareTrack).toHaveBeenCalledOnce();

  rerender(player(1_300));
  expect(screen.getByTestId('readalong-current').textContent).toBe('Second words.');
  expect(prepareTrack).toHaveBeenCalledOnce();
});

it('keeps focus in the panel when the next track has no words', async () => {
  const player = (trackIndex: number) => <ReadAlongPanel bookId="book" edition={edition} track={trackIndex} ms={100} onSeek={vi.fn()} inBook />;
  respondWithTrack(track);
  const { rerender } = render(player(0));
  fireEvent.click(screen.getByRole('button', { name: 'Show words' }));
  await act(async () => { screen.getByRole('button', { name: 'First words.' }).focus(); });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First words.' }));

  respondWithTrack(undefined);
  rerender(player(1));
  expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Narrated words' }));

  respondWithTrack({ ...track, track: 1, sentences: [], text: [] });
  rerender(player(1));
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Reading along' }));
});

it('shows no compact preview when a track is past the printed text', () => {
  respondWithTrack({ ...track, lead: [0, 0], finalTextTrack: true });
  const player = (ms: number) => <ReadAlongPanel bookId="book" edition={edition} track={0} ms={ms} onSeek={vi.fn()} inBook />;
  const { rerender } = render(player(1_400));
  expect(screen.getByTestId('readalong-current').textContent).toEqual('Second words.');
  rerender(player(2_400));
  expect(screen.getByText('Past the end of the text.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Second words.' })).toBeNull();
});

it('highlights a matched word while it sounds and clears it in the gap', () => {
  const timings: ReadAlongTrack['wordTimings'] = [[[0, 5, 100, 250], [6, 5, 400, 600]], []];
  respondWithTrack({ ...track, wordTimings: timings });
  const seek = vi.fn();
  const player = (ms: number) => <ReadAlongPanel bookId="book" edition={edition} track={0} ms={ms} onSeek={seek} inBook />;
  const { rerender } = render(player(100));
  fireEvent.click(screen.getByRole('button', { name: 'Show words' }));
  expect(screen.getByTestId('readalong-word').textContent).toBe('First');

  rerender(player(250));
  expect(screen.queryByTestId('readalong-word')).toBeNull();
  expect(screen.getByTestId('readalong-current').textContent).toBe('First words.');

  rerender(player(500));
  expect(screen.getByTestId('readalong-word').textContent).toBe('words');
});

it('wakes at the word boundary between playback updates from the iOS shell', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const frame = vi.spyOn(window, 'requestAnimationFrame');
  const element = createNativeAudioElement();
  window.__bookClubReceive?.(JSON.stringify({ type: 'status', event: 'timeupdate', currentTime: 0.1, duration: 3, paused: false, ended: false, playbackRate: 1, readyState: 2, at: 10_000 }));
  vi.mocked(useAudioMaybe).mockReturnValue({ element, state: { edition, track: 0, playing: true, buffering: false } } as AudioController);
  respondWithTrack({ ...track, wordTimings: [[[0, 5, 100, 150], [6, 5, 220, 250]], []] });
  render(<ReadAlongPanel bookId="book" edition={edition} track={0} ms={100} onSeek={vi.fn()} inBook />);
  fireEvent.click(screen.getByRole('button', { name: 'Show words' }));
  expect(screen.getByTestId('readalong-word').textContent).toBe('First');

  act(() => { vi.advanceTimersByTime(50); });
  expect(screen.queryByTestId('readalong-word')).toBeNull();
  act(() => { element.playbackRate = 2; });
  // At 150 ms in the recording, the new speed needs 35 ms to reach the 220 ms word.
  act(() => { vi.advanceTimersByTime(25); });
  expect(screen.queryByTestId('readalong-word')).toBeNull();
  act(() => { vi.advanceTimersByTime(12); });
  expect(screen.getByTestId('readalong-word').textContent).toBe('words');
  expect(element.currentTime).toBe(0.1);
  expect(frame).not.toHaveBeenCalled();
});

it('does not show the last playing sample after a paused seek', () => {
  const element = document.createElement('audio');
  const state = (playing: boolean) => vi.mocked(useAudioMaybe).mockReturnValue({ element, state: { edition, track: 0, playing, buffering: false } } as AudioController);
  const player = (ms: number) => <ReadAlongPanel bookId="book" edition={edition} track={0} ms={ms} onSeek={vi.fn()} inBook />;
  respondWithTrack({ ...track, wordTimings: [[[0, 5, 100, 300]], [[0, 6, 1_200, 1_400]]] });
  element.currentTime = 0.15;
  state(true);
  const { rerender } = render(player(150));
  fireEvent.click(screen.getByRole('button', { name: 'Show words' }));
  expect(screen.getByTestId('readalong-word').textContent).toBe('First');

  state(false);
  rerender(player(150));
  element.currentTime = 1.3;
  rerender(player(1_300));
  state(true);
  rerender(player(1_300));
  // No clock tick has run since Play. Keep the line at the latest reported place.
  expect(screen.getByTestId('readalong-word').textContent).toBe('Second');
});

it('resamples a playing native seek before the next playback report and re-arms at completion', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const element = createNativeAudioElement();
  const receive = (message: unknown) => window.__bookClubReceive?.(JSON.stringify(message));
  const status = (currentTime: number) => receive({ type: 'status', event: 'timeupdate', currentTime, duration: 3, paused: false, ended: false, playbackRate: 1, readyState: 2, at: 10_000 });
  status(0.1);
  vi.mocked(useAudioMaybe).mockReturnValue({ element, state: { edition, track: 0, playing: true, buffering: false } } as AudioController);
  respondWithTrack({ ...track, wordTimings: [[[0, 5, 100, 300]], [[0, 6, 1_200, 1_400], [7, 5, 1_450, 1_500]]] });
  const panel = (ms: number) => <ReadAlongPanel bookId="book" edition={edition} track={0} ms={ms} onSeek={vi.fn()} inBook />;
  const { rerender } = render(panel(100));
  fireEvent.click(screen.getByRole('button', { name: 'Show words' }));
  expect(screen.getByTestId('readalong-word').textContent).toBe('First');

  act(() => { element.currentTime = 1.3; });
  expect(screen.getByTestId('readalong-word').textContent).toBe('Second');
  rerender(panel(1_300));
  act(() => {
    receive({ type: 'diagnostic', diagnostic: { event: 'native-seek', outcome: 'started' } });
    status(1.3);
    receive({ type: 'diagnostic', diagnostic: { event: 'native-seek', outcome: 'ok', durationMs: 20 } });
  });
  act(() => { vi.advanceTimersByTime(152); });
  expect(screen.getByTestId('readalong-word').textContent).toBe('words');
  expect(element.currentTime).toBe(1.3);
});
