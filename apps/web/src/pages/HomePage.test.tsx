import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import type { BookSummary, ClubSummary, MemberProgress, PresenceEntry } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import * as offline from '../lib/offline';
import { keys, makeQueryClient } from '../lib/queries';
import { HomePage, clubNow, inviteCodeFrom } from './HomePage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHome(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('HomePage', () => {
  it('offline, with no club list kept, says so and offers the books kept on the device (not "no clubs")', async () => {
    vi.spyOn(api, 'clubs').mockRejectedValue(new ApiError(0, 'offline', 'You are offline and this has not been saved on this device.'));
    vi.spyOn(offline, 'keptBooks').mockResolvedValue([{ bookId: 'book_alice', title: "Alice's Adventures in Wonderland" }]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(keys.session, { user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null });
    renderHome(qc);
    expect(await screen.findByRole('heading', { name: 'You are offline' })).toBeTruthy();
    expect(screen.queryByText(/You are not in a club yet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start a club' })).toBeNull();
    const link = await screen.findByRole('link', { name: "Alice's Adventures in Wonderland" });
    expect(link.getAttribute('href')).toBe('/books/book_alice');
  });

  it('offline, says so at once with the app’s own client too (its next try waits for the network, the page is not left blank)', async () => {
    vi.spyOn(api, 'clubs').mockRejectedValue(new ApiError(0, 'offline', 'You appear to be offline.'));
    vi.spyOn(offline, 'keptBooks').mockResolvedValue([]);
    const qc = makeQueryClient();
    qc.setQueryData(keys.session, { user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null });
    renderHome(qc);
    expect(await screen.findByRole('heading', { name: 'You are offline' })).toBeTruthy();
    expect(await screen.findByText(/No books are kept on this device yet/)).toBeTruthy();
    qc.clear();
  });

  it('online, when the server fails, says so and offers to try again (not “offline”)', async () => {
    const clubs = vi.spyOn(api, 'clubs').mockRejectedValue(new ApiError(500, 'internal', 'Something went wrong.'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(keys.session, { user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null });
    renderHome(qc);
    expect(await screen.findByRole('heading', { name: 'Your clubs could not be loaded' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'You are offline' })).toBeNull();
    clubs.mockResolvedValue([]);
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(await screen.findByText(/You are not in a club yet/)).toBeTruthy();
  });

  it('online with no clubs, offers to start one, local account or upstream alike (D52’s invite-first restriction on upstream accounts was reversed)', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([]);
    for (const source of ['local', 'upstream'] as const) {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      qc.setQueryData(keys.session, { user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source }, setupRequired: false, upstream: source === 'upstream' ? { name: 'Upstream ID' } : null });
      renderHome(qc);
      expect(await screen.findByText(/You are not in a club yet. Start one/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Start a club' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Join with a link' })).toBeTruthy();
      cleanup();
    }
  });

  it('"Join with a link" takes a pasted invite link or a bare code to the join page', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(keys.session, { user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null });
    function JoinTarget() {
      const { code } = useParams();
      return <p>Joining {code}</p>;
    }
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route index element={<HomePage />} />
            <Route path="/join/:code" element={<JoinTarget />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText(/You are not in a club yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Join with a link' }));
    const input = await screen.findByLabelText('Invite link or code');
    fireEvent.change(input, { target: { value: 'https://books.example.org/join/AbCd1234?x=1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Joining AbCd1234')).toBeTruthy();
  });

  it('starting a club past the per-person cap (D176, 409 club_limit) offers a way forward and stops the form', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([]);
    vi.spyOn(api, 'createClub').mockRejectedValue(new ApiError(409, 'club_limit', 'You already own 5 clubs. Hand one to another member or delete one to start another.'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(keys.session, { user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null });
    renderHome(qc);
    await screen.findByText(/You are not in a club yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Start a club' }));
    fireEvent.change(await screen.findByLabelText('Club name'), { target: { value: 'One Too Many' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create club' }));
    expect(await screen.findByText(/You already own 5 clubs/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage your clubs' }).getAttribute('href')).toBe('/settings');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create club' }).disabled).toBe(true);
  });
});

describe('inviteCodeFrom', () => {
  it('takes the code alone from a pasted link, or the whole thing when it is already bare', () => {
    expect(inviteCodeFrom('https://books.example.org/join/AbCd1234')).toBe('AbCd1234');
    expect(inviteCodeFrom('  https://books.example.org/join/AbCd1234?x=1#y  ')).toBe('AbCd1234');
    expect(inviteCodeFrom('  AbCd1234  ')).toBe('AbCd1234');
    expect(inviteCodeFrom('')).toBe('');
  });
});

const ANA = { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source: 'local' as const };

function club(id: string, name: string, over: Partial<ClubSummary> = {}): ClubSummary {
  return { id, name, description: '', role: 'member', memberCount: 3, bookCount: 1, upNext: null, ...over };
}

function place(userId: string, over: Partial<MemberProgress> = {}): MemberProgress {
  const name = userId.replace('user_', '');
  return { userId, displayName: name.charAt(0).toUpperCase() + name.slice(1), color: '#4ECDC4', t: 0.3, furthest: 0.3, coverage: 0.3, kind: 'epub', label: 'Chapter 3 · 30%', updatedAt: '2026-10-20T09:00:00.000Z', finished: false, ...over };
}

function book(id: string, clubId: string, title: string, progress: MemberProgress[] = []): BookSummary {
  return { id, clubId, title, author: 'Someone', coverUrl: `/api/books/${id}/cover?v=1`, hasCover: true, kinds: ['epub'], createdAt: '2026-01-01T00:00:00.000Z', addedBy: 'user_ana', commentCount: 0, meeting: null, progress };
}

const reading = (userId: string, bookId: string, kind: 'epub' | 'pdf' | 'audio' = 'epub'): PresenceEntry => ({
  userId,
  displayName: userId.replace('user_', '').replace(/^./, (c) => c.toUpperCase()),
  color: '#4ECDC4',
  online: true,
  reading: { bookId, editionId: 'edition_1', kind, t: 0.3, label: 'Chapter 3 · 30%', at: 0 },
});

describe('a club on the home page says what it is reading', () => {
  const alice = book('book_alice', 'club_a', 'Alice', [place('user_ben', { updatedAt: '2026-10-22T09:00:00.000Z' }), place('user_cleo', { kind: 'audio', updatedAt: '2026-10-21T09:00:00.000Z' })]);
  const carol = book('book_carol', 'club_a', 'A Christmas Carol', [place('user_dee', { updatedAt: '2026-10-23T09:00:00.000Z' }), place('user_eli', { finished: true })]);

  it('who is in one of its books right now, in words for reading and for listening', () => {
    expect(clubNow([alice, carol], new Map([['user_ben', reading('user_ben', 'book_alice')]]), 'user_ana')).toEqual({ text: 'Ben is reading “Alice” now', live: true });
    expect(clubNow([alice], new Map([['user_cleo', reading('user_cleo', 'book_alice', 'audio')]]), 'user_ana')).toEqual({ text: 'Cleo is listening to “Alice” now', live: true });
    const both = new Map([
      ['user_ben', reading('user_ben', 'book_alice', 'pdf')],
      ['user_cleo', reading('user_cleo', 'book_alice', 'audio')],
    ]);
    expect(clubNow([alice], both, 'user_ana')?.text).toBe('Ben and Cleo are in “Alice” now');
    // The book most of them are in, when friends are in different ones.
    const three = new Map([...both, ['user_dee', reading('user_dee', 'book_carol')]]);
    expect(clubNow([carol, alice], three, 'user_ana')?.text).toBe('Ben and Cleo are in “Alice” now');
  });

  it('never you, nor a book of another club', () => {
    const elsewhere = new Map([
      ['user_ana', reading('user_ana', 'book_alice')],
      ['user_ben', reading('user_ben', 'book_of_another_club')],
    ]);
    expect(clubNow([alice], elsewhere, 'user_ana')).toEqual({ text: 'Ben and Cleo are in “Alice”', live: false });
  });

  it('else who is reading the book a friend read last, those who finished it aside', () => {
    expect(clubNow([alice, carol], new Map(), 'user_ana')).toEqual({ text: 'Dee is reading “A Christmas Carol”', live: false });
    expect(clubNow([alice], new Map(), 'user_ana')).toEqual({ text: 'Ben and Cleo are in “Alice”', live: false });
    const listeners = book('book_l', 'club_a', 'Gatsby', [place('user_ben', { kind: 'audio' }), place('user_cleo', { kind: 'audio' }), place('user_dee', { kind: 'audio' })]);
    expect(clubNow([listeners], new Map(), 'user_ana')?.text).toBe('Ben, Cleo and 1 other are listening to “Gatsby”');
  });

  it('nothing when no friend has begun one: not you alone, not those who finished', () => {
    const mine = book('book_m', 'club_a', 'Mine', [place('user_ana'), place('user_ben', { t: 0, updatedAt: null }), place('user_eli', { finished: true })]);
    expect(clubNow([mine], new Map(), 'user_ana')).toBeNull();
    expect(clubNow([], new Map(), 'user_ana')).toBeNull();
  });
});

describe('the home page with several clubs', () => {
  function signedIn(): QueryClient {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(keys.session, { user: ANA, setupRequired: false, upstream: null });
    return qc;
  }

  it('puts the book you read or heard last first, whichever club it is in, then each club with its books and who is reading', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([club('club_a', 'Thursday Readers', { bookCount: 5, role: 'owner' }), club('club_b', 'Poetry Club')]);
    const thursday = [
      book('book_alice', 'club_a', 'Alice', [place('user_ana', { updatedAt: '2026-10-20T09:00:00.000Z' }), place('user_ben')]),
      ...['One', 'Two', 'Three', 'Four'].map((t, i) => ({ ...book(`book_${i}`, 'club_a', t), createdAt: `2026-0${i + 2}-01T00:00:00.000Z` })),
    ];
    const poetry = [book('book_carol', 'club_b', 'A Christmas Carol', [place('user_ana', { kind: 'audio', label: 'Stave 2 · 30%', updatedAt: '2026-10-23T21:00:00.000Z' })])];
    vi.spyOn(api, 'books').mockImplementation((clubId: string) => Promise.resolve(clubId === 'club_a' ? thursday : poetry));
    renderHome(signedIn());
    const banner = await screen.findByTestId('continue-banner');
    expect(banner.getAttribute('href')).toBe('/books/book_carol/read?along=1');
    expect(banner.textContent).toBe('A Christmas CarolPoetry Club · Stave 2 · 30%Continue');
    expect(screen.getByRole('heading', { level: 1, name: 'Your clubs' })).toBeTruthy();
    const [first, second] = screen.getAllByTestId('club-card');
    expect(within(first!).getByRole('link', { name: /^Thursday Readers/ }).getAttribute('href')).toBe('/clubs/club_a');
    expect(first!.textContent).toContain('3 readers · 5 books · you run it');
    // Its books, yours first, as many as fit; the rest are in the club's library.
    const shelf = within(first!).getByRole('list', { name: 'Books in Thursday Readers' });
    expect(within(shelf).getAllByTestId('shelf-book').map((a) => a.getAttribute('href'))).toEqual(['/books/book_alice', '/books/book_3', '/books/book_2', '/books/book_1']);
    expect(within(shelf).getByRole('img', { name: 'Alice' })).toBeTruthy();
    expect(within(shelf).getByRole('link', { name: '1 more book in Thursday Readers' }).getAttribute('href')).toBe('/clubs/club_a');
    expect(within(first!).getByTestId('club-now').textContent).toBe('Ben is reading “Alice”');
    // Only you have begun the Carol: nothing to say about friends there.
    expect(within(second!).queryByTestId('club-now')).toBeNull();
    expect(within(second!).getAllByTestId('shelf-book')).toHaveLength(1);
  });

  it('with nothing begun has no banner, and a club whose books could not be had shows without them', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([club('club_a', 'Thursday Readers'), club('club_b', 'Poetry Club')]);
    vi.spyOn(api, 'books').mockImplementation((clubId: string) => (clubId === 'club_a' ? Promise.resolve([book('book_alice', 'club_a', 'Alice')]) : Promise.reject(new ApiError(500, 'internal', 'Something went wrong.'))));
    renderHome(signedIn());
    expect(await screen.findAllByTestId('club-card')).toHaveLength(2);
    expect(screen.queryByTestId('continue-banner')).toBeNull();
    const [first, second] = screen.getAllByTestId('club-card');
    expect(within(first!).getAllByTestId('shelf-book')).toHaveLength(1);
    expect(within(second!).queryByRole('list')).toBeNull();
    expect(within(second!).getByRole('link', { name: /^Poetry Club/ })).toBeTruthy();
  });

  it('with one club goes straight into it, as before', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([club('club_a', 'Thursday Readers')]);
    const books = vi.spyOn(api, 'books');
    render(
      <QueryClientProvider client={signedIn()}>
        <MemoryRouter>
          <Routes>
            <Route index element={<HomePage />} />
            <Route path="/clubs/:clubId" element={<p>The library</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('The library')).toBeTruthy();
    expect(books).not.toHaveBeenCalled();
  });
});
