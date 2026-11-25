import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { SessionInfo } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toasts';
import { ApiError, api } from '../lib/api';
import * as offline from '../lib/offline';
import { keys } from '../lib/queries';

// The rest of Settings has nothing to do with deleting an account, and needs the real audiobook player.
const audio = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock('../player/AudioProvider', () => ({ useAudio: () => audio }));
vi.mock('../player/SpeedControl', () => ({ ListeningSettingsCard: () => null }));
vi.mock('../components/CalendarFeed', () => ({ CalendarFeedCard: () => null }));

import { SettingsPage } from './SettingsPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  audio.stop.mockClear();
});

function open(source: 'local' | 'apple') {
  vi.spyOn(api, 'clubs').mockResolvedValue([]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session: SessionInfo = {
    user: { id: 'u1', displayName: 'Nora', email: source === 'local' ? 'nora@example.com' : null, color: '#fff', source },
    setupRequired: false,
    upstream: null,
    providers: { apple: true, google: false },
    openSignup: false,
  };
  qc.setQueryData(keys.session, session);
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/settings']}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/signin" element={<p>Sign in page</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Settings: Delete account (D229)', () => {
  it('says what happens before asking for anything, and Cancel puts it away without deleting', () => {
    const deleteAccount = vi.spyOn(api, 'deleteAccount').mockResolvedValue(undefined);
    open('local');
    expect(screen.getByRole('heading', { name: 'Delete account' })).toBeTruthy();
    // Nothing to confirm yet: only the way in.
    expect(screen.queryByLabelText('Your password', { selector: 'input' })).toBeNull();
    fireEvent.click(screen.getByTestId('delete-account'));
    expect(screen.getByText(/stay in your clubs, shown as “Former member”/)).toBeTruthy();
    expect(screen.getByText(/goes to its longest-standing member/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/stay in your clubs/)).toBeNull();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('with a password: sends it, forgets this device and goes to sign in', async () => {
    const deleteAccount = vi.spyOn(api, 'deleteAccount').mockResolvedValue(undefined);
    const wipe = vi.spyOn(offline, 'wipeDevice').mockResolvedValue(undefined);
    open('local');
    fireEvent.click(screen.getByTestId('delete-account'));
    const confirm = screen.getByTestId('confirm-delete-account') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(confirm);
    expect(await screen.findByText('Sign in page')).toBeTruthy();
    expect(deleteAccount).toHaveBeenCalledWith({ password: 'correct horse battery' });
    expect(audio.stop).toHaveBeenCalled();
    expect(wipe).toHaveBeenCalled();
  });

  it('a wrong password shows the server’s answer, and nothing on this device is forgotten', async () => {
    vi.spyOn(api, 'deleteAccount').mockRejectedValue(new ApiError(400, 'invalid_credentials', 'Your password is not right.', { password: 'Incorrect' }));
    const wipe = vi.spyOn(offline, 'wipeDevice').mockResolvedValue(undefined);
    open('local');
    fireEvent.click(screen.getByTestId('delete-account'));
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'nope nope nope' } });
    fireEvent.click(screen.getByTestId('confirm-delete-account'));
    expect(await screen.findByText('Incorrect')).toBeTruthy();
    expect(screen.queryByText('Sign in page')).toBeNull();
    expect(wipe).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it('with no password (Apple, Google, the upstream): asks for the word DELETE instead', async () => {
    const deleteAccount = vi.spyOn(api, 'deleteAccount').mockResolvedValue(undefined);
    vi.spyOn(offline, 'wipeDevice').mockResolvedValue(undefined);
    open('apple');
    fireEvent.click(screen.getByTestId('delete-account'));
    expect(screen.queryByLabelText('Your password')).toBeNull();
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByTestId('confirm-delete-account'));
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith({ confirm: 'DELETE' }));
    expect(await screen.findByText('Sign in page')).toBeTruthy();
  });
});
