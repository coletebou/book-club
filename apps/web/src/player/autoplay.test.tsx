import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BookDetail, Edition } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { api } from '../lib/api';
import { keys } from '../lib/queries';
import { AudioProvider, useAudio, useAudioState } from './AudioProvider';

/*
 * Started in the tap that asks for it (D194): `load(…, { play: true })` calls `play()` in that very
 * call, before the track's metadata arrives (which comes after the tap is over); a refusal for want
 * of a tap is said (`blocked`), and the place heard from is where it is about to seek, not 0:00.
 */

vi.mock('../lib/outbox', () => ({ saveProgress: vi.fn().mockResolvedValue(undefined), saveProgressNow: vi.fn(), rememberPosition: vi.fn().mockResolvedValue(undefined), currentUser: () => 'self', flushOutbox: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/realtime', () => ({ realtime: () => null, useClubPresence: vi.fn() }));

const edition = {
  id: 'edition',
  kind: 'audio',
  tracks: [
    { index: 0, title: 'Track 1', url: '/track/0', durationMs: 100_000, chapter: null },
    { index: 1, title: 'Track 2', url: '/track/1', durationMs: 100_000, chapter: null },
  ],
  units: [],
  alignment: { unitToChapter: [] },
  geometry: null,
  sync: null,
} as unknown as Edition;
const book = { id: 'book', title: 'Test', author: 'Author', coverUrl: '/cover?x=1', chapters: [], editions: [edition] } as unknown as BookDetail;

let calls: string[];
let refuse: Error | null;
let place: { track: number; ms: number } | null;

function Probe() {
  const audio = useAudio();
  const state = useAudioState();
  return (
    <>
      <button
        onClick={() => {
          audio.load(book, edition, { kind: 'audio', track: 1, ms: 30_000 }, { play: true });
          calls.push('after load');
          place = audio.locator();
        }}
      >
        Read along
      </button>
      <button onClick={() => audio.load(book, edition, null)}>Load paused</button>
      <output data-testid="blocked">{String(state.blocked)}</output>
      <output data-testid="playing">{String(state.playing)}</output>
    </>
  );
}

beforeEach(() => {
  calls = [];
  refuse = null;
  place = null;
  vi.stubGlobal('MediaMetadata', class {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    calls.push(`play ${this.getAttribute('src') ?? this.src}`);
    return refuse ? Promise.reject(refuse) : Promise.resolve();
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(keys.session, { user: { id: 'self' } });
  qc.setQueryData(keys.party('book'), null);
  vi.spyOn(api, 'party').mockResolvedValue(null);
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AudioProvider>
          <Probe />
        </AudioProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('reading along starts in the tap that asks for it (D194)', () => {
  it('plays the new track in the same call, before its metadata, and is about to seek to the place', () => {
    fireEvent.click(screen.getByText('Read along'));
    // play() came inside load(), synchronously: inside the tap, as a browser needs.
    expect(calls[0]).toMatch(/^play .*\/track\/1$/);
    expect(calls[1]).toBe('after load');
    // Still loading: the place is where it will seek, so time heard is not counted from 0:00.
    expect(place).toEqual({ kind: 'audio', track: 1, ms: 30_000 });
  });

  it('a load without play plays nothing', () => {
    fireEvent.click(screen.getByText('Load paused'));
    expect(calls).toEqual([]);
  });

  it('the same audiobook, already in the player and paused, plays where it is', () => {
    fireEvent.click(screen.getByText('Load paused'));
    fireEvent.click(screen.getByText('Read along'));
    expect(calls).toEqual([expect.stringMatching(/^play /), 'after load']);
  });

  it('a refusal for want of a tap is said, and playing clears it', async () => {
    refuse = Object.assign(new Error('The request is not allowed'), { name: 'NotAllowedError' });
    fireEvent.click(screen.getByText('Read along'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('blocked').textContent).toBe('true');
    const el = document.querySelector('audio')!;
    Object.defineProperty(el, 'paused', { configurable: true, get: () => false });
    act(() => {
      el.dispatchEvent(new Event('play'));
    });
    expect(screen.getByTestId('blocked').textContent).toBe('false');
    expect(screen.getByTestId('playing').textContent).toBe('true');
  });

  it('any other refusal (a newer source, a pause) is no news', async () => {
    refuse = Object.assign(new Error('interrupted'), { name: 'AbortError' });
    fireEvent.click(screen.getByText('Read along'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('blocked').textContent).toBe('false');
  });
});
