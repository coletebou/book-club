import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PARTY_SETTINGS, type PartyState } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { applyPartyState, clearParty, keys } from '../lib/queries';
import { ToastProvider } from '../components/Toasts';
import { PartyBar } from './PartyBar';

const local = vi.hoisted(() => ({ toggle: vi.fn(), element: null, state: { edition: { id: 'other-edition' } } }));
vi.mock('../player/AudioProvider', () => ({ useAudio: () => local }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const self = { userId: 'self', displayName: 'Self', color: '#abc', joinedAt: 0 };
const friend = { userId: 'friend', displayName: 'Friend', color: '#def', joinedAt: 0 };
const p: PartyState = { bookId: 'book', clubId: 'club', editionId: 'edition', hostId: 'self', track: 0, position: 0, playing: false, rate: 1, updatedAt: Date.now(), members: [self], settings: DEFAULT_PARTY_SETTINGS, paused: null };
const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';

function mount(current: PartyState | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(keys.session, { user: { id: 'self' } });
  qc.setQueryData(keys.party('book'), current);
  qc.setQueryData(keys.book('book'), { editions: [], chapters: [] });
  qc.setQueryData(keys.progress('book'), {});
  vi.spyOn(api, 'party').mockResolvedValue(current);
  render(<QueryClientProvider client={qc}><ToastProvider><PartyBar bookId="book" clubId="club" editionId="edition" /></ToastProvider></QueryClientProvider>);
  return qc;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('party bar explicit book binding', () => {
  it('controls its own party even when another edition/player is loaded', async () => {
    const qc = mount(p);
    const control = vi.spyOn(api, 'partyControl').mockResolvedValue({ ...p, playing: true });
    fireEvent.click(screen.getByTestId('party-toggle'));
    await waitFor(() => expect(control).toHaveBeenCalledWith('book', { action: 'play' }));
    expect(local.toggle).not.toHaveBeenCalled();
    qc.clear();
  });
});

describe('party bar join/start responses are fenced by hub events', () => {
  it('a delayed start response does not resurrect a party the hub has since ended', async () => {
    const qc = mount(null);
    const started = deferred<PartyState>();
    vi.spyOn(api, 'startParty').mockReturnValue(started.promise);
    fireEvent.click(screen.getByTestId('party-start'));
    const first = { ...p, partyId: P1, revision: 1 };
    act(() => { applyPartyState(qc, 'book', first); clearParty(qc, 'book'); });
    await act(async () => { started.resolve(first); await started.promise; });
    expect(qc.getQueryData(keys.party('book'))).toBeNull();
    qc.clear();
  });

  it('a delayed start response does not replace a newer party incarnation', async () => {
    const qc = mount(null);
    const started = deferred<PartyState>();
    vi.spyOn(api, 'startParty').mockReturnValue(started.promise);
    fireEvent.click(screen.getByTestId('party-start'));
    const replacement = { ...p, partyId: P2, revision: 1, hostId: 'friend', members: [friend] };
    act(() => applyPartyState(qc, 'book', replacement));
    await act(async () => { started.resolve({ ...p, partyId: P1, revision: 4 }); await started.promise; });
    expect(qc.getQueryData(keys.party('book'))).toEqual(replacement);
    qc.clear();
  });

  it('a delayed join response does not resurrect an ended party or replace a newer one', async () => {
    const running = { ...p, partyId: P1, revision: 1, hostId: 'friend', members: [friend] };
    const qc = mount(running);
    const joined = deferred<PartyState>();
    vi.spyOn(api, 'joinParty').mockReturnValue(joined.promise);
    fireEvent.click(screen.getByTestId('party-join'));
    act(() => clearParty(qc, 'book'));
    await act(async () => { joined.resolve({ ...running, revision: 2, members: [friend, self] }); await joined.promise; });
    expect(qc.getQueryData(keys.party('book'))).toBeNull();
    qc.clear();
    cleanup();

    const qc2 = mount(running);
    const again = deferred<PartyState>();
    vi.mocked(api.joinParty).mockReturnValue(again.promise);
    fireEvent.click(screen.getByTestId('party-join'));
    const replacement = { ...p, partyId: P2, revision: 1, hostId: 'friend', members: [friend] };
    act(() => { clearParty(qc2, 'book'); applyPartyState(qc2, 'book', replacement); });
    await act(async () => { again.resolve({ ...running, revision: 2, members: [friend, self] }); await again.promise; });
    expect(qc2.getQueryData(keys.party('book'))).toEqual(replacement);
    qc2.clear();
  });

  it('still applies an undisturbed response, and the newest revision of the same party', async () => {
    const qc = mount(null);
    const first = { ...p, partyId: P1, revision: 1 };
    vi.spyOn(api, 'startParty').mockResolvedValue(first);
    fireEvent.click(screen.getByTestId('party-start'));
    await waitFor(() => expect(qc.getQueryData(keys.party('book'))).toEqual(first));
    qc.clear();
    cleanup();

    const running = { ...p, partyId: P1, revision: 1, hostId: 'friend', members: [friend] };
    const qc2 = mount(running);
    const joined = deferred<PartyState>();
    vi.spyOn(api, 'joinParty').mockReturnValue(joined.promise);
    fireEvent.click(screen.getByTestId('party-join'));
    const newer = { ...running, revision: 3, members: [friend, self], playing: true };
    act(() => applyPartyState(qc2, 'book', newer)); // The hub's own broadcast of this join, and more.
    await act(async () => { joined.resolve({ ...running, revision: 2, members: [friend, self] }); await joined.promise; });
    expect(qc2.getQueryData(keys.party('book'))).toEqual(newer);
    qc2.clear();
  });
});
