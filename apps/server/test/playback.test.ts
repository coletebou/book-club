import { ApiErrorSchema, BookPlaybackSchema, BookProgressSchema, type ClubDetail, ListeningSettingsSchema } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeBook } from '../src/services/removal';
import { type Client, type Res, type TestApp, closeApp, fileOf, joinClub, makePdf, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

/** Listening speed (D195): a default per person, and the last speed per person per book. */
describe('listening speed', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let bookId: string;
  let readers = 0;
  const reader = async () => joinClub(t, club, `Listener ${++readers}`);
  const pdf = () => fileOf('book.pdf', makePdf(2, { title: `Book ${Math.random()}` }), 'main', 'application/pdf');
  const settingsOf = async (c: Client) => ListeningSettingsSchema.parse(await c.json(c.get('/api/me/listening'), 200));
  const playbackOf = async (c: Client, id = bookId) => BookProgressSchema.parse(await c.json(c.get(`/api/books/${id}/progress`), 200)).playback;
  const setRate = (c: Client, rate: unknown, at: unknown = Date.now(), id = bookId) => c.put(`/api/books/${id}/playback`, { rate, at });

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ({ bookId } = await uploadBook(owner, club.id, 'pdf', [pdf()]));
  });
  afterAll(async () => closeApp(t));

  it('everyone starts at 1.0×, and a default chosen is kept for that person only', async () => {
    const ana = await reader();
    const ben = await reader();
    expect(await settingsOf(ana)).toEqual({ defaultRate: 1, at: 0 });
    const saved = ListeningSettingsSchema.parse(await ana.json(ana.put('/api/me/listening', { defaultRate: 1.35, at: 1000 }), 200));
    expect(saved).toEqual({ defaultRate: 1.35, at: 1000 });
    expect(await settingsOf(ana)).toEqual({ defaultRate: 1.35, at: 1000 });
    expect((await settingsOf(ben)).defaultRate).toBe(1);
  });

  it("a default sent late (made offline) never overwrites a newer one from another device", async () => {
    const ana = await reader();
    await ana.json(ana.put('/api/me/listening', { defaultRate: 1.5, at: 2000 }), 200);
    const stale = ListeningSettingsSchema.parse(await ana.json(ana.put('/api/me/listening', { defaultRate: 0.75, at: 1500 }), 200));
    expect(stale).toEqual({ defaultRate: 1.5, at: 2000 });
    expect(await settingsOf(ana)).toEqual({ defaultRate: 1.5, at: 2000 });
  });

  it("a book's speed comes back with its progress, per person, and the newest choice wins", async () => {
    const ana = await reader();
    const ben = await reader();
    expect(await playbackOf(ana)).toBeNull();
    const first = BookPlaybackSchema.parse(await ana.json(setRate(ana, 1.1, 1000), 200));
    expect(first).toEqual({ rate: 1.1, at: 1000 });
    expect(await playbackOf(ana)).toEqual({ rate: 1.1, at: 1000 });
    // A newer choice replaces it; an older one (queued offline) does not.
    await ana.json(setRate(ana, 1.35, 3000), 200);
    expect(BookPlaybackSchema.parse(await ana.json(setRate(ana, 2, 2000), 200))).toEqual({ rate: 1.35, at: 3000 });
    expect(await playbackOf(ana)).toEqual({ rate: 1.35, at: 3000 });
    // Ben never chose one: his is his own.
    expect(await playbackOf(ben)).toBeNull();
    // Another book of the same person is separate.
    const other = await uploadBook(owner, club.id, 'pdf', [pdf()]);
    expect(await playbackOf(ana, other.bookId)).toBeNull();
  });

  it('accepts only the offered speeds: 0.5 to 3.0 in 0.05 steps, with when they were chosen', async () => {
    const ana = await reader();
    for (const bad of [0.45, 3.05, 1.37, '1.5', null, Number.MAX_VALUE]) {
      const res = await setRate(ana, bad);
      expect(res.statusCode, String(bad)).toBe(400);
      expect(errorOf(res).code).toBe('bad_request');
      expect(Object.keys(errorOf(res).fields ?? {})).toEqual(['rate']);
    }
    expect((await ana.put(`/api/books/${bookId}/playback`, { rate: 1.5 })).statusCode).toBe(400);
    expect((await setRate(ana, 1.5, -5)).statusCode).toBe(400);
    expect((await ana.put('/api/me/listening', { defaultRate: 4, at: 1 })).statusCode).toBe(400);
    for (const ok of [0.5, 0.55, 1.05, 2.95, 3]) expect((await setRate(ana, ok)).statusCode, String(ok)).toBe(200);
    expect(await playbackOf(ana)).toMatchObject({ rate: 3 });
  });

  it("is refused for a book of another club, a book that is gone, and anyone signed out", async () => {
    const ozzy = await outsider(t, owner);
    const res = await setRate(ozzy, 1.5);
    expect(res.statusCode).toBe(404);
    expect((await t.client().get('/api/me/listening')).statusCode).toBe(401);
    expect((await t.client().put('/api/me/listening', { defaultRate: 1.5, at: 1 })).statusCode).toBe(401);
    expect((await setRate(t.client(), 1.5)).statusCode).toBe(401);
    const gone = await uploadBook(owner, club.id, 'pdf', [pdf()]);
    await owner.json(setRate(owner, 1.25, Date.now(), gone.bookId), 200);
    expect((await owner.delete(`/api/books/${gone.bookId}`)).statusCode).toBe(204);
    expect((await setRate(owner, 1.5, Date.now(), gone.bookId)).statusCode).toBe(404);
  });

  it('goes with the book when it is purged for good', async () => {
    const doomed = await uploadBook(owner, club.id, 'pdf', [pdf()]);
    await owner.json(setRate(owner, 1.75, Date.now(), doomed.bookId), 200);
    expect(t.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM book_playback WHERE book_id = ?', [doomed.bookId])!.n).toBe(1);
    expect((await owner.delete(`/api/books/${doomed.bookId}`)).statusCode).toBe(204);
    expect(await purgeBook(t.ctx, doomed.bookId)).toBe(true);
    expect(t.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM book_playback WHERE book_id = ?', [doomed.bookId])!.n).toBe(0);
  });
});
