import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSeries } from '../src/cal/store';
import { createBook } from '../src/repos/books';
import { type Client, type TestApp, closeApp, makeTestApp, setupOwner } from './helpers';

/**
 * A series belongs to one club (PR #13 security review): `PUT /api/books/:bookId/series` let an
 * owner point their own book at *any* series id, including one from a club they are not even a
 * member of, with no check that the series and the book share a club. That cross-club book then
 * showed up in the other club's `GET /series` listing (and would feed Cal's `seriesProgress`
 * context there) with no consent from that club at all. Testing with one person who owns both
 * clubs (rather than two separate people) still exercises the missing check directly, and avoids
 * needing a second independent app-wide `/api/setup` (a one-time bootstrap, not a "new club" call).
 */
describe('series belong to one club (PR #13 security review)', () => {
  let t: TestApp;
  let owner: Client;
  let clubAId: string;
  let clubBId: string;
  let seriesBId: string;
  let bookAId: string;

  beforeAll(async () => {
    t = await makeTestApp();
    const a = await setupOwner(t, 'Alice', 'Club A');
    owner = a.owner;
    clubAId = a.club.id;

    const clubB = await owner.json<{ id: string }>(owner.post('/api/clubs', { name: 'Club B' }), 201);
    clubBId = clubB.id;

    const ownerId = (await owner.json<{ user: { id: string } }>(owner.get('/api/me'), 200)).user.id;
    bookAId = createBook(t.ctx.db, { clubId: clubAId, title: "Alice's Book", author: 'Someone', createdBy: ownerId }).id;
    seriesBId = createSeries(t.ctx.db, { clubId: clubBId, title: "Club B's Series", createdBy: ownerId }).id;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it("refuses to set a club A book's series to club B's series id (404, not applied)", async () => {
    const res = await owner.put(`/api/books/${bookAId}/series`, { seriesId: seriesBId });
    expect(res.statusCode).toBe(404);

    // Never injected into club B's own series listing.
    const seriesForB = await owner.json<{ id: string; books: { id: string }[] }[]>(owner.get(`/api/clubs/${clubBId}/series`), 200);
    const entry = seriesForB.find((s) => s.id === seriesBId)!;
    expect(entry.books.map((bk) => bk.id)).not.toContain(bookAId);
  });

  it("still lets an owner set their own book to their own club's series", async () => {
    const seriesA = await owner.json<{ id: string }>(owner.post(`/api/clubs/${clubAId}/series`, { title: 'A Trilogy' }), 201);
    const res = await owner.json<{ seriesId: string | null }>(owner.put(`/api/books/${bookAId}/series`, { seriesId: seriesA.id }), 200);
    expect(res.seriesId).toBe(seriesA.id);

    const seriesForA = await owner.json<{ id: string; books: { id: string }[] }[]>(owner.get(`/api/clubs/${clubAId}/series`), 200);
    const entry = seriesForA.find((s) => s.id === seriesA.id)!;
    expect(entry.books.map((bk) => bk.id)).toContain(bookAId);
  });

  it('clearing a series (seriesId: null) always works, no club check needed', async () => {
    const res = await owner.json<{ seriesId: string | null }>(owner.put(`/api/books/${bookAId}/series`, { seriesId: null }), 200);
    expect(res.seriesId).toBeNull();
  });

  it('a nonexistent series id is refused the same way (404), never confirming which real ids exist', async () => {
    const res = await owner.put(`/api/books/${bookAId}/series`, { seriesId: 'not-a-real-series-id' });
    expect(res.statusCode).toBe(404);
  });
});
