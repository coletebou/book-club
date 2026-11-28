import { describe, expect, it, vi } from 'vitest';
import { createMediaTickets } from './mediaTicket';

const ok = (ticket: string, expiresAt: number) => ({ ok: true, json: async () => ({ ticket, expiresAt }) }) as unknown as Response;

describe('media tickets for the native player (D219)', () => {
  it('asks the server once per edition, with the app’s own credentials, and keeps it', async () => {
    let now = 1_000_000;
    const fetchFn = vi.fn(async () => ok('t1', now + 12 * 3600_000));
    const tickets = createMediaTickets('https://books.example/', fetchFn as unknown as typeof fetch, () => now);
    expect(await Promise.all([tickets.get('ed1'), tickets.get('ed1')])).toEqual(['t1', 't1']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('https://books.example/api/media/ticket', expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ editionId: 'ed1' }) }));
    now += 11.75 * 3600_000; // within half an hour of its end: a new one
    await tickets.get('ed1');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('asks again once a stream failed with it', async () => {
    const fetchFn = vi.fn(async () => ok('t', Date.now() + 12 * 3600_000));
    const tickets = createMediaTickets('https://books.example', fetchFn as unknown as typeof fetch);
    await tickets.get('ed1');
    tickets.invalidate('ed1');
    await tickets.get('ed1');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('allows a phone ticket that takes seven seconds to arrive', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => {
        setTimeout(() => resolve(ok('slow-ticket', Date.now() + 12 * 3600_000)), 7_000);
      }));
      const tickets = createMediaTickets('https://books.example', fetchFn);
      const ticket = tickets.get('ed1');
      await vi.advanceTimersByTimeAsync(7_000);
      await expect(ticket).resolves.toBe('slow-ticket');
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out one caller without aborting a request a later caller still needs', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const tickets = createMediaTickets('https://books.example', fetchFn);
    const early = tickets.get('ed1', 'user-a');
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      const playing = tickets.get('ed1', 'user-a');
      await vi.advanceTimersByTimeAsync(11_000);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await expect(early).resolves.toBeNull();
      finish(ok('joined-ticket', Date.now() + 12 * 3600_000));
      await expect(playing).resolves.toBe('joined-ticket');
    } finally {
      finish(ok('unused', Date.now() + 12 * 3600_000));
      vi.useRealTimers();
    }
  });

  it('aborts a timed-out request when nobody still needs it', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      const tickets = createMediaTickets('https://books.example', fetchFn);
      const opening = tickets.get('ed1');
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(opening).resolves.toBeNull();
      expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps requests scoped to the expected account and drops a response completed after sign-out', async () => {
    let finish!: (response: Response) => void;
    const fetchFn = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockImplementationOnce(async () => ok('b', Date.now() + 12 * 3600_000))
      .mockImplementationOnce(async () => ok('a-again', Date.now() + 12 * 3600_000));
    const tickets = createMediaTickets('https://books.example', fetchFn);
    const first = tickets.get('ed1', 'user-a');
    await Promise.resolve();
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-bookclub-user': 'user-a' });
    expect(await tickets.get('ed1', 'user-b')).toBe('b');
    tickets.clear();
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    finish(ok('a', Date.now() + 12 * 3600_000));
    expect(await first).toBeNull();
    expect(await tickets.get('ed1', 'user-a')).toBe('a-again');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('is none, never an error, offline or from a server without tickets', async () => {
    const offline = createMediaTickets('https://books.example', (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch);
    expect(await offline.get('ed1')).toBeNull();
    const old = createMediaTickets('https://books.example', (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch);
    expect(await old.get('ed1')).toBeNull();
    const odd = createMediaTickets('https://books.example', (async () => ({ ok: true, json: async () => ({ nope: 1 }) })) as unknown as typeof fetch);
    expect(await odd.get('ed1')).toBeNull();
  });

  it('says which edition a track on this server is in, and none for another host or address', () => {
    const tickets = createMediaTickets('https://books.example', (async () => ok('t', 0)) as unknown as typeof fetch);
    expect(tickets.editionOf('https://books.example/media/editions/ed_00001/tracks/3')).toBe('ed_00001');
    expect(tickets.editionOf('https://evil.example/media/editions/ed_00001/tracks/3')).toBeNull();
    expect(tickets.editionOf('https://evil.example/x?/media/editions/ed_00001/tracks/3')).toBeNull();
    expect(tickets.editionOf('https://books.example/media/editions/ed_00001/file')).toBeNull();
    expect(tickets.editionOf('https://books.example/media/editions/ed_00001/tracks/3/../../file')).toBeNull();
    expect(tickets.editionOf('not a url')).toBeNull();
  });
});

