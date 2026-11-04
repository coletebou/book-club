import { type ClubDetail, type CommentView } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Client,
  PASSWORD,
  type TestApp,
  bookDetail,
  closeApp,
  fileOf,
  joinClub,
  makeEpub,
  makeTestApp,
  openSocket,
  setupOwner,
  signIn,
  uploadBook,
} from './helpers';

/** Account and session rules found in review (docs/REVIEW.md, SA2 to SA14). */
describe('accounts and sessions', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;

  const idOf = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/me'), 200)).user.id;
  const detail = async (id = club.id) => owner.json<ClubDetail>(owner.get(`/api/clubs/${id}`), 200);
  const newClub = async (name: string) => owner.json<ClubDetail>(owner.post('/api/clubs', { name }), 201);

  beforeAll(async () => {
    t = await makeTestApp({ PUBLIC_ORIGIN: 'https://books.example.org' });
    ({ owner, club } = await setupOwner(t));
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('marks the session cookie Secure when the public address is https, even behind a plain-HTTP proxy', async () => {
    const c = t.client();
    const res = await c.post('/api/auth/signin', { email: 'cole@example.com', password: PASSWORD }, { origin: 'https://books.example.org' });
    expect(res.statusCode).toBe(200);
    expect(res.setCookies.find((h) => h.startsWith('__Host-bc_session='))).toMatch(/;\s*Secure/i);
    expect(res.setCookies.some((h) => h.startsWith('bc_session='))).toBe(false);
  });

  it('over HTTPS, a session cookie without the __Host- prefix (one a sibling subdomain could plant) is not used', async () => {
    const own = owner.cookies.get('__Host-bc_session')!;
    expect(own).toBeTruthy();
    const planted = t.client();
    planted.cookies.set('bc_session', own);
    expect((await planted.get('/api/me')).statusCode).toBe(401);
    const real = t.client();
    real.cookies.set('__Host-bc_session', own);
    expect((await real.get('/api/me')).statusCode).toBe(200);
  });

  it('someone the owner removed cannot come back with the invite link they had (SA2)', async () => {
    const c = await newClub('Removal club');
    const mallory = await joinClub(t, c, 'Mallory');
    const malloryId = await idOf(mallory);
    expect((await owner.delete(`/api/clubs/${c.id}/members/${malloryId}`)).statusCode).toBe(204);
    const after = await detail(c.id);
    expect(after.invite!.code).not.toBe(c.invite!.code);
    const back = await mallory.post(`/api/invites/${c.invite!.code}/accept`, {}, { origin: t.baseUrl });
    expect(back.statusCode).toBe(404);
    expect((await mallory.get(`/api/clubs/${c.id}`)).statusCode).toBe(404);
    // Leaving on your own keeps the link: nobody else's invite breaks.
    const ana = await joinClub(t, after, 'Ana Leaves');
    expect((await ana.delete(`/api/clubs/${c.id}/members/${await idOf(ana)}`)).statusCode).toBe(204);
    expect((await detail(c.id)).invite!.code).toBe(after.invite!.code);
  });

  it('closes the live connection of a session that ended: signed out, password changed, reset (SA6)', async () => {
    const ben = await joinClub(t, club, 'Ben Sockets');
    const benId = await idOf(ben);
    const laptop = await signIn(t, 'ben.sockets@example.com');
    const phone = await openSocket(t, ben);
    const other = await openSocket(t, laptop);
    // Signing out on the phone ends the phone's socket only.
    expect((await ben.post('/api/auth/signout', {}, { origin: t.baseUrl })).statusCode).toBe(204);
    expect((await phone.closed).code).toBe(4001);
    expect(other.ws.readyState).toBe(other.ws.OPEN);
    // A password change keeps the device that made it and ends every other session.
    const tablet = await signIn(t, 'ben.sockets@example.com');
    const tabletSocket = await openSocket(t, tablet);
    expect((await laptop.post('/api/me/password', { currentPassword: PASSWORD, newPassword: 'a-brand-new-password' }, { origin: t.baseUrl })).statusCode).toBe(204);
    expect((await tabletSocket.closed).code).toBe(4001);
    expect(other.ws.readyState).toBe(other.ws.OPEN);
    // A reset ends them all.
    const link = await owner.json<{ url: string }>(owner.post(`/api/clubs/${club.id}/members/${benId}/reset-link`, {}, { origin: t.baseUrl }), 200);
    const token = link.url.split('/reset/')[1]!;
    expect((await t.client().post('/api/auth/reset', { token, newPassword: 'reset-password-1' }, { origin: t.baseUrl })).statusCode).toBe(200);
    expect((await other.closed).code).toBe(4001);
  });

  it('a reset link works once, even when two requests race with it (SA7)', async () => {
    const dev = await joinClub(t, club, 'Dev Race');
    const devId = await idOf(dev);
    const link = await owner.json<{ url: string }>(owner.post(`/api/clubs/${club.id}/members/${devId}/reset-link`, {}, { origin: t.baseUrl }), 200);
    const token = link.url.split('/reset/')[1]!;
    const answers = await Promise.all(
      ['first-new-password', 'second-new-password'].map((newPassword) => t.client().post('/api/auth/reset', { token, newPassword }, { origin: t.baseUrl })),
    );
    expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const winner = answers.findIndex((r) => r.statusCode === 200);
    const password = winner === 0 ? 'first-new-password' : 'second-new-password';
    const loser = winner === 0 ? 'second-new-password' : 'first-new-password';
    expect((await t.client().post('/api/auth/signin', { email: 'dev.race@example.com', password }, { origin: t.baseUrl })).statusCode).toBe(200);
    expect((await t.client().post('/api/auth/signin', { email: 'dev.race@example.com', password: loser }, { origin: t.baseUrl })).statusCode).toBe(401);
  });

  it('only someone who runs every club a member is in can make their reset link (SA8)', async () => {
    const zoe = await joinClub(t, club, 'Zoe Elsewhere');
    const zoeId = await idOf(zoe);
    // Zoe also runs a club of her own, which the owner does not.
    const zoesClub = await zoe.json<ClubDetail>(zoe.post('/api/clubs', { name: 'Zoe’s club' }, { origin: t.baseUrl }), 201);
    const refused = await owner.post(`/api/clubs/${club.id}/members/${zoeId}/reset-link`, {}, { origin: t.baseUrl });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { message: string } }>().error.message).toContain('bookclub reset-link');
    expect(t.ctx.db.get('SELECT 1 AS x FROM password_resets WHERE user_id = ?', [zoeId])).toBeUndefined();
    expect(zoesClub.role).toBe('owner');
  });

  it('a reset link stops working once the password is changed, or a newer link is made (SA24)', async () => {
    const tim = await joinClub(t, club, 'Tim Links');
    const timId = await idOf(tim);
    const link = async () => (await owner.json<{ url: string }>(owner.post(`/api/clubs/${club.id}/members/${timId}/reset-link`, {}, { origin: t.baseUrl }), 200)).url.split('/reset/')[1]!;
    const redeem = (token: string, newPassword: string) => t.client().post('/api/auth/reset', { token, newPassword }, { origin: t.baseUrl });
    // Tim changes his password himself: the link still in the chat is dead.
    const old = await link();
    expect((await tim.post('/api/me/password', { currentPassword: PASSWORD, newPassword: 'tims-own-new-password' }, { origin: t.baseUrl })).statusCode).toBe(204);
    expect((await redeem(old, 'hijacked-password-1')).statusCode).toBe(401);
    // Only the newest link works.
    const first = await link();
    const second = await link();
    expect((await redeem(first, 'hijacked-password-2')).statusCode).toBe(401);
    expect((await redeem(second, 'tims-reset-password')).statusCode).toBe(200);
    expect((await t.client().post('/api/auth/signin', { email: 'tim.links@example.com', password: 'tims-reset-password' }, { origin: t.baseUrl })).statusCode).toBe(200);
  });

  it('a reset link is checked again when used: not if its maker no longer runs every club the person is in (SA24)', async () => {
    const una = await joinClub(t, club, 'Una Later');
    const unaId = await idOf(una);
    const token = (await owner.json<{ url: string }>(owner.post(`/api/clubs/${club.id}/members/${unaId}/reset-link`, {}, { origin: t.baseUrl }), 200)).url.split('/reset/')[1]!;
    // After the link was made, Una starts a club of her own, which the link's maker does not run.
    await una.json(una.post('/api/clubs', { name: 'Una’s own club' }, { origin: t.baseUrl }), 201);
    const res = await t.client().post('/api/auth/reset', { token, newPassword: 'owner-chosen-password' }, { origin: t.baseUrl });
    expect(res.statusCode).toBe(403);
    expect((await t.client().post('/api/auth/signin', { email: 'una.later@example.com', password: PASSWORD }, { origin: t.baseUrl })).statusCode).toBe(200);
  });

  it('a deleted note keeps no words on the server (SA12)', async () => {
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf('s.epub', makeEpub(['<p>One two three.</p>']), 'main', 'application/epub+zip')], { title: 'Short', author: 'X' });
    await t.settle();
    const edition = (await bookDetail(owner, bookId)).editions[0]!;
    const note = await owner.json<CommentView>(
      owner.post(`/api/books/${bookId}/comments`, { editionId: edition.id, locator: { kind: 'epub', section: 0, offset: 0 }, text: 'A secret thought', quote: 'One two', clientId: 'c_secret_1' }, { origin: t.baseUrl }),
      201,
    );
    expect((await owner.delete(`/api/comments/${note.id}`)).statusCode).toBe(204);
    const row = t.ctx.db.get<{ text: string | null; quote: string | null; deleted_at: number | null }>('SELECT text, quote, deleted_at FROM comments WHERE id = ?', [note.id])!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.text ?? '').toBe('');
    expect(row.quote).toBeNull();
  });

  it('a device with a fast clock cannot freeze the saved position (SA14)', async () => {
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf('c.epub', makeEpub(['<p>One.</p>', '<p>Two.</p>', '<p>Three.</p>']), 'main', 'application/epub+zip')], { title: 'Clock', author: 'X' });
    await t.settle();
    const edition = (await bookDetail(owner, bookId)).editions[0]!;
    const put = (section: number, at: number) =>
      owner.put(`/api/books/${bookId}/progress`, { editionId: edition.id, locator: { kind: 'epub', section, offset: 0 }, readSpans: [], at });
    expect((await put(1, Date.now() + 365 * 24 * 3600_000)).statusCode).toBe(200);
    expect((await put(2, Date.now() + 10 * 60_000)).statusCode).toBe(200);
    const mine = await owner.json<{ mine: { locator: { section: number } } }>(owner.get(`/api/books/${bookId}/progress`), 200);
    expect(mine.mine.locator.section).toBe(2);
  });

  it('failed sign-ins are limited per address whichever emails are tried, and successes do not count (SA9)', async () => {
    const tries = await Promise.all(
      Array.from({ length: 60 }, (_, i) => t.client().post('/api/auth/signin', { email: `nobody${i}@example.com`, password: 'wrong-password' }, { origin: t.baseUrl })),
    );
    expect(tries.some((r) => r.statusCode === 429)).toBe(true);
    expect(tries.filter((r) => r.statusCode === 401).length).toBeLessThanOrEqual(50);
  });
});
