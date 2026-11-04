import { AudioControlsSchema, BookAudioControlsSchema, BookProgressSchema, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeBook } from '../src/services/removal';
import { type Client, type TestApp, closeApp, fileOf, joinClub, makePdf, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

/** The audiobook's controls in the book (D197): a default per person, and each book's own choice over it. */
describe('hiding the audiobook’s controls', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let bookId: string;
  let readers = 0;
  const reader = async () => joinClub(t, club, `Reader ${++readers}`);
  const pdf = () => fileOf('book.pdf', makePdf(2, { title: `Book ${Math.random()}` }), 'main', 'application/pdf');
  const defaultOf = async (c: Client) => AudioControlsSchema.parse(await c.json(c.get('/api/me/audio-controls'), 200));
  const setDefault = (c: Client, hidden: unknown, at: unknown = Date.now()) => c.put('/api/me/audio-controls', { hidden, at });
  const bookOf = async (c: Client, id = bookId) => BookProgressSchema.parse(await c.json(c.get(`/api/books/${id}/progress`), 200)).audioControls;
  const setBook = (c: Client, hidden: unknown, at: unknown = Date.now(), id = bookId) => c.put(`/api/books/${id}/audio-controls`, { hidden, at });

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ({ bookId } = await uploadBook(owner, club.id, 'pdf', [pdf()]));
  });
  afterAll(async () => closeApp(t));

  it('are shown for everyone until they hide them, and a default chosen is that person’s only', async () => {
    const ana = await reader();
    const ben = await reader();
    expect(await defaultOf(ana)).toEqual({ hidden: false, at: 0 });
    expect(AudioControlsSchema.parse(await ana.json(setDefault(ana, true, 1000), 200))).toEqual({ hidden: true, at: 1000 });
    expect(await defaultOf(ana)).toEqual({ hidden: true, at: 1000 });
    expect(await defaultOf(ben)).toEqual({ hidden: false, at: 0 });
  });

  it('a choice sent late (made offline) never overwrites a newer one from another device', async () => {
    const ana = await reader();
    await ana.json(setDefault(ana, true, 2000), 200);
    expect(AudioControlsSchema.parse(await ana.json(setDefault(ana, false, 1500), 200))).toEqual({ hidden: true, at: 2000 });
    expect(await defaultOf(ana)).toEqual({ hidden: true, at: 2000 });
  });

  it('a book’s own choice comes back with its progress: hidden, shown, or as the default says, newest wins', async () => {
    const ana = await reader();
    expect(await bookOf(ana)).toBeNull();
    expect(BookAudioControlsSchema.parse(await ana.json(setBook(ana, true, 1000), 200))).toEqual({ hidden: true, at: 1000 });
    expect(await bookOf(ana)).toEqual({ hidden: true, at: 1000 });
    // Back to "as my default", itself a choice with its time, so it wins over the older one.
    await ana.json(setBook(ana, null, 3000), 200);
    expect(BookAudioControlsSchema.parse(await ana.json(setBook(ana, false, 2000), 200))).toEqual({ hidden: null, at: 3000 });
    expect(await bookOf(ana)).toEqual({ hidden: null, at: 3000 });
    // Another person, another book: their own.
    expect(await bookOf(await reader())).toBeNull();
    const other = await uploadBook(owner, club.id, 'pdf', [pdf()]);
    expect(await bookOf(ana, other.bookId)).toBeNull();
  });

  it('takes only a yes or no (or null for a book), with when it was chosen', async () => {
    const ana = await reader();
    for (const bad of ['yes', 1, null, undefined]) expect((await setDefault(ana, bad)).statusCode, String(bad)).toBe(400);
    for (const bad of ['no', 0, undefined]) expect((await setBook(ana, bad)).statusCode, String(bad)).toBe(400);
    expect((await setDefault(ana, true, -1)).statusCode).toBe(400);
    expect((await setBook(ana, true, 'now')).statusCode).toBe(400);
  });

  it('is refused for a book of another club, a book that is gone, and anyone signed out', async () => {
    const ozzy = await outsider(t, owner);
    expect((await setBook(ozzy, true)).statusCode).toBe(404);
    expect((await t.client().get('/api/me/audio-controls')).statusCode).toBe(401);
    expect((await setDefault(t.client(), true)).statusCode).toBe(401);
    expect((await setBook(t.client(), true)).statusCode).toBe(401);
    const gone = await uploadBook(owner, club.id, 'pdf', [pdf()]);
    expect((await owner.delete(`/api/books/${gone.bookId}`)).statusCode).toBe(204);
    expect((await setBook(owner, true, Date.now(), gone.bookId)).statusCode).toBe(404);
  });

  it('goes with the book when it is purged for good', async () => {
    const doomed = await uploadBook(owner, club.id, 'pdf', [pdf()]);
    await owner.json(setBook(owner, true, Date.now(), doomed.bookId), 200);
    const count = () => t.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM book_audio_controls WHERE book_id = ?', [doomed.bookId])!.n;
    expect(count()).toBe(1);
    expect((await owner.delete(`/api/books/${doomed.bookId}`)).statusCode).toBe(204);
    expect(await purgeBook(t.ctx, doomed.bookId)).toBe(true);
    expect(count()).toBe(0);
  });
});
