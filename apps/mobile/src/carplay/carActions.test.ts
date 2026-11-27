import { afterEach, describe, expect, it, vi } from 'vitest';
import { CarPlayDriver } from './CarPlayDriver';
import { carControl, carControls } from './carActions';
import { KeptQueues } from './keptQueues';
import { ReactionOutbox, type PendingReaction } from './reactionOutbox';

const URL = 'https://books.test';
const ENTRY = { userId: 'user-a', bookId: 'book-a', editionId: 'edition-a', locator: { kind: 'audio', track: 2, ms: 381_272 }, reaction: '❤️', clientId: 'test-client-id' } as const;

function file() {
  const entries = new Map<string, PendingReaction>();
  return {
    stored: () => [...entries.values()],
    read: vi.fn(async (accept: (entry: PendingReaction) => void) => { entries.forEach(accept); }),
    write: vi.fn(async (entry: PendingReaction) => { entries.set(entry.clientId, entry); }),
    remove: vi.fn(async (id: string) => { entries.delete(id); }),
    clear: vi.fn(async () => { entries.clear(); }),
  };
}

function controls(reactions: ReactionOutbox) {
  const engine = {
    livePlace: vi.fn(() => ({ userId: ENTRY.userId, bookId: ENTRY.bookId, editionId: ENTRY.editionId, locator: ENTRY.locator, playing: true })),
    playbackRate: vi.fn(() => 1.25),
    setRate: vi.fn(),
    setSleepTimer: vi.fn(),
    playFromCar: vi.fn(),
    carDisconnected: vi.fn(),
    keptPlace: vi.fn(async () => null),
  };
  const queues = new KeptQueues({ read: async () => null, write: async () => {}, remove: async () => {} });
  const driver = new CarPlayDriver({
    native: { setCarPlayModel: vi.fn(), widgetSnapshot: () => null },
    queues, engine, serverPlace: async () => null,
    onControl: (id, car) => carControl(id, car, { engine, reactions, newId: () => ENTRY.clientId, now: () => 60_000 }),
  });
  driver.setControls(carControls(27));
  return { engine, driver };
}

afterEach(() => vi.useRealTimers());

describe('Now Playing from the car', () => {
  it('shows four buttons and sends a reaction at the current audio place after durably saving it', async () => {
    const disk = file();
    const fetch = vi.fn(async () => {
      expect(disk.write).toHaveBeenCalledTimes(1);
      return new Response(null, { status: 201 });
    });
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    const { driver } = controls(outbox);
    expect(driver.model().controls).toEqual({
      buttons: [
        { id: 'cal', symbol: 'sparkles' }, { id: 'react', symbol: 'heart' },
        { id: 'speed', system: 'rate' }, { id: 'sleep', symbol: 'moon.zzz' },
      ],
      upNext: 'Chapters',
    });
    await driver.command('control:react');
    const nav = driver.model().nav;
    expect(nav?.to === 'sheet' && nav.actions.map(({ title }) => title)).toEqual(['😱', '😢', '😡', '😂', '❤️', '🤯', 'Cancel']);
    await driver.command('control:cancel');
    expect(fetch).not.toHaveBeenCalled();
    await driver.command('control:react');
    await driver.command('control:react:4');
    expect(driver.model().nav).toMatchObject({ to: 'message', message: 'Reaction saved' });
    await outbox.flush();
    expect(fetch).toHaveBeenCalledWith('https://books.test/api/books/book-a/comments', expect.objectContaining({
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-bookclub-user': 'user-a' },
      body: JSON.stringify({ editionId: 'edition-a', locator: { kind: 'audio', track: 2, ms: 381_272 }, reaction: '❤️', clientId: 'test-client-id' }),
    }));
    expect(disk.stored()).toEqual([]);
  });

  it('keeps the action-sheet buttons off iOS versions that do not allow them for audio apps', () => {
    expect(carControls(16)).toEqual({ buttons: [{ id: 'cal', symbol: 'sparkles' }, { id: 'speed', system: 'rate' }], upNext: 'Chapters' });
    expect(carControls(17).buttons.map(({ id }) => id)).toContain('react');
  });

  it('cycles from the selected rate and turns the sleep timer on and off', async () => {
    const outbox = new ReactionOutbox({ serverUrl: URL, file: file(), fetch: vi.fn() });
    const { driver, engine } = controls(outbox);
    await driver.command('control:speed');
    expect(engine.setRate).toHaveBeenLastCalledWith(1.5);
    engine.playbackRate.mockReturnValue(2);
    await driver.command('control:speed');
    expect(engine.setRate).toHaveBeenLastCalledWith(1);
    await driver.command('control:sleep');
    const nav = driver.model().nav;
    expect(nav?.to === 'sheet' && nav.actions.map(({ title }) => title)).toEqual(['15 minutes', '30 minutes', '45 minutes', '60 minutes', 'Off', 'Cancel']);
    await driver.command('control:sleep:30');
    expect(engine.setSleepTimer).toHaveBeenLastCalledWith(1_860_000);
    await driver.command('control:sleep:off');
    expect(engine.setSleepTimer).toHaveBeenLastCalledWith(null);
  });

  it('reports a local save failure without sending or confirming the tap', async () => {
    const disk = file();
    disk.write.mockRejectedValue(new Error('disk full'));
    const fetch = vi.fn();
    const { driver } = controls(new ReactionOutbox({ serverUrl: URL, file: disk, fetch }));
    await driver.command('control:react');
    await driver.command('control:react:4');
    expect(driver.model().nav).toMatchObject({ to: 'message', message: 'Could not save reaction' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('reactions waiting for a connection', () => {
  it('reuses the original id after a lost acknowledgement, a restart and a timed retry', async () => {
    vi.useFakeTimers();
    const disk = file();
    const original = new ReactionOutbox({
      serverUrl: URL, file: disk,
      fetch: vi.fn().mockRejectedValue(new Error('acknowledgement lost')),
    });
    await original.keep(ENTRY);
    await original.flush();
    expect(disk.stored()).toEqual([ENTRY]);

    const retry = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const restarted = new ReactionOutbox({ serverUrl: URL, file: disk, fetch: retry });
    await restarted.flush();
    expect(disk.stored()).toEqual([ENTRY]);
    await vi.runOnlyPendingTimersAsync();
    expect(retry.mock.calls[1]?.[0]).toBe('https://books.test/api/books/book-a/comments');
    expect(JSON.parse(retry.mock.calls[1]?.[1].body).clientId).toBe('test-client-id');
    expect(disk.stored()).toEqual([]);
  });

  it('withholds pending reactions from a different signed-in person and clears them on sign-out', async () => {
    vi.useFakeTimers();
    const disk = file();
    const fetch = vi.fn(async () => Response.json({ error: { code: 'session_changed', message: 'The session changed.' } }, { status: 409 }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.keep(ENTRY);
    await outbox.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://books.test/api/books/book-a/comments', expect.objectContaining({
      headers: expect.objectContaining({ 'x-bookclub-user': 'user-a' }),
    }));
    expect(disk.stored()).toEqual([ENTRY]);
    await outbox.clear();
    await vi.runOnlyPendingTimersAsync();
    expect(disk.stored()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending send and clears its file when signing out', async () => {
    const disk = file();
    let resolvePost!: (response: Response) => void;
    const post = new Promise<Response>((resolve) => { resolvePost = resolve; });
    const fetch = vi.fn((_url: string, _init: RequestInit) => post);
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.keep(ENTRY);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const flushed = outbox.flush();
    await outbox.clear();
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    resolvePost(new Response(null, { status: 201 }));
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(disk.stored()).toEqual([]);
  });

  it('loads and sends a durable reaction after the first disk read fails', async () => {
    vi.useFakeTimers();
    const disk = file();
    await disk.write(ENTRY);
    disk.read.mockRejectedValueOnce(new Error('device storage temporarily unavailable'));
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.flush();
    expect(fetch).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(disk.stored()).toEqual([]);
  });

  it('sends newly saved reactions even when the startup scan still fails', async () => {
    vi.useFakeTimers();
    const disk = file();
    disk.read.mockRejectedValue(new Error('a saved file could not be read'));
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.keep(ENTRY);
    await outbox.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(disk.remove).toHaveBeenCalledWith('test-client-id');
    await outbox.clear();
  });

  it('stops retrying when the comment with the client id was already deleted', async () => {
    vi.useFakeTimers();
    const disk = file();
    const fetch = vi.fn(async () => Response.json({ error: { code: 'conflict', message: 'That comment was deleted.' } }, { status: 409 }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.keep(ENTRY);
    await outbox.flush();
    await vi.runOnlyPendingTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(disk.stored()).toEqual([]);
  });
});
