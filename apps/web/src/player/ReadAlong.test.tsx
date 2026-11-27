import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Edition, ReadAlongTrack } from '@bookclub/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { useReadAlong } from '../lib/queries';
import { ReadAlongPanel } from './ReadAlong';

vi.mock('../lib/queries', () => ({ useReadAlong: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
