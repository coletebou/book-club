import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ClubDetail } from '@bookclub/shared';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, setupOwner, uploadBook } from './helpers';

const batch = () => ({ version: 1, sessionId: randomUUID(), events: [{ event: 'sync', elapsedMs: 0, decision: 'seek', drift: 2, source: 'native-local' }] });

describe('authenticated, bounded party diagnostics', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let bookId: string;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ({ bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' }));
    await t.settle();
    const book = await bookDetail(owner, bookId);
    await owner.post(`/api/books/${bookId}/party/start`, { editionId: book.editions[0]!.id });
  });
  afterAll(async () => { await closeApp(t); });

  it('requires session, same-origin, book access, and current party participation', async () => {
    const url = `/api/books/${bookId}/party/diagnostics`;
    expect((await t.client().post(url, batch())).statusCode).toBe(401);
    expect((await ana.post(url, batch())).statusCode).toBe(403);
    expect((await owner.post(url, batch(), { origin: 'https://evil.example' })).statusCode).toBe(403);
    const second = await owner.post('/api/clubs', { name: 'Other' });
    expect(second.statusCode).toBe(201);
    const other = await owner.json<ClubDetail>(owner.get(`/api/clubs/${second.json<{ id: string }>().id}`), 200);
    const outsider = await joinClub(t, other, 'Outsider');
    expect((await outsider.post(url, batch())).statusCode).toBe(404);
    await ana.post(`/api/books/${bookId}/party/join`, {});
    expect((await ana.post(url, batch())).statusCode).toBe(204);
    await ana.post(`/api/books/${bookId}/party/leave`, {});
    expect((await ana.post(url, batch())).statusCode).toBe(403);
  });

  it('logs only the strict closed schema plus server-derived identity', async () => {
    const spy = vi.spyOn(t.ctx.log, 'info');
    const payload = batch();
    expect((await owner.post(`/api/books/${bookId}/party/diagnostics`, payload)).statusCode).toBe(204);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ event: 'party.client-diagnostics', bookId, ...payload }), 'party.client-diagnostics');
    const accepted = JSON.stringify(spy.mock.calls.filter(([, msg]) => msg === 'party.client-diagnostics'));
    expect(accepted).not.toContain('Cole');
    expect(accepted).not.toContain('Alice');
    spy.mockClear();
    expect((await owner.post(`/api/books/${bookId}/party/diagnostics`, { ...payload, cookie: 'secret-cookie' })).statusCode).toBe(400);
    expect((await owner.post(`/api/books/${bookId}/party/diagnostics`, { ...payload, events: [{ event: 'media', elapsedMs: 0, url: 'https://private/track?token=secret' }] })).statusCode).toBe(400);
    expect(spy.mock.calls.filter(([, msg]) => msg === 'party.client-diagnostics')).toHaveLength(0);
    spy.mockRestore();
  });

  it('caps events and request bytes, and rejects malformed/unbounded measurements', async () => {
    const url = `/api/books/${bookId}/party/diagnostics`;
    const payload = batch();
    expect((await owner.post(url, { ...payload, events: Array.from({ length: 21 }, () => payload.events[0]) })).statusCode).toBe(400);
    expect((await owner.post(url, { ...payload, events: [{ event: 'sync', elapsedMs: 0, position: 1e100 }] })).statusCode).toBe(400);
    expect((await owner.post(url, { ...payload, events: [] })).statusCode).toBe(400);
    expect((await owner.post(url, { ...payload, partyId: randomUUID() })).statusCode).toBe(403);
    expect((await owner.post(url, { ...payload, events: [{ event: 'not-an-event', elapsedMs: 0 }] })).statusCode).toBe(400);
    expect((await owner.post(url, { ...payload, raw: 'x'.repeat(17_000) })).statusCode).toBe(413);
  });

  it('limits per user even if they rotate diagnostic ids; returns Retry-After', async () => {
    const user = await joinClub(t, club, 'Spam');
    await user.post(`/api/books/${bookId}/party/join`, {});
    for (let i = 0; i < 20; i++) expect((await user.post(`/api/books/${bookId}/party/diagnostics`, batch())).statusCode).toBe(204);
    const rejected = await user.post(`/api/books/${bookId}/party/diagnostics`, batch());
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers['retry-after']).toBe('60');
    // Another participant keeps their own budget.
    expect((await owner.post(`/api/books/${bookId}/party/diagnostics`, batch())).statusCode).toBe(204);
  });
});
