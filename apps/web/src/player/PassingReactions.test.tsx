import { act, cleanup, render } from '@testing-library/react';
import type { CommentView, Edition } from '@bookclub/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { useToast } from '../components/Toasts';
import { useComments, useSession } from '../lib/queries';
import { type AudioController, useAudio } from './AudioProvider';
import { createNativeAudioElement } from './native-bridge';
import { PassingReactions } from './PassingReactions';

vi.mock('../components/Toasts', () => ({ useToast: vi.fn() }));
vi.mock('../lib/queries', () => ({ useComments: vi.fn(), useSession: vi.fn() }));
vi.mock('./AudioProvider', () => ({ useAudio: vi.fn() }));

afterEach(() => {
  cleanup();
  delete window.__bookClubReceive;
  vi.restoreAllMocks();
});

it('does not count even a short native seek between regular position updates as listening', () => {
  const show = vi.fn();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const element = createNativeAudioElement();
  const edition = { id: 'audio' } as Edition;
  const reaction = (id: string, ms: number, emoji: '❤️' | '😂') => ({
    id, userId: 'ana', authorName: 'Ana', editionId: edition.id, locator: { kind: 'audio', track: 0, ms },
    reaction: emoji, text: null, quote: null, hidden: false,
  }) as CommentView;
  vi.mocked(useToast).mockReturnValue({ show });
  vi.mocked(useAudio).mockReturnValue({ element, state: { track: 0, edition, book: { id: 'book' }, returnTo: null } } as unknown as AudioController);
  vi.mocked(useComments).mockReturnValue({ data: [reaction('skipped', 5_150, '😂'), reaction('heard', 5_650, '❤️')] } as ReturnType<typeof useComments>);
  vi.mocked(useSession).mockReturnValue({ data: { user: { id: 'me' } } } as ReturnType<typeof useSession>);
  const receive = (message: unknown) => window.__bookClubReceive?.(JSON.stringify(message));
  const clock = (currentTime: number, event = 'timeupdate') => receive({ type: 'status', event, currentTime, duration: 20, paused: false, ended: false, playbackRate: 1, readyState: 2, at: Date.now() });
  render(<PassingReactions bookId="book" edition={edition} />);

  act(() => {
    clock(5, 'playing');
    element.currentTime = 5.3;
    receive({ type: 'diagnostic', diagnostic: { event: 'native-seek', outcome: 'started' } });
    receive({ type: 'diagnostic', diagnostic: { event: 'native-seek', outcome: 'ok' } });
    now.mockReturnValue(1_500);
    clock(5.5);
  });
  expect(show).not.toHaveBeenCalled();

  act(() => {
    now.mockReturnValue(1_800);
    clock(5.8);
  });
  expect(show).toHaveBeenCalledExactlyOnceWith('Ana reacted ❤️');
});
