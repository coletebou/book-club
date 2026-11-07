import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ClubDetail, SessionInfo } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { keys } from '../lib/queries';
import { JoinPage } from './JoinPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ANA: SessionInfo = { user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null };
const NOBODY: SessionInfo = { user: null, setupRequired: false, upstream: null };

function detail(id: string, name: string, code: string): ClubDetail {
  return {
    id,
    name,
    description: '',
    role: 'member',
    memberCount: 3,
    bookCount: 1,
    upNext: null,
    members: [],
    invite: { code, url: `https://club.example/join/${code}` },
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

/** The invite page for `code`, as `session`, with the clubs they are in. */
function openInvite(session: SessionInfo, clubs: ClubDetail[] | Error, code = 'invite_thursday') {
  vi.spyOn(api, 'invitePreview').mockResolvedValue({ clubName: 'Thursday Readers', inviterName: 'Ben', memberCount: 3 });
  const listed = vi.spyOn(api, 'clubs').mockImplementation(() => (clubs instanceof Error ? Promise.reject(clubs) : Promise.resolve(clubs)));
  vi.spyOn(api, 'club').mockImplementation((id: string) => Promise.resolve((clubs as ClubDetail[]).find((c) => c.id === id)!));
  const accept = vi.spyOn(api, 'acceptInvite');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.session, session);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/join/${code}`]}>
        <Routes>
          <Route path="/join/:code" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { listed, accept };
}

describe('an invite link', () => {
  it('opened by someone already in its club says so, and opens the club in one tap: nothing to join', async () => {
    const { accept } = openInvite(ANA, [detail('club_poetry', 'Poetry Club', 'invite_poetry'), detail('club_thursday', 'Thursday Readers', 'invite_thursday')]);
    expect(await screen.findByRole('heading', { level: 1, name: 'You are already in Thursday Readers' })).toBeTruthy();
    expect(screen.getByText('This invite is for a club you are in: there is nothing to join.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the club' }).getAttribute('href')).toBe('/clubs/club_thursday');
    expect(screen.queryByRole('button', { name: /^Join/ })).toBeNull();
    expect(accept).not.toHaveBeenCalled();
  });

  it('opened by someone signed in who is not in its club offers to join, as before', async () => {
    openInvite(ANA, [detail('club_poetry', 'Poetry Club', 'invite_poetry')]);
    expect(await screen.findByRole('button', { name: 'Join as Ana' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Join Thursday Readers' })).toBeTruthy();
    expect(screen.getByText('Ben invited you to read with Thursday Readers (3 readers).')).toBeTruthy();
  });

  it('when your clubs cannot be had (offline), offers to join: joining a club you are in only opens it', async () => {
    openInvite(ANA, new ApiError(0, 'offline', 'You appear to be offline.'));
    expect(await screen.findByRole('button', { name: 'Join as Ana' })).toBeTruthy();
  });

  it('opened by someone signed out asks them to make an account, without asking for clubs they do not have', async () => {
    const { listed } = openInvite(NOBODY, []);
    expect(await screen.findByRole('button', { name: 'Join the club' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Join Thursday Readers' })).toBeTruthy();
    expect(listed).not.toHaveBeenCalled();
  });
});
