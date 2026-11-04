import { type BookDetail, BookDetailSchema, BookSummarySchema, type ClubDetail, meetingStops } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeBook } from '../src/services/removal';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, openSocket, outsider, setupOwner, uploadBook } from './helpers';

describe('where the club will talk next (D53)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let book: BookDetail;

  const put = (c: Client, body: Record<string, unknown>) => c.put(`/api/books/${book.id}/meeting`, body);
  const library = async (c: Client) => (await c.json<unknown[]>(c.get(`/api/clubs/${club.id}/books`), 200)).map((b) => BookSummarySchema.parse(b));
  const stop = (label: string) => meetingStops(book.chapters).find((s) => s.label === label)!;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('a book has no meeting point until someone sets one', async () => {
    expect(book.meeting).toBeNull();
    expect((await library(ben))[0]!.meeting).toBeNull();
  });

  it('any member sets it at the end of a chapter, with a day; the library and the book show it, by name', async () => {
    const end2 = stop('the end of Chapter 2');
    expect(end2.t).toBeGreaterThan(0);
    const updated = BookDetailSchema.parse(await ana.json(put(ana, { t: end2.t, on: '2026-10-25' }), 200));
    expect(updated.meeting).toMatchObject({ t: end2.t, label: 'the end of Chapter 2', on: '2026-10-25', setBy: { displayName: 'Ana' } });
    expect((await library(ben))[0]!.meeting).toEqual(updated.meeting);
    expect((await bookDetail(ben, book.id)).meeting?.label).toBe('the end of Chapter 2');
  });

  it('friends with the club open hear of a change at once', async () => {
    const socket = await openSocket(t, ben);
    try {
      socket.send({ type: 'subscribe', clubId: club.id });
      await put(owner, { t: stop('the end of Chapter 3').t, on: null });
      await socket.next('book:changed', (m) => m.bookId === book.id);
    } finally {
      await socket.close();
    }
    expect((await bookDetail(ben, book.id)).meeting).toMatchObject({ label: 'the end of Chapter 3', on: null, setBy: { displayName: 'Cole' } });
  });

  it('anyone in the club may move it or clear it; clearing twice is harmless', async () => {
    await ben.json(put(ben, { t: 1 }), 200);
    expect((await bookDetail(ana, book.id)).meeting).toMatchObject({ t: 1, label: 'the end of the book', on: null, setBy: { displayName: 'Ben' } });
    expect((await ana.delete(`/api/books/${book.id}/meeting`)).statusCode).toBe(204);
    expect((await bookDetail(ben, book.id)).meeting).toBeNull();
    expect((await ana.delete(`/api/books/${book.id}/meeting`)).statusCode).toBe(204);
  });

  it('a place between stops is named by its percentage', async () => {
    const res = BookDetailSchema.parse(await ana.json(put(ana, { t: 0.62 }), 200));
    expect(res.meeting?.label).toBe('62%');
  });

  it.each([
    ['the very start', { t: 0 }],
    ['past the end', { t: 1.2 }],
    ['no place', { on: '2026-10-25' }],
    ['a day that does not exist', { t: 0.5, on: '2026-02-30' }],
    ['a time, not a day', { t: 0.5, on: '2026-10-25T18:00' }],
  ])('refuses %s', async (_what, body) => {
    expect((await put(ana, body)).statusCode).toBe(400);
  });

  it('is the club’s own: an outsider finds no book, and nobody signed out may touch it', async () => {
    const stranger = await outsider(t, owner, 'Stu');
    expect((await put(stranger, { t: 0.5 })).statusCode).toBe(404);
    expect((await stranger.delete(`/api/books/${book.id}/meeting`)).statusCode).toBe(404);
    expect((await put(t.client(), { t: 0.5 })).statusCode).toBe(401);
    expect((await bookDetail(ana, book.id)).meeting?.label).toBe('62%');
  });

  it('goes with its book', async () => {
    expect((await owner.delete(`/api/books/${book.id}`)).statusCode).toBe(204);
    // Removing is recoverable (D179): the meeting goes when the book is purged for good.
    expect((await ana.get(`/api/books/${book.id}`)).statusCode).toBe(404);
    await purgeBook(t.ctx, book.id);
    expect(t.ctx.db.get('SELECT 1 AS x FROM meeting_points WHERE book_id = ?', [book.id])).toBeUndefined();
  });
});
