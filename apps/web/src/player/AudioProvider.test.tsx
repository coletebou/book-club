import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type BookDetail, type Edition, type PartyState, DEFAULT_PARTY_SETTINGS } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { applyPartyState, keys, partyQueryOptions } from '../lib/queries';
import { useClubPresence } from '../lib/realtime';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { PlayPauseButton } from './PlayPauseButton';
import { MiniPlayer } from './MiniPlayer';
import { AudioProvider, useAudio, useAudioState } from './AudioProvider';
import { usePauseAudiobookWhile } from './pauseWhile';
import { rememberedBookRate } from './speed-memory';
import { rememberPosition, saveProgress, saveProgressNow } from '../lib/outbox';

vi.mock('../lib/outbox', () => ({ saveProgress: vi.fn().mockResolvedValue(undefined), saveProgressNow: vi.fn(), rememberPosition: vi.fn().mockResolvedValue(undefined), currentUser: () => 'self', flushOutbox: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/realtime', () => ({ realtime: () => null, useClubPresence: vi.fn() }));

const edition = { id: 'edition', kind: 'audio', tracks: [{ index: 0, title: 'Track 1', url: '/track/0', durationMs: 100_000, chapter: null }], units: [], alignment: { unitToChapter: [] }, geometry: null, sync: null } as unknown as Edition;
const book = { id: 'book', title: 'Test', author: 'Author', coverUrl: '/cover?x=1', chapters: [], editions: [edition] } as unknown as BookDetail;
const party: PartyState = { bookId: 'book', clubId: 'club', editionId: 'edition', hostId: 'self', track: 0, position: 0, playing: false, rate: 1, updatedAt: Date.now(), members: [{ userId: 'self', displayName: 'Self', color: '#abc', joinedAt: 0 }], settings: DEFAULT_PARTY_SETTINGS, paused: null };

/** A voice note (resumes a solo player after) and Cal speaking (never resumes a solo player). */
function Interruptions() {
  const [note, setNote] = useState(false);
  const [cal, setCal] = useState(false);
  usePauseAudiobookWhile(note);
  usePauseAudiobookWhile(cal, { resumeAlone: false });
  return <>
    <button onClick={() => setNote((v) => !v)}>Voice note</button>
    <button onClick={() => setCal((v) => !v)}>Cal speaking</button>
  </>;
}

function Probe() {
  const audio = useAudio();
  const state = useAudioState();
  return <>
    <Interruptions />
    <button onClick={() => audio.load(book, edition, null)}>Load</button>
    <button onClick={() => audio.load({ ...book, id: 'book2' }, { ...edition, id: 'edition2' }, null, { rate: 1.35 })}>Load at 1.35</button>
    <button onClick={() => audio.setRate(2.5)}>Rate 2.5</button>
    <button onClick={() => audio.local.setRate(1.545, { temporary: true, nudge: true })}>Nudge</button>
    <button onClick={() => audio.local.setRate(1.25, { fromDefault: true })}>Default arrived</button>
    <output data-testid="speed">{state.speed}</output>
    <PlayPauseButton loaded={!!state.edition} />
    <output data-testid="local-playing">{String(state.playing)}</output>
    <button onClick={() => audio.setRate(1.5)}>Rate</button>
    <button onClick={() => audio.pause()}>Pause</button>
    <button onClick={() => audio.seek(20)}>Seek 20</button>
    <button onClick={() => audio.seek(40)}>Seek 40</button>
    <button onClick={() => audio.local.setRate(1.05, { temporary: true })}>Correction</button>
    <output data-testid="error">{state.error}</output>
  </>;
}

let qc: QueryClient;
let commands: { type: string }[];
function mount(current: PartyState | null = party, minis = false) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(keys.session, { user: { id: 'self' } });
  qc.setQueryData(keys.party('book'), current);
  commands = [];
  window.BookClubNative = { postMessage: (json) => { commands.push(JSON.parse(json) as { type: string }); } };
  vi.spyOn(api, 'party').mockResolvedValue(current);
  vi.spyOn(api, 'partyDiagnostics').mockResolvedValue(undefined);
  vi.spyOn(api, 'setBookPlayback').mockImplementation(async (_bookId, body) => body);
  render(<MemoryRouter><QueryClientProvider client={qc}><AudioProvider><Probe />{minis && <><MiniPlayer /><MiniPlayer footer /></>}</AudioProvider></QueryClientProvider></MemoryRouter>);
  fireEvent.click(screen.getByText('Load'));
}

function status(paused = true) {
  act(() => window.__bookClubReceive?.(JSON.stringify({ type: 'status', event: 'loadedmetadata', currentTime: 0, duration: 100, paused, ended: false, playbackRate: 1, readyState: 2 })));
}

/** Native reports a play/pause transition (the bridge's element only changes `paused` then). */
function nativeEvent(event: 'play' | 'pause', currentTime = 0) {
  act(() => window.__bookClubReceive?.(JSON.stringify({ type: 'status', event, currentTime, duration: 100, paused: event === 'pause', ended: false, playbackRate: 1, readyState: 2 })));
}

const sent = (control: { mock: { calls: unknown[][] } }) => control.mock.calls.map((call) => (call[1] as { action: string }).action);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('MediaMetadata', class {
    readonly title: string;
    readonly artist: string;
    readonly album: string;
    readonly artwork: MediaImage[];
    constructor(init: MediaMetadataInit) {
      this.title = init.title ?? ''; this.artist = init.artist ?? ''; this.album = init.album ?? ''; this.artwork = init.artwork ?? [];
    }
  });
});
afterEach(() => {
  cleanup();
  qc?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.BookClubNative;
  delete window.__bookClubReceive;
  Reflect.deleteProperty(navigator, 'mediaSession');
});

describe('AudioProvider party transport integration', () => {
  it('the main toggle controls everyone and applies the response without waiting a sync interval', async () => {
    mount();
    status();
    const control = vi.spyOn(api, 'partyControl').mockResolvedValue({ ...party, playing: true, updatedAt: Date.now() });
    commands.length = 0;
    fireEvent.click(screen.getByTestId('play-pause'));
    expect(control).toHaveBeenCalledWith('book', { action: 'play' });
    await waitFor(() => expect(commands.some((c) => c.type === 'play')).toBe(true));
    expect(qc.getQueryData<PartyState>(keys.party('book'))?.playing).toBe(true);
    expect(control).toHaveBeenCalledTimes(1); // Reconciliation never recurses into party/control.
  });

  it('blocks host-only participants and reports control failure without local fallback', async () => {
    mount({ ...party, hostId: 'other', settings: { ...DEFAULT_PARTY_SETTINGS, hostOnlyControls: true } });
    status();
    const control = vi.spyOn(api, 'partyControl').mockRejectedValue(new Error('private raw URL must not be surfaced'));
    commands.length = 0;
    fireEvent.click(screen.getByTestId('play-pause'));
    expect(control).not.toHaveBeenCalled();
    expect(screen.getByTestId('error').textContent).toBe('Only the host controls this party.');
    expect(commands.some((c) => c.type === 'play')).toBe(false);
    act(() => applyPartyState(qc, 'book', party));
    await waitFor(() => expect(qc.getQueryData<PartyState>(keys.party('book'))?.hostId).toBe('self'));
    fireEvent.click(screen.getByTestId('play-pause'));
    await waitFor(() => expect(screen.getByTestId('error').textContent).toContain('Check your connection'));
    expect(screen.getByTestId('error').textContent).not.toContain('private');
  });

  it('local playback stays local outside participation and only user rates persist', () => {
    mount(null);
    status();
    const control = vi.spyOn(api, 'partyControl');
    fireEvent.click(screen.getByTestId('play-pause'));
    expect(commands.some((c) => c.type === 'play')).toBe(true);
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Rate'));
    // Kept as this book's speed (D195): on this device at once, and sent to the server.
    expect(rememberedBookRate('self', 'book')?.rate).toBe(1.5);
    expect(api.setBookPlayback).toHaveBeenCalledWith('book', { rate: 1.5, at: expect.any(Number) as number });
    fireEvent.click(screen.getByText('Correction'));
    expect(rememberedBookRate('self', 'book')?.rate).toBe(1.5);
    expect(api.setBookPlayback).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow control response overwrite a newer hub state', () => {
    mount();
    const newer = { ...party, position: 60, updatedAt: party.updatedAt + 100 };
    act(() => {
      applyPartyState(qc, 'book', newer);
      applyPartyState(qc, 'book', { ...party, playing: true });
    });
    expect(qc.getQueryData<PartyState>(keys.party('book'))).toEqual(newer);
  });
  it('coalesces trailing intent: a pause supersedes an in-flight play and the final scrub wins', async () => {
    mount(); status();
    let resolve!: (p: PartyState) => void;
    const control = vi.spyOn(api, 'partyControl').mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockResolvedValue(party);
    fireEvent.click(screen.getByTestId('play-pause'));
    fireEvent.click(screen.getByText('Pause'));
    expect(control).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ...party, playing: true, updatedAt: Date.now() }); await Promise.resolve(); });
    await waitFor(() => expect(control).toHaveBeenCalledWith('book', { action: 'pause' }));
    control.mockClear();
    control.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    fireEvent.click(screen.getByText('Seek 20'));
    fireEvent.click(screen.getByText('Seek 40'));
    await act(async () => { resolve({ ...party, position: 20, updatedAt: Date.now() }); await Promise.resolve(); });
    await waitFor(() => expect(control).toHaveBeenCalledWith('book', { action: 'seek', track: 0, position: 40 }));
  });

  it('does not revive an old party incarnation with a late control response', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const old = { ...party, partyId: id, revision: 1 };
    mount(old); status();
    let resolve!: (p: PartyState) => void;
    vi.spyOn(api, 'partyControl').mockImplementation(() => new Promise((r) => { resolve = r; }));
    fireEvent.click(screen.getByTestId('play-pause'));
    const next = { ...party, partyId: '00000000-0000-4000-8000-000000000002', revision: 1 };
    await act(async () => { applyPartyState(qc, 'book', next); await new Promise((r) => setTimeout(r, 10)); });
    await act(async () => { resolve({ ...old, playing: true, revision: 2 }); await Promise.resolve(); });
    expect(qc.getQueryData<PartyState>(keys.party('book'))).toEqual(next);
  });

  it('rejects stale settings/membership responses even with identical projection timestamps', () => {
    mount();
    const newer = { ...party, revision: 3, settings: { ...party.settings, hostOnlyControls: true }, members: [] };
    act(() => {
      applyPartyState(qc, 'book', newer);
      applyPartyState(qc, 'book', { ...party, revision: 2 });
    });
    expect(qc.getQueryData<PartyState>(keys.party('book'))).toEqual(newer);
  });

  it('keeps the active party club subscribed without a page subscriber', () => {
    mount();
    expect(useClubPresence).toHaveBeenCalledWith('club');
  });

  it('preserves newer hub state and party-ended null during a delayed GET', async () => {
    mount({ ...party, revision: 1 });
    let resolve!: (p: PartyState | null) => void;
    vi.mocked(api.party).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const pending = qc.fetchQuery({ ...partyQueryOptions(qc, 'book'), staleTime: 0 });
    const newer = { ...party, playing: false, revision: 3 };
    act(() => applyPartyState(qc, 'book', newer));
    resolve({ ...party, playing: true, revision: 2 });
    await pending;
    expect(qc.getQueryData<PartyState>(keys.party('book'))).toEqual(newer);
    const next = qc.fetchQuery({ ...partyQueryOptions(qc, 'book'), staleTime: 0 });
    act(() => { qc.setQueryData(keys.party('book'), null); });
    resolve({ ...party, playing: true, revision: 2 });
    await next;
    expect(qc.getQueryData(keys.party('book'))).toBeNull();
  });

  it('attempts a queued Pause after an uncertain timed-out play, once', async () => {
    mount(); status();
    let reject!: (e: Error) => void;
    const control = vi.spyOn(api, 'partyControl').mockImplementationOnce(() => new Promise((_r, r) => { reject = r; })).mockResolvedValue(party);
    fireEvent.click(screen.getByTestId('play-pause'));
    fireEvent.click(screen.getByText('Pause'));
    await act(async () => { reject(new ApiError(0, 'offline', 'timeout')); await Promise.resolve(); });
    await waitFor(() => expect(control).toHaveBeenCalledWith('book', { action: 'pause' }));
    expect(control).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a hub-ended party even before React renders the end event', async () => {
    mount(); status();
    let resolve!: (p: PartyState) => void;
    vi.spyOn(api, 'partyControl').mockImplementation(() => new Promise((r) => { resolve = r; }));
    fireEvent.click(screen.getByTestId('play-pause'));
    await act(async () => {
      qc.setQueryData(keys.party('book'), null);
      resolve({ ...party, playing: true, updatedAt: Date.now() });
      await Promise.resolve();
    });
    expect(qc.getQueryData(keys.party('book'))).toBeNull();
  });

  it('the main toggle flips the latest intended state while a Play is still outstanding', async () => {
    mount(); status();
    let resolve!: (p: PartyState) => void;
    const control = vi.spyOn(api, 'partyControl')
      .mockImplementationOnce(() => new Promise((r) => { resolve = r; }))
      .mockImplementation(async (_book, body) => ({ ...party, playing: body.action === 'play', updatedAt: Date.now() }));
    fireEvent.click(screen.getByTestId('play-pause'));
    fireEvent.click(screen.getByTestId('play-pause')); // Play is unacknowledged: this means Pause.
    await act(async () => { resolve({ ...party, playing: true, updatedAt: Date.now() }); await Promise.resolve(); });
    await waitFor(() => expect(control).toHaveBeenCalledTimes(2));
    expect(sent(control)).toEqual(['play', 'pause']);
    await waitFor(() => expect(qc.getQueryData<PartyState>(keys.party('book'))?.playing).toBe(false));

    // Three presses during one outstanding Play end on Play: the queued Pause is cancelled, not chased.
    control.mockClear();
    control.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId('play-pause'));
    await act(async () => { resolve({ ...party, playing: true, updatedAt: Date.now() }); await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(sent(control)).toEqual(['play']);

    // Four presses during one outstanding Pause end on Play again (one trailing command).
    control.mockClear();
    control.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByTestId('play-pause'));
    await act(async () => { resolve({ ...party, playing: false, updatedAt: Date.now() }); await Promise.resolve(); });
    await waitFor(() => expect(control).toHaveBeenCalledTimes(2));
    expect(sent(control)).toEqual(['pause', 'play']);
  });

  it('keeps a queued pause and a queued scrub, rather than letting one discard the other', async () => {
    mount(); status();
    let resolve!: (p: PartyState) => void;
    const control = vi.spyOn(api, 'partyControl').mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockResolvedValue(party);
    fireEvent.click(screen.getByTestId('play-pause'));
    fireEvent.click(screen.getByText('Pause'));
    fireEvent.click(screen.getByText('Seek 40'));
    await act(async () => { resolve({ ...party, playing: true, updatedAt: Date.now() }); await Promise.resolve(); });
    await waitFor(() => expect(control).toHaveBeenCalledTimes(3));
    expect(control.mock.calls.map(([, body]) => body)).toEqual([{ action: 'play' }, { action: 'pause' }, { action: 'seek', track: 0, position: 40 }]);
  });

  it('a voice note holds party audio locally: no shared Pause, no sync restart, then resyncs on release', async () => {
    const playing = { ...party, playing: true, updatedAt: Date.now() };
    mount(playing); status(false);
    const control = vi.spyOn(api, 'partyControl');
    commands.length = 0;
    fireEvent.click(screen.getByText('Voice note'));
    expect(commands.some((c) => c.type === 'pause')).toBe(true);
    nativeEvent('pause', 1);
    commands.length = 0;
    // The shared clock moves on (someone scrubbed) while the note plays: sync must not restart audio.
    act(() => applyPartyState(qc, 'book', { ...playing, position: 30, updatedAt: Date.now() }));
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); }); // A full sync interval too.
    expect(commands.filter((c) => c.type === 'play' || c.type === 'seek')).toEqual([]);
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Voice note'));
    const seek = commands.find((c): c is { type: 'seek'; time: number } => c.type === 'seek');
    expect(seek?.time).toBeGreaterThanOrEqual(30);
    expect(seek!.time).toBeLessThan(33);
    expect(commands.some((c) => c.type === 'play')).toBe(true);
    expect(control).not.toHaveBeenCalled();
  });

  it('main, mini and footer buttons show shared Pause during a private hold and keep queued intent accessible', async () => {
    mount({ ...party, playing: true }, true); status(false);
    fireEvent.click(screen.getByText('Voice note'));
    nativeEvent('pause');
    expect(screen.getByTestId('local-playing').textContent).toBe('false');
    const main = screen.getByTestId('play-pause');
    const [mini, footer] = screen.getAllByTestId('mini-player');
    const miniButton = within(mini!).getByRole('button', { name: 'Pause' });
    const footerButton = within(footer!).getByRole('button', { name: 'Pause the audiobook' });
    expect(main.getAttribute('aria-label')).toBe('Pause');
    expect(main.getAttribute('data-playing')).toBe('true');
    const pauseIcon = main.querySelector('path')?.getAttribute('d');
    let resolve!: (p: PartyState) => void;
    const control = vi.spyOn(api, 'partyControl').mockImplementationOnce(() => new Promise((r) => { resolve = r; }))
      .mockImplementation(async (_book, body) => ({ ...party, playing: body.action === 'play', updatedAt: Date.now() }));
    commands.length = 0;
    fireEvent.click(main);
    expect(control).toHaveBeenCalledWith('book', { action: 'pause' });
    expect(main.getAttribute('aria-label')).toBe('Play');
    expect(main.getAttribute('data-playing')).toBe('false');
    expect(main.querySelector('path')?.getAttribute('d')).not.toBe(pauseIcon);
    expect(miniButton.getAttribute('aria-label')).toBe('Play');
    expect(footerButton.getAttribute('aria-label')).toBe('Play the audiobook');
    fireEvent.click(miniButton); // Outstanding Pause: the next displayed action really is Play.
    expect(main.getAttribute('aria-label')).toBe('Pause');
    expect(footerButton.getAttribute('aria-label')).toBe('Pause the audiobook');
    await act(async () => { resolve({ ...party, playing: false, updatedAt: Date.now() }); });
    await waitFor(() => expect(sent(control)).toEqual(['pause', 'play']));
    expect(commands.some((c) => c.type === 'play')).toBe(false); // Shared Play never releases the private hold.
    expect(screen.getByTestId('local-playing').textContent).toBe('false');
    fireEvent.click(screen.getByText('Voice note'));
    expect(commands.some((c) => c.type === 'play')).toBe(true);
  });

  it('reverts the button to acknowledged state when a shared command is refused', async () => {
    mount(); status();
    let reject!: (e: Error) => void;
    vi.spyOn(api, 'partyControl').mockImplementationOnce(() => new Promise((_r, r) => { reject = r; }));
    const button = screen.getByTestId('play-pause');
    fireEvent.click(button);
    expect(button.getAttribute('aria-label')).toBe('Pause');
    await act(async () => { reject(new ApiError(403, 'forbidden', 'refused')); });
    expect(button.getAttribute('aria-label')).toBe('Play');
    expect(button.getAttribute('data-playing')).toBe('false');
  });

  it('a late native Play cannot defeat a private hold or issue a shared command', () => {
    mount({ ...party, playing: true }); status(false);
    const control = vi.spyOn(api, 'partyControl');
    fireEvent.click(screen.getByText('Voice note'));
    nativeEvent('pause');
    commands.length = 0;
    nativeEvent('play'); // A play already posted to AVPlayer arrives after the hold's pause.
    expect(commands.some((c) => c.type === 'pause')).toBe(true);
    expect(screen.getByTestId('local-playing').textContent).toBe('false');
    expect(control).not.toHaveBeenCalled();
  });

  it('releasing a hold after leaving a playing party does not start solo playback', async () => {
    mount({ ...party, playing: true }); status(false);
    fireEvent.click(screen.getByText('Voice note'));
    nativeEvent('pause');
    await act(async () => { applyPartyState(qc, 'book', { ...party, members: [] }); });
    await waitFor(() => expect(screen.getByTestId('play-pause').getAttribute('aria-label')).toBe('Play'));
    commands.length = 0;
    fireEvent.click(screen.getByText('Voice note'));
    expect(commands.some((c) => c.type === 'play')).toBe(false);
  });

  it('Cal speaking holds party audio until he stops, even when the party was paused at the start', async () => {
    mount(); status(true);
    commands.length = 0;
    fireEvent.click(screen.getByText('Cal speaking'));
    await act(async () => { applyPartyState(qc, 'book', { ...party, playing: true, updatedAt: Date.now() }); await new Promise((r) => setTimeout(r, 20)); });
    expect(commands.some((c) => c.type === 'play')).toBe(false);
    fireEvent.click(screen.getByText('Cal speaking'));
    expect(commands.some((c) => c.type === 'play')).toBe(true);
  });

  it('outside a party a voice note resumes only what it paused, and Cal never resumes', () => {
    mount(null); status(false);
    commands.length = 0;
    fireEvent.click(screen.getByText('Voice note'));
    expect(commands.some((c) => c.type === 'pause')).toBe(true);
    nativeEvent('pause');
    fireEvent.click(screen.getByText('Voice note'));
    expect(commands.some((c) => c.type === 'play')).toBe(true);
    nativeEvent('play');
    commands.length = 0;
    fireEvent.click(screen.getByText('Cal speaking'));
    nativeEvent('pause');
    fireEvent.click(screen.getByText('Cal speaking'));
    expect(commands.some((c) => c.type === 'play')).toBe(false);
    fireEvent.click(screen.getByText('Voice note')); // Paused already: nothing for this note to resume.
    fireEvent.click(screen.getByText('Voice note'));
    expect(commands.some((c) => c.type === 'play')).toBe(false);
  });

  it('persists the speed a user chose once their command succeeds, even if a newer state wins the cache', async () => {
    mount({ ...party, revision: 1 }); status();
    let resolve!: (p: PartyState) => void;
    vi.spyOn(api, 'partyControl').mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    fireEvent.click(screen.getByText('Rate'));
    const newer = { ...party, revision: 3, position: 12 };
    act(() => applyPartyState(qc, 'book', newer));
    await act(async () => { resolve({ ...party, revision: 2, rate: 1.5 }); await Promise.resolve(); });
    expect(qc.getQueryData<PartyState>(keys.party('book'))).toEqual(newer);
    expect(rememberedBookRate('self', 'book')?.rate).toBe(1.5);
    fireEvent.click(screen.getByText('Correction'));
    expect(rememberedBookRate('self', 'book')?.rate).toBe(1.5);
  });

  it('a delayed GET keeps its newer same-party revision, but never an ended or replaced party', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    mount({ ...party, partyId: id, revision: 1 });
    let resolve!: (p: PartyState | null) => void;
    vi.mocked(api.party).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const pending = qc.fetchQuery({ ...partyQueryOptions(qc, 'book'), staleTime: 0 });
    act(() => applyPartyState(qc, 'book', { ...party, partyId: id, revision: 2 }));
    const newest = { ...party, partyId: id, revision: 3, playing: true };
    resolve(newest);
    await pending;
    expect(qc.getQueryData<PartyState>(keys.party('book'))).toEqual(newest);

    const replacement = { ...party, partyId: '00000000-0000-4000-8000-000000000002', revision: 1 };
    const next = qc.fetchQuery({ ...partyQueryOptions(qc, 'book'), staleTime: 0 });
    act(() => applyPartyState(qc, 'book', replacement));
    resolve({ ...newest, revision: 9 });
    await next;
    expect(qc.getQueryData<PartyState>(keys.party('book'))).toEqual(replacement);
  });

});

describe('AudioProvider listening speed (D195)', () => {
  const rates = () => commands.filter((c): c is { type: 'setRate'; rate: number } => c.type === 'setRate').map((c) => c.rate);

  it('a book opens at the speed it is given, before its first track plays', () => {
    mount(null);
    commands.length = 0;
    fireEvent.click(screen.getByText('Load at 1.35'));
    status();
    expect(rates().at(-1)).toBe(1.35);
    expect(screen.getByTestId('speed').textContent).toBe('1.35');
  });

  it('an iOS build that says nothing of its speeds is never asked past 2×, and still shows the speed chosen', () => {
    mount(null);
    status();
    commands.length = 0;
    fireEvent.click(screen.getByText('Rate 2.5'));
    expect(rates()).toEqual([2]);
    expect(screen.getByTestId('speed').textContent).toBe('2.5');
    expect(rememberedBookRate('self', 'book')?.rate).toBe(2.5);
  });

  it('a build that plays to 3× is given 2.5× as chosen', () => {
    mount(null);
    window.BookClubNative = { ...window.BookClubNative!, maxRate: 3 };
    status();
    commands.length = 0;
    fireEvent.click(screen.getByText('Rate 2.5'));
    expect(rates()).toEqual([2.5]);
  });

  it('a party nudge plays but is never shown or kept as anyone\'s speed', () => {
    mount(null);
    status();
    fireEvent.click(screen.getByText('Rate'));
    commands.length = 0;
    fireEvent.click(screen.getByText('Nudge'));
    expect(rates()).toEqual([1.545]);
    expect(screen.getByTestId('speed').textContent).toBe('1.5');
    expect(rememberedBookRate('self', 'book')?.rate).toBe(1.5);
    expect(api.setBookPlayback).toHaveBeenCalledTimes(1);
  });

  it('a default heard after the book opened plays, but is not kept as the book\'s own speed', () => {
    mount(null);
    status();
    commands.length = 0;
    fireEvent.click(screen.getByText('Default arrived'));
    expect(rates()).toEqual([1.25]);
    expect(screen.getByTestId('speed').textContent).toBe('1.25');
    expect(rememberedBookRate('self', 'book')).toBeNull();
    expect(api.setBookPlayback).not.toHaveBeenCalled();
  });
});


describe('the lock screen and the iOS app’s own queue (D190, D181)', () => {
  const three = { ...edition, id: 'three', tracks: [0, 1, 2].map((i) => ({ index: i, title: `Track ${i + 1}`, url: `/track/${i}`, durationMs: 100_000, chapter: i })), units: [0, 1, 2].map((i) => ({ title: `Track ${i + 1}`, m: i * 100_000 })) } as unknown as Edition;
  const threeBook = { ...book, chapters: ['One', 'Two', 'Three'].map((title, index) => ({ index, title, t: index / 3 })), editions: [three] };

  function Lock() {
    const audio = useAudio();
    const state = useAudioState();
    return <>
      <button onClick={() => audio.load(threeBook, three, null)}>Load three</button>
      <button onClick={() => audio.setSleep('track')}>Sleep at track end</button>
      <button onClick={() => audio.setSleep(30)}>Sleep 30</button>
      <button onClick={() => audio.seek(60)}>Scrub to 1:00</button>
      <output data-testid="track">{state.track}</output>
    </>;
  }

  function mountLock() {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(keys.session, { user: { id: 'self' } });
    qc.setQueryData(keys.party('book'), null);
    commands = [];
    window.BookClubNative = { postMessage: (json) => { commands.push(JSON.parse(json) as { type: string }); } };
    vi.spyOn(api, 'party').mockResolvedValue(null);
    render(<MemoryRouter><QueryClientProvider client={qc}><AudioProvider><Lock /></AudioProvider></QueryClientProvider></MemoryRouter>);
    fireEvent.click(screen.getByText('Load three'));
  }
  const receive = (msg: object) => act(() => window.__bookClubReceive?.(JSON.stringify(msg)));
  const nativeStatus = (event: string, over: object = {}) => receive({ type: 'status', event, currentTime: 0, duration: 100, paused: true, ended: false, playbackRate: 1, readyState: 2, ...over });
  const remote = (action: string, extra: object = {}) => receive({ type: 'remote-action', action, ...extra });
  /** Native's answer to the page's last seek, as NativeAudioEngine sends it once AVPlayer has seeked (D196). */
  const nativeSeeked = () => receive({ type: 'diagnostic', diagnostic: { event: 'native-seek', outcome: 'ok', durationMs: 5 } });
  const of = <T = Record<string, unknown>>(type: string) => commands.filter((c) => c.type === type) as unknown as T[];

  it('names the chapter, the author and the book, with the square artwork largest first', () => {
    mountLock();
    const meta = of<{ title: string; artist: string; album: string; artwork: string[] }>('metadata').at(-1)!;
    expect([meta.title, meta.artist, meta.album]).toEqual(['One', 'Author', 'Test']);
    expect(meta.artwork[0]).toContain('shape=square');
    expect(meta.artwork[0]).toContain('w=512');
  });

  it('tells the scrubber the exact place on each event that moves it, a speed change too', () => {
    mountLock();
    nativeStatus('loadedmetadata');
    nativeSeeked(); // the track's start, which the page seeks to on its metadata
    nativeStatus('ratechange', { currentTime: 12.34, playbackRate: 1.5 });
    expect(of<{ duration: number; position: number; playbackRate: number }>('positionState').at(-1)).toEqual({ type: 'positionState', duration: 100, position: 12.34, playbackRate: 1.5 });
    nativeStatus('play', { currentTime: 40.5, paused: false });
    expect(of<{ state: string }>('playbackState').at(-1)!.state).toBe('playing');
    expect(of<{ position: number }>('positionState').at(-1)!.position).toBe(40.5);
  });

  it('keeps its buttons across a track change: next and previous go by chapter, the skips by 15 and 30 s', () => {
    mountLock();
    nativeStatus('loadedmetadata');
    commands.length = 0;
    remote('nexttrack');
    expect(of<{ url: string }>('load').at(-1)!.url).toMatch(/\/track\/1$/);
    expect(screen.getByTestId('track').textContent).toBe('1');
    nativeStatus('loadedmetadata');
    nativeSeeked();
    nativeStatus('timeupdate', { currentTime: 50 });
    remote('seekforward');
    expect(of<{ time: number }>('seek').at(-1)!.time).toBe(80);
    remote('seekbackward');
    expect(of<{ time: number }>('seek').at(-1)!.time).toBe(65);
    remote('previoustrack'); // 65 s in: this chapter’s start.
    expect(of<{ time: number }>('seek').at(-1)!.time).toBe(0);
    nativeStatus('timeupdate', { currentTime: 1 });
    remote('previoustrack'); // At its start: the chapter before.
    expect(of<{ url: string }>('load').at(-1)!.url).toMatch(/\/track\/0$/);
  });

  it('tells native the tracks to play on into, none when sleeping at a track’s end, and when the sleep timer ends', () => {
    mountLock();
    const queue = of<{ queue: { advance: boolean; bookId: string; tracks: { url: string; title: string }[] } | null }>('queue').at(-1)!.queue!;
    expect(queue.advance).toBe(true);
    expect(queue.bookId).toBe('book');
    expect(queue.tracks.map((t) => [new URL(t.url).pathname, t.title])).toEqual([['/track/0', 'One'], ['/track/1', 'Two'], ['/track/2', 'Three']]);
    fireEvent.click(screen.getByText('Sleep at track end'));
    expect(of<{ queue: { advance: boolean } }>('queue').at(-1)!.queue.advance).toBe(false);
    fireEvent.click(screen.getByText('Sleep 30'));
    expect(of<{ queue: { advance: boolean } }>('queue').at(-1)!.queue.advance).toBe(true);
    expect(of<{ at: number }>('sleep').at(-1)!.at).toBeGreaterThan(Date.now() + 29 * 60_000);
  });

  describe('the place, kept to the second (D196)', () => {
    const lastSaved = () => vi.mocked(saveProgress).mock.calls.at(-1)?.[0];

    it('saves the place native heard with the time native heard it, never the moment the page heard of it', () => {
      mountLock();
      nativeStatus('loadedmetadata');
      nativeSeeked();
      vi.mocked(saveProgress).mockClear();
      nativeStatus('play', { paused: false, currentTime: 10, at: 1_000 });
      nativeStatus('pause', { currentTime: 42.5, at: 2_000 });
      expect(lastSaved()).toMatchObject({ bookId: 'book', editionId: 'three', locator: { kind: 'audio', track: 0, ms: 42_500 }, at: 2_000 });
    });

    it('when native goes on by itself, saves the finished track’s end in that track, then the next track’s places in it (D181)', () => {
      mountLock();
      nativeStatus('loadedmetadata');
      nativeSeeked();
      nativeStatus('play', { paused: false, currentTime: 99 });
      vi.mocked(saveProgress).mockClear();
      // Native's order: the next track's source first, then the finished track's `ended` at its end.
      receive({ type: 'advanced', url: new URL('/track/1', location.href).href });
      nativeStatus('ended', { currentTime: 100, ended: true, paused: true });
      expect(lastSaved()!.locator).toEqual({ kind: 'audio', track: 0, ms: 100_000 });
      nativeStatus('play', { paused: false, currentTime: 0 });
      nativeStatus('pause', { currentTime: 12 });
      expect(lastSaved()!.locator).toEqual({ kind: 'audio', track: 1, ms: 12_000 });
    });

    it('with the page hidden inside the app, saves nothing of what it hears (native saves then); going hidden is kept at once', () => {
      mountLock();
      nativeStatus('loadedmetadata');
      nativeSeeked();
      nativeStatus('play', { paused: false, currentTime: 10 });
      vi.mocked(saveProgress).mockClear();
      vi.mocked(saveProgressNow).mockClear();
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // The page's last word as it goes: kept on the device at once (and sent).
      expect(saveProgressNow).toHaveBeenCalledTimes(1);
      expect(vi.mocked(saveProgressNow).mock.calls[0]![0]).toMatchObject({ locator: { kind: 'audio', track: 0, ms: 10_000 } });
      // What native said while the page slept, delivered late: native saved it itself.
      nativeStatus('pause', { currentTime: 900, at: 5 });
      expect(saveProgress).not.toHaveBeenCalled();
      visibility.mockReturnValue('visible');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      nativeStatus('play', { paused: false, currentTime: 900 });
      nativeStatus('pause', { currentTime: 905 });
      expect(lastSaved()!.locator).toEqual({ kind: 'audio', track: 0, ms: 905_000 });
    });

    it('takes the place native kept on the device, for the person signed in only', () => {
      mountLock();
      expect(of('tellKept')).toHaveLength(1);
      vi.mocked(saveProgress).mockClear();
      vi.mocked(rememberPosition).mockClear();
      const place = { bookId: 'book', editionId: 'three', locator: { kind: 'audio', track: 2, ms: 61_234 }, at: 1_234, spans: [] };
      receive({ type: 'kept', kept: { ...place, userId: 'someone-else' } });
      expect(saveProgress).not.toHaveBeenCalled();
      receive({ type: 'kept', kept: { ...place, userId: 'self' } });
      expect(rememberPosition).toHaveBeenCalledWith({ bookId: 'book', editionId: 'three', locator: place.locator, at: 1_234, userId: 'self' });
      expect(saveProgress).toHaveBeenCalledWith({ bookId: 'book', editionId: 'three', locator: place.locator, at: 1_234, spans: [] });
    });

    it('saves a place moved to while paused once the moving stops', async () => {
      mountLock();
      nativeStatus('loadedmetadata');
      nativeSeeked();
      vi.mocked(saveProgress).mockClear();
      fireEvent.click(screen.getByText('Scrub to 1:00'));
      await waitFor(() => expect(lastSaved()?.locator).toEqual({ kind: 'audio', track: 0, ms: 60_000 }));
    });
  });

  it('follows native on to the next track when it went on by itself, without loading it again from its start', () => {
    mountLock();
    nativeStatus('loadedmetadata');
    nativeStatus('play', { paused: false, currentTime: 90 });
    commands.length = 0;
    receive({ type: 'advanced', url: new URL('/track/1', location.href).href });
    nativeStatus('ended', { currentTime: 100, ended: true });
    expect(screen.getByTestId('track').textContent).toBe('1');
    expect(of('load')).toEqual([]);
    expect(of('seek')).toEqual([]);
  });
});

describe('AudioProvider follow-along refresh (D46)', () => {
  afterEach(() => {
    cleanup();
    delete window.BookClubNative;
    vi.restoreAllMocks();
  });

  it('takes a fresher edition from book detail without interrupting playback', async () => {
    const chapterSync = {
      id: 'edition',
      kind: 'audio' as const,
      status: 'ready' as const,
      tracks: [{ index: 0, title: 'Track 1', url: '/track/0', durationMs: 100_000, chapter: null }],
      units: [{ title: 'I', m: 0 }],
      alignment: { method: 'number' as const, unitToChapter: [0] },
      geometry: { kind: 'audio' as const, trackDurationsMs: [100_000] },
      sync: { points: [{ m: 0, t: 0 }, { m: 1, t: 1 }] },
      readAlong: null,
    } as unknown as Edition;
    const forced = {
      ...chapterSync,
      alignment: { method: 'forced' as const, unitToChapter: [0] },
      sync: { points: [{ m: 0, t: 0 }, { m: 0.5, t: 0.48 }, { m: 1, t: 1 }] },
      readAlong: { textEditionId: 'ed_epub', sentences: 40, coverage: 0.99 },
    } as unknown as Edition;
    const detail = { id: 'book', title: 'Test', author: 'Author', coverUrl: '/cover', chapters: [], editions: [chapterSync] } as unknown as BookDetail;

    function FollowProbe() {
      const audio = useAudio();
      const state = useAudioState();
      return (
        <>
          <button onClick={() => audio.load(detail, chapterSync, null)}>Load</button>
          <output data-testid="method">{state.edition?.alignment.method ?? 'none'}</output>
          <output data-testid="read-along">{state.edition?.readAlong ? 'yes' : 'no'}</output>
          <output data-testid="playing">{String(state.playing)}</output>
          <output data-testid="position">{String(state.position)}</output>
        </>
      );
    }

    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(keys.session, { user: { id: 'self' } });
    qc.setQueryData(keys.party('book'), null);
    qc.setQueryData(keys.book('book'), detail);
    window.BookClubNative = { postMessage: () => {} };
    vi.spyOn(api, 'party').mockResolvedValue(null);
    vi.spyOn(api, 'partyDiagnostics').mockResolvedValue(undefined);
    vi.spyOn(api, 'setBookPlayback').mockImplementation(async (_bookId, body) => body);
    vi.spyOn(api, 'book').mockResolvedValue(detail);

    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <AudioProvider>
            <FollowProbe />
          </AudioProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Load'));
    act(() => window.__bookClubReceive?.(JSON.stringify({ type: 'status', event: 'loadedmetadata', currentTime: 12, duration: 100, paused: false, ended: false, playbackRate: 1, readyState: 2 })));
    act(() => window.__bookClubReceive?.(JSON.stringify({ type: 'status', event: 'play', currentTime: 12, duration: 100, paused: false, ended: false, playbackRate: 1, readyState: 2 })));
    expect(screen.getByTestId('method').textContent).toBe('number');
    expect(screen.getByTestId('playing').textContent).toBe('true');

    const upgraded: BookDetail = { ...detail, editions: [forced] };
    await act(async () => {
      qc.setQueryData(keys.book('book'), upgraded);
    });

    await waitFor(() => expect(screen.getByTestId('method').textContent).toBe('forced'));
    expect(screen.getByTestId('read-along').textContent).toBe('yes');
    // Playback continues; we do not reload the track or pause.
    expect(screen.getByTestId('playing').textContent).toBe('true');
  });
});
