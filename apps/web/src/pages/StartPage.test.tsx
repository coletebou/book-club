import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { SessionInfo } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { keys } from '../lib/queries';
import { StartPage } from './StartPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(session: SessionInfo) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.session, session);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/start']}>
        <Routes>
          <Route path="/start" element={<StartPage />} />
          <Route path="/" element={<p>Home page</p>} />
          <Route path="/setup" element={<p>Setup page</p>} />
          <Route path="/signin" element={<p>Sign in page</p>} />
          <Route path="/clubs/:clubId/settings" element={<p>Club settings page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SIGNED_OUT = (openSignup: boolean): SessionInfo => ({ user: null, setupRequired: false, upstream: null, providers: { apple: false, google: false }, openSignup });

describe('StartPage (D211)', () => {
  it('explains the instance is invite-only and offers sign-in when OPEN_SIGNUP is off, with no form', () => {
    open(SIGNED_OUT(false));
    expect(screen.getByRole('heading', { name: 'This instance is invite-only' })).toBeTruthy();
    expect(screen.queryByLabelText('Club name')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it('redirects away when already signed in', () => {
    open({ user: { id: 'u1', displayName: 'Nora', email: null, color: '#fff', source: 'local' }, setupRequired: false, upstream: null, providers: { apple: false, google: false }, openSignup: true });
    expect(screen.getByText('Home page')).toBeTruthy();
  });

  it('redirects to first-run setup on an empty instance', () => {
    open({ user: null, setupRequired: true, upstream: null, providers: { apple: false, google: false }, openSignup: true });
    expect(screen.getByText('Setup page')).toBeTruthy();
  });

  it('creates the account and the club in one request, and lands on the new club’s settings with the invite ready to copy', async () => {
    const startClub = vi.spyOn(api, 'startClub').mockResolvedValue({ user: { id: 'u1', displayName: 'Nora', email: 'nora@example.com', color: '#fff', source: 'local' }, clubId: 'club_1' });
    open(SIGNED_OUT(true));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Nora' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nora@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
    fireEvent.change(screen.getByLabelText('Club name'), { target: { value: 'Thursday Readers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create my club' }));
    expect(await screen.findByText('Club settings page')).toBeTruthy();
    expect(startClub).toHaveBeenCalledWith({ displayName: 'Nora', email: 'nora@example.com', password: 'correct horse battery', clubName: 'Thursday Readers' });
  });

  it('shows the server’s field errors, e.g. an email already in use', async () => {
    vi.spyOn(api, 'startClub').mockRejectedValue(new ApiError(409, 'email_taken', 'There is already an account with that email. Sign in instead.', { email: 'Already registered' }));
    open(SIGNED_OUT(true));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Nora' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nora@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
    fireEvent.change(screen.getByLabelText('Club name'), { target: { value: 'Thursday Readers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create my club' }));
    expect(await screen.findByText('Already registered')).toBeTruthy();
  });
});
