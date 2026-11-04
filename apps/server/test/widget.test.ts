import { WidgetSnapshotSchema, type BookDetail, type ClubDetail, type Edition, type Locator } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

/** What the iOS app's widgets show (D188): your own places, newest first, with each club's next stop. */
describe('the widgets’ snapshot', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let alice: BookDetail;
  let other: BookDetail;
  let epub: Edition;

  const snapshot = async (c: Client) => {
    const res = await c.get('/api/widget');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    return WidgetSnapshotSchema.parse(res.json());
  };
  const put = (c: Client, book: BookDetail, edition: Edition, locator: Locator, at: number) =>
    c.json(c.put(`/api/books/${book.id}/progress`, { editionId: edition.id, locator, readSpans: [], at }), 200);

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    const a = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    const b = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Another', author: 'Someone' });
    await t.settle();
    alice = await bookDetail(owner, a.bookId);
    other = await bookDetail(owner, b.bookId);
    epub = alice.editions[0]!;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('is empty before you open a book', async () => {
    const ana = await joinClub(t, club, 'Ana');
    expect(await snapshot(ana)).toEqual(expect.objectContaining({ current: null, others: [] }));
  });

  it('names the book you were in last, your place in it and its next stop; the others after it', async () => {
    const ben = await joinClub(t, club, 'Ben');
    await put(ben, other, other.editions[0]!, { kind: 'epub', section: 4, offset: 0 }, Date.now() - 60_000);
    await put(ben, alice, epub, { kind: 'epub', section: 6, offset: 100 }, Date.now());
    const sixth = alice.chapters.find((c) => c.title.startsWith('CHAPTER VI.'))!;
    expect((await owner.put(`/api/books/${alice.id}/meeting`, { t: sixth.t, on: '2026-11-12' })).statusCode).toBeLessThan(300);
    const snap = await snapshot(ben);
    expect(snap.current).toEqual(expect.objectContaining({ bookId: alice.id, clubId: club.id, clubName: club.name, title: 'Alice', author: 'Lewis Carroll', format: 'epub', finished: false }));
    expect(snap.current!.percent).toBe(Math.floor(snap.current!.t * 100));
    expect(snap.current!.label).toMatch(/^Chapter \d+ · \d+%$/);
    expect(snap.current!.coverUrl).toMatch(new RegExp(`^/media/books/${alice.id}/cover\\?v=`));
    expect(snap.current!.stop).toEqual({ label: expect.any(String) as string, on: '2026-11-12', toGo: expect.any(Number) as number, reached: false });
    expect(snap.current!.stop!.toGo).toBeCloseTo(sixth.t - snap.current!.t, 9);
    expect(snap.others.map((b) => b.bookId)).toEqual([other.id]);
  });

  it('never names anyone else’s reading, nor a club you are not in', async () => {
    const stranger = await outsider(t, owner);
    expect((await snapshot(stranger)).current).toBeNull();
    const snap = await snapshot(owner);
    expect(JSON.stringify(snap)).not.toContain('Ben');
    expect((await t.client().get('/api/widget')).statusCode).toBe(401);
  });
});
