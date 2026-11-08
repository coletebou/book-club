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

