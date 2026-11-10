import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { SessionInfo } from '@bookclub/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { keys } from '../lib/queries';
import { LandingPage } from './LandingPage';

afterEach(() => {
  cleanup();
});

function open(session: SessionInfo) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.session, session);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/start" element={<p>Start a club page</p>} />
          <Route path="/signin" element={<p>Sign in page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const NOBODY = (openSignup: boolean): SessionInfo => ({ user: null, setupRequired: false, upstream: null, providers: { apple: false, google: false }, openSignup });

describe('LandingPage (D210)', () => {
  it('always offers the three doors: start a club, sign in, join with a link', () => {
    open(NOBODY(true));
    expect(screen.getAllByRole('link', { name: 'Start a club' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Sign in' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Join with a link' }).length).toBeGreaterThan(0);
  });

  it('says nothing about being invite-only when OPEN_SIGNUP is on', () => {
    open(NOBODY(true));
    expect(screen.queryByText(/invite-only right now/)).toBeNull();
  });

  it('says this instance is invite-only when OPEN_SIGNUP is off, without hiding the other two doors', () => {
    open(NOBODY(false));
    expect(screen.getAllByText(/invite-only right now/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Start a club' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Sign in' }).length).toBeGreaterThan(0);
  });

  it('describes the app without mentioning any pricing', () => {
    open(NOBODY(true));
    expect(screen.getByText(/spoiler-free by construction/i)).toBeTruthy();
    expect(screen.getByText(/open source/i)).toBeTruthy();
    expect(screen.queryByText(/pric(e|ing)/i)).toBeNull();
  });

  it('links to the project’s own repository for "host your own"', () => {
    open(NOBODY(true));
    const link = screen.getByRole('link', { name: 'View the source on GitHub' });
    expect(link.getAttribute('href')).toBe('https://github.com/coletebou/book-club');
  });

  it('links this server’s privacy policy (D227), a page the server writes itself', () => {
    open(NOBODY(true));
    expect(screen.getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe('/privacy');
  });
});
