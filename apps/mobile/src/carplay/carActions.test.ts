import { afterEach, describe, expect, it, vi } from 'vitest';
import { CarPlayDriver } from './CarPlayDriver';
import { CAR_CONTROLS, carControl, carControlsForCal } from './carActions';
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

function controls(reactions: ReactionOutbox, sheets = true) {
  const engine = {
    livePlace: vi.fn(() => ({ userId: ENTRY.userId, bookId: ENTRY.bookId, editionId: ENTRY.editionId, locator: ENTRY.locator, trackUrl: `${URL}/media/editions/edition-a/tracks/2`, playing: true })),
    playbackRate: vi.fn(() => 1.25),
    setRate: vi.fn(),
    setSleepTimer: vi.fn(),
    sleepDeadline: vi.fn<() => number | null>(() => null),
    playFromCar: vi.fn(),
    isPlayingCarBook: vi.fn(() => false),
    carDisconnected: vi.fn(),
    keptPlace: vi.fn(async () => null),
  };
  const cal = { open: vi.fn(), ask: vi.fn(), active: vi.fn(() => false) };
  const queues = new KeptQueues({ read: async () => null, write: async () => {}, remove: async () => {} });
  const driver = new CarPlayDriver({
    native: { setCarPlayModel: vi.fn(), widgetSnapshot: () => null },
    queues, engine, serverPlace: async () => null,
    onControl: (id, car) => carControl(id, car, { engine, reactions, cal, sheets, newId: () => ENTRY.clientId, now: () => 60_000 }),
  });
  driver.setControls(CAR_CONTROLS);
  return { engine, driver, cal };
}

afterEach(() => vi.useRealTimers());

describe('Now Playing from the car', () => {
  it('hides Cal on a disabled server and preserves the other car buttons', () => {
    const outbox = new ReactionOutbox({ serverUrl: URL, file: file(), fetch: vi.fn() });
    const { driver } = controls(outbox);
    driver.setControls(carControlsForCal(false));
    const disabled = driver.model().controls?.buttons.map(({ id }) => id);
    expect(disabled).toEqual(expect.arrayContaining(['react', 'speed', 'sleep', 'bookmark']));
    expect(disabled).not.toContain('cal');
    expect(driver.model().controls?.upNext).toBe('Chapters');
    driver.setControls(carControlsForCal(true));
    expect(driver.model().controls?.buttons.map(({ id }) => id)).toContain('cal');
  });

  it('shows five buttons and sends a reaction at the current audio place after durably saving it', async () => {
    const disk = file();
    const fetch = vi.fn(async () => {
      expect(disk.write).toHaveBeenCalledTimes(1);
      return new Response(null, { status: 201 });
    });
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    const { driver } = controls(outbox);
    expect(driver.model().controls).toEqual({
      buttons: [
        { id: 'cal', symbol: 'sparkles' },
        { id: 'react', symbol: 'heart' }, { id: 'speed', system: 'rate' },
        { id: 'sleep', symbol: 'moon.zzz' }, { id: 'bookmark', symbol: 'bookmark' },
      ],
      upNext: 'Chapters',
    });
    await driver.command('control:react');
    const nav = driver.model().nav;
    expect(nav?.to === 'sheet' && nav.actions.map(({ title }) => title)).toEqual(['😱 Shocked', '😢 Sad', '😡 Angry', '😂 Funny', '❤️ Love', '🤯 Mind blown', 'Cancel']);
    await driver.command('control:cancel');
    expect(fetch).not.toHaveBeenCalled();
    await driver.command('control:react');
    const sheet = driver.model().nav;
    await driver.command('control:react:4');
    expect(driver.model().nav).toEqual(sheet); // Native dismisses the selected sheet. No success alert follows.
    await outbox.flush();
    expect(fetch).toHaveBeenCalledWith('https://books.test/api/books/book-a/comments', expect.objectContaining({
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-bookclub-user': 'user-a' },
      body: JSON.stringify({ editionId: 'edition-a', locator: { kind: 'audio', track: 2, ms: 381_272 }, reaction: '❤️', clientId: 'test-client-id' }),
    }));
    expect(disk.stored()).toEqual([]);
  });

  it('uses the player’s live position when the driver taps the bookmark button', async () => {
    const outbox = new ReactionOutbox({ serverUrl: URL, file: file(), fetch: vi.fn() });
    const { driver, engine } = controls(outbox);
    const save = vi.spyOn(driver, 'saveBookmark').mockResolvedValue(undefined);
    await driver.command('control:bookmark');
    expect(save).toHaveBeenCalledWith(engine.livePlace());
  });

  it('uses a quick heart and a 30 minute toggle on versions without action sheets', async () => {
    const disk = file();
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch: vi.fn().mockResolvedValue(new Response(null, { status: 201 })) });
    const { driver, engine } = controls(outbox, false);
    await driver.command('control:react');
    expect(disk.write).toHaveBeenCalledWith(expect.objectContaining({ reaction: '❤️' }));
    expect(driver.model().nav).toMatchObject({ to: 'message', message: 'Reaction saved' });
    await driver.command('control:sleep');
    expect(engine.setSleepTimer).toHaveBeenLastCalledWith(1_860_000);
    engine.sleepDeadline.mockReturnValue(1_860_000);
    await driver.command('control:sleep');
    expect(engine.setSleepTimer).toHaveBeenLastCalledWith(null);
    expect(JSON.stringify(driver.model())).not.toMatch(/phone/i);
  });

  it('applies a native sheet rejection once', async () => {
    const disk = file();
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch: vi.fn().mockResolvedValue(new Response(null, { status: 201 })) });
    const { driver } = controls(outbox);
    await driver.command('control:react');
    await driver.command('sheet:unavailable');
    await driver.command('sheet:unavailable');
    expect(disk.write).toHaveBeenCalledTimes(1);
    expect(disk.write).toHaveBeenCalledWith(expect.objectContaining({ reaction: '❤️' }));
    expect(driver.model().nav).toMatchObject({ to: 'message', message: 'Reaction saved' });
  });

  it('preserves a newer sleep confirmation while the quick heart finishes saving', async () => {
    const disk = file();
    let finish!: () => void;
    disk.write.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch: vi.fn().mockResolvedValue(new Response(null, { status: 201 })) });
    const { driver } = controls(outbox, false);
    const saved = driver.command('control:react');
    await vi.waitFor(() => expect(disk.write).toHaveBeenCalledOnce());
    await driver.command('control:sleep');
    const sleep = driver.model().nav;
    expect(sleep).toMatchObject({ to: 'message', message: 'Sleep timer set for 30 minutes' });
    finish();
    await saved;
    expect(driver.model().nav).toEqual(sleep);
  });

  it('keeps narration controls and reaction alerts off the active Cal screen', async () => {
    const disk = file();
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch: vi.fn() });
    const { driver, engine, cal } = controls(outbox);
    cal.active.mockReturnValue(true);
    await driver.command('control:react:4');
    await driver.command('control:sleep:30');
    await driver.command('control:speed');
    expect(engine.livePlace).not.toHaveBeenCalled();
    expect(engine.setSleepTimer).not.toHaveBeenCalled();
    expect(disk.write).not.toHaveBeenCalled();
    expect(driver.model().nav).toBeNull();
    await driver.command('control:cal');
    expect(cal.open).toHaveBeenCalledOnce();
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

  it.each([[401, 'unauthorized'], [409, 'session_changed']] as const)('keeps a %i reaction without retrying until the account refreshes', async (status, code) => {
    vi.useFakeTimers();
    const disk = file();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code, message: 'The session is unavailable.' } }, { status }))
      .mockResolvedValue(new Response(null, { status: 201 }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.keep(ENTRY);
    await outbox.flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(disk.stored()).toEqual([ENTRY]);
    await outbox.refreshSession();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(disk.stored()).toEqual([]);
  });

  it('retains a session refresh that overlaps an older rejected request', async () => {
    vi.useFakeTimers();
    const disk = file();
    let finish!: (reply: Response) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValue(new Response(null, { status: 201 }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.keep(ENTRY);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const refreshed = outbox.refreshSession();
    finish(Response.json({ error: { code: 'unauthorized', message: 'Old session' } }, { status: 401 }));
    await refreshed;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(disk.stored()).toEqual([]);
  });

  it('keeps another account’s tap on disk across confirmed and foreground refreshes', async () => {
    const current = { ...ENTRY, userId: 'current-reader', clientId: 'current-reaction' };
    const disk = file();
    await disk.write(ENTRY);
    await disk.write(current);
    let signedInUser = current.userId;
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get('x-bookclub-user') === signedInUser
        ? new Response(null, { status: 201 })
        : Response.json({ error: { code: 'session_changed', message: 'The session changed.' } }, { status: 409 }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });

    await outbox.refreshSession(current.userId);
    await outbox.refreshSession();
    await outbox.refreshSession(current.userId);
    const sentOwners = () => fetch.mock.calls.map(([, init]) => new Headers(init.headers).get('x-bookclub-user'));
    expect(sentOwners()).toEqual([current.userId]);
    expect(disk.stored()).toEqual([ENTRY]);

    signedInUser = ENTRY.userId;
    await outbox.refreshSession(ENTRY.userId);
    expect(sentOwners()).toEqual([current.userId, ENTRY.userId]);
    expect(disk.stored()).toEqual([]);
  });

  it('does not consume a tap from a send that completes after the known account changes', async () => {
    const disk = file();
    let finish!: (reply: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.refreshSession(ENTRY.userId);
    await outbox.keep(ENTRY);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    const switched = outbox.refreshSession('current-reader');
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    finish(new Response(null, { status: 201 }));
    await switched;
    expect(disk.stored()).toEqual([ENTRY]);
  });

  it('sends the new account’s pending tap as soon as the aborted drain settles', async () => {
    vi.useFakeTimers();
    const disk = file();
    const current = { ...ENTRY, userId: 'current-reader', clientId: 'current-reaction' };
    let finishOld!: (reply: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 201 }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.refreshSession(ENTRY.userId);
    await outbox.keep(ENTRY);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await outbox.keep(current);

    const switched = outbox.refreshSession(current.userId);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    finishOld(new Response(null, { status: 201 }));
    await switched;

    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-bookclub-user'))).toEqual([ENTRY.userId, current.userId]);
    expect(disk.stored()).toEqual([ENTRY, current]);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('x-bookclub-user')).toBe(current.userId);
    expect(disk.stored()).toEqual([ENTRY]);
  });

  it('uses the new account in a pending disk read without duplicating its first send', async () => {
    vi.useFakeTimers();
    const disk = file();
    const current = { ...ENTRY, userId: 'current-reader', clientId: 'current-reaction' };
    await disk.write(ENTRY);
    await disk.write(current);
    let finishRead!: () => void;
    disk.read.mockImplementationOnce(async (accept) => {
      await new Promise<void>((resolve) => { finishRead = resolve; });
      disk.stored().forEach(accept);
    });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 201 }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    const startup = outbox.refreshSession(ENTRY.userId);
    await vi.waitFor(() => expect(disk.read).toHaveBeenCalledOnce());

    const switched = outbox.refreshSession(current.userId);
    finishRead();
    await Promise.all([startup, switched]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-bookclub-user')).toBe(current.userId);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(disk.stored()).toEqual([ENTRY]);
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

  it.each([[400, 'bad_request'], [403, 'forbidden'], [404, 'not_found']] as const)('retries a proxy %i and drops the tap only on a matching server error', async (status, code) => {
    vi.useFakeTimers();
    const disk = file();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('<html>Temporarily unavailable</html>', { status }))
      .mockImplementationOnce(async () => Response.json({ error: { code: 'proxy_unavailable', message: 'Try again' } }, { status }))
      .mockImplementationOnce(async () => Response.json({ error: { code, message: 'Cannot save this reaction' } }, { status }));
    const outbox = new ReactionOutbox({ serverUrl: URL, file: disk, fetch });
    await outbox.keep(ENTRY);
    await outbox.flush();
    expect(disk.stored()).toEqual([ENTRY]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(disk.stored()).toEqual([ENTRY]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(disk.stored()).toEqual([]);
  });
});
