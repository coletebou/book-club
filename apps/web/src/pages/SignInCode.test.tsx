import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { SessionInfo } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { keys } from '../lib/queries';
import { SignInElsewhere } from './SettingsPage';
import { SignInPage } from './SignInPage';

/* One-time sign-in codes (D87): made in Settings where you are signed in, typed where you are not. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOBODY: SessionInfo = { user: null, setupRequired: false, upstream: { name: 'Upstream ID', password: false } };
const ELI: SessionInfo = {
  user: { id: 'user_eli', displayName: 'Eli', email: 'eli@upstream.test', color: '#FF6B6B', source: 'upstream' },
  setupRequired: false,
  upstream: { name: 'Upstream ID', password: false },
};

function open(element: React.ReactElement, session: SessionInfo, path = '/signin?next=%2Fclubs%2Fclub_1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.session, session);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/signin" element={element} />
          <Route path="/settings" element={element} />
          <Route path="/clubs/:clubId" element={<p>The club</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

/** As the app opened from the Home Screen sees itself, or as a browser tab does. */
function asHomeScreenApp(installed: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: installed && query === '(display-mode: standalone)', media: query }) as MediaQueryList);
}

describe('signing in with a code', () => {
  it('is offered beside the password, and signs in with the digits as typed, spaces and all', async () => {
    asHomeScreenApp(false);
    const redeem = vi.spyOn(api, 'signInWithCode').mockResolvedValue({ user: ELI.user! });
    vi.spyOn(api, 'session').mockResolvedValue(ELI);
    open(<SignInPage />, NOBODY);
    expect(screen.queryByTestId('home-screen-hint')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a code' }));
    const field = screen.getByLabelText('Sign-in code');
    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field.getAttribute('inputmode')).toBe('numeric');
    fireEvent.change(field, { target: { value: '4821 7730' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with the code' }));
    expect(await screen.findByText('The club')).toBeTruthy();
    expect(redeem).toHaveBeenCalledWith('4821 7730');
  });

  it('says why a code does not work', async () => {
    asHomeScreenApp(false);
    vi.spyOn(api, 'signInWithCode').mockRejectedValue(new ApiError(401, 'invalid_code', 'That code does not work. A code works once, for 10 minutes: get a new one where you are signed in.'));
    open(<SignInPage />, NOBODY);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a code' }));
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '00000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with the code' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That code does not work.');
  });

  it('in the app on the Home Screen, says how to get a code when the upstream signs you in elsewhere', () => {
    asHomeScreenApp(true);
    open(<SignInPage />, NOBODY);
    expect(screen.getByTestId('home-screen-hint').textContent).toBe('Back here after signing in with Upstream ID? In Safari, sign in to Book Club, get a code in Settings and type it under “Sign in with a code”.');
  });
});

describe('a code in Settings', () => {
  it('is made on request, shown in two fours with the time it works until, and announced', async () => {
    vi.spyOn(api, 'signInCode').mockResolvedValue({ code: '48217730', expiresAt: '2026-10-25T10:42:00.000Z' });
    open(<SignInElsewhere />, ELI, '/settings');
    expect(screen.getByRole('heading', { name: 'Sign in on another device' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get a code' }));
    expect((await screen.findByTestId('sign-in-code')).textContent).toBe('4821 7730');
    expect(screen.getByRole('status').textContent).toMatch(/^Your code: 4821 7730Works until .+\.$/);
    expect(screen.getByRole('button', { name: 'Get a new code' })).toBeTruthy();
  });
});
