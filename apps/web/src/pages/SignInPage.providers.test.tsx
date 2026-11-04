import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { SessionInfo } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installNativeAuthBridge } from '../auth/native-auth-bridge';
import { api } from '../lib/api';
import { keys } from '../lib/queries';
import { SignInPage } from './SignInPage';

/** D178: the "Sign in with Apple" / "Continue with Google" buttons, shown per `providers` and
 * whether this is the app or a browser (`window.BookClubNative`'s presence, the same signal
 * `player/native-bridge.ts`'s `isNativeApp` reads). In the real app, `main.tsx` installs the
 * inbound bridge once at startup, before React ever mounts; a render in a test needs the same
 * call, since nothing here imports `main.tsx` itself. */
beforeEach(() => {
  installNativeAuthBridge();
});

afterEach(() => {
  cleanup();
  delete window.BookClubNative;
  delete window.__bookClubAuthReceive;
  vi.restoreAllMocks();
});

function open(session: SessionInfo, path = '/signin?next=%2Fclubs%2Fclub_1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.session, session);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/signin" element={<SignInPage />} />
          <Route path="/clubs/:clubId" element={<p>The club</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const NOBODY = (providers: SessionInfo['providers']): SessionInfo => ({ user: null, setupRequired: false, upstream: null, providers });

/** Stand in for `apps/mobile/src/webview/injected.ts`'s bootstrap, enough to flip `isNativeApp()` on. */
function enterNativeApp(answer: (command: { type: string }) => unknown): void {
  window.BookClubNative = {
    postMessage: (json: string) => {
      const command = JSON.parse(json) as { type: string };
      queueMicrotask(() => window.__bookClubAuthReceive?.(JSON.stringify(answer(command))));
    },
  };
}

describe('provider buttons on the sign-in page (D178)', () => {
  it('shows neither button in a browser when neither provider is configured', () => {
    open(NOBODY({ apple: false, google: false }));
    expect(screen.queryByTestId('apple-signin')).toBeNull();
    expect(screen.queryByTestId('google-signin')).toBeNull();
  });

  it('offers Google as a link to the server redirect in a browser, never Apple', () => {
    open(NOBODY({ apple: true, google: true }), '/signin?next=%2Fclubs%2Fclub_1');
    expect(screen.queryByTestId('apple-signin')).toBeNull();
    const google = screen.getByTestId('google-signin');
    expect(google.tagName).toBe('A');
    expect(google.getAttribute('href')).toBe('/api/auth/google/start?next=%2Fclubs%2Fclub_1');
  });

  it('offers both as native buttons inside the app, and signs in with what native sends back for Apple', async () => {
    enterNativeApp((command) =>
      command.type === 'auth:apple'
        ? { type: 'auth:apple-result', ok: true, identityToken: 'tok-1', nonce: 'raw-1', fullName: 'Ana' }
        : { type: 'auth:google-result', ok: false, reason: 'canceled' },
    );
    const signInApple = vi.spyOn(api, 'signInApple').mockResolvedValue({ user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#000', source: 'apple' } });
    open(NOBODY({ apple: true, google: true }));
    const apple = screen.getByTestId('apple-signin');
    expect(apple.tagName).toBe('BUTTON');
    fireEvent.click(apple);
    expect(await screen.findByText('The club')).toBeTruthy();
    expect(signInApple).toHaveBeenCalledWith({ identityToken: 'tok-1', nonce: 'raw-1', fullName: 'Ana' });
  });

  it('redeems the app-code handoff for Google inside the app, not a server redirect', async () => {
    enterNativeApp((command) => (command.type === 'auth:google' ? { type: 'auth:google-result', ok: true, code: 'code-1', verifier: 'verifier-1' } : { type: 'auth:apple-result', ok: false, reason: 'canceled' }));
    const redeemAppCode = vi.spyOn(api, 'redeemAppCode').mockResolvedValue({ user: { id: 'user_gus', displayName: 'Gus', email: null, color: '#000', source: 'google' } });
    open(NOBODY({ apple: true, google: true }));
    fireEvent.click(screen.getByTestId('google-signin'));
    expect(await screen.findByText('The club')).toBeTruthy();
    expect(redeemAppCode).toHaveBeenCalledWith({ code: 'code-1', verifier: 'verifier-1' });
  });

  it('says nothing when a native sign-in sheet is dismissed', async () => {
    enterNativeApp(() => ({ type: 'auth:apple-result', ok: false, reason: 'canceled' }));
    vi.spyOn(api, 'signInApple');
    open(NOBODY({ apple: true, google: false }));
    fireEvent.click(screen.getByTestId('apple-signin'));
    await vi.waitFor(() => expect(screen.getByTestId<HTMLButtonElement>('apple-signin').disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.signInApple).not.toHaveBeenCalled();
  });

  it('tells Google\'s own refusal apart from the upstream\'s', () => {
    open({ user: null, setupRequired: false, upstream: { name: 'Upstream ID', password: false }, providers: { apple: false, google: true } }, '/signin?google=refused');
    expect(screen.getByRole('alert').textContent).toBe('Google did not sign you in here. Try again, or ask your club owner.');
  });
});
