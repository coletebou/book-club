import { type BookDetail } from '@bookclub/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({ saveNow: vi.fn(), openCal: vi.fn() }));
vi.mock('./AudioProvider', () => ({ useAudio: () => ({ saveNow: dependencies.saveNow }) }));
vi.mock('../cal/CalLauncher', () => ({ useClubCalContext: () => ({ clubId: 'club_1', enabled: true }) }));
vi.mock('../cal/calStore', async (actual) => ({ ...await actual<typeof import('../cal/calStore')>(), openCal: dependencies.openCal }));

import { AskListeningCal } from './ListeningActions';

function reportCarPlay(connected: boolean) {
  window.BookClubNative = { postMessage() {}, carPlayConnected: connected };
  window.dispatchEvent(new Event('bookclub:carplay-connection'));
}

afterEach(() => {
  cleanup();
  delete window.BookClubNative;
  Reflect.deleteProperty(navigator, 'mediaDevices');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([true, false])('keeps the dock launch typed after CarPlay interrupts a save (connected at tap: %s)', async (connectedAtTap) => {
  let finishSave!: () => void;
  dependencies.saveNow.mockImplementation(() => new Promise<void>((resolve) => { finishSave = resolve; }));
  const queryClient = new QueryClient();
  const book = { id: 'book_1', clubId: 'club_1' } as BookDetail;
  vi.stubGlobal('MediaRecorder', class {});
  vi.stubGlobal('AudioContext', class {});
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
  reportCarPlay(connectedAtTap);
  render(
    <QueryClientProvider client={queryClient}>
      <AskListeningCal book={book} />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: connectedAtTap ? 'Ask Cal' : 'Ask Cal by voice' }));
  await waitFor(() => expect(dependencies.saveNow).toHaveBeenCalledWith({ confirm: true }));
  expect(dependencies.openCal).not.toHaveBeenCalled();
  act(() => {
    if (!connectedAtTap) reportCarPlay(true);
    reportCarPlay(false);
    finishSave();
  });
  await waitFor(() => expect(dependencies.openCal).toHaveBeenCalledWith('club_1', 'book_1', { voice: false }));
});
