import {
  ApiErrorSchema,
  ClubDetailSchema,
  ClubSummarySchema,
  ResetLinkSchema,
  SessionInfoSchema,
  UserSchema,
  type ClubDetail,
  type Member,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userFromCookieHeader } from '../src/auth/plugin';
import { sha256Hex } from '../src/lib/crypto';
import { type Client, PASSWORD, type Res, type TestApp, joinClub, makeTestApp, setupOwner, signIn, closeApp } from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

/** The session Set-Cookie header of a response (`__Host-bc_session` over HTTPS), split into its value and attributes. */
function sessionCookie(res: Res, name = 'bc_session'): { value: string; attrs: Map<string, string> } | null {
  const raw = res.setCookies.find((c) => c.startsWith(`${name}=`));
  if (!raw) return null;
  const [pair, ...rest] = raw.split(';').map((s) => s.trim());
  const attrs = new Map(rest.map((a) => [a.split('=')[0]!.toLowerCase(), a.includes('=') ? a.slice(a.indexOf('=') + 1) : ''] as const));
  return { value: pair!.slice(name.length + 1), attrs };
}

/** Over HTTPS: the `__Host-` cookie, as browsers accept it only from this host (Secure, path /, no Domain), and no other. */
function expectHostOnlySecureSession(res: Res): void {
  const cookie = sessionCookie(res, '__Host-bc_session');
  expect(cookie?.attrs.has('secure')).toBe(true);
  expect(cookie?.attrs.get('path')).toBe('/');
  expect(cookie?.attrs.has('domain')).toBe(false);
  expect(sessionCookie(res)).toBeNull();
}

function sessionRow(t: TestApp, c: Client) {
  return t.ctx.db.get<{ user_id: string; expires_at: number; last_seen_at: number }>('SELECT * FROM sessions WHERE id_hash = ?', [
    sha256Hex(c.cookies.get('bc_session') ?? ''),
  ]);
}

describe('auth', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;

  beforeAll(async () => {
    t = await makeTestApp({ SIGNIN_ATTEMPTS: '3' });
  });

  afterAll(async () => {
    await closeApp(t);
  });

  describe('first-run setup', () => {
    it('reports that setup is required on an empty instance', async () => {
      const anon = t.client();
      const session = SessionInfoSchema.parse(await anon.json(anon.get('/api/session'), 200));
      expect(session).toEqual({ user: null, setupRequired: true, upstream: null, providers: { apple: false, google: false }, openSignup: false });
      // Without an upstream identity there is nothing to continue with.
      expect((await anon.get('/api/auth/upstream')).statusCode).toBe(404);
    });

    it('validates the setup form field by field', async () => {
      const res = await t.client().post('/api/setup', { displayName: ' ', email: 'not-an-email', password: 'short' });
      expect(res.statusCode).toBe(400);
      const error = errorOf(res);
      expect(error.code).toBe('bad_request');
      expect(Object.keys(error.fields ?? {}).sort()).toEqual(['displayName', 'email', 'password']);
      expect(error.fields?.password).toBe('Use at least 10 characters');
    });

    it('creates the owner and the first club, and signs the owner in', async () => {
      ({ owner, club } = await setupOwner(t));
      expect(ClubDetailSchema.parse(club)).toMatchObject({ name: 'Thursday Readers', role: 'owner', memberCount: 1 });
      const session = SessionInfoSchema.parse(await owner.json(owner.get('/api/session'), 200));
      expect(session.setupRequired).toBe(false);
      expect(session.user).toMatchObject({ displayName: 'Cole', email: 'cole@example.com', source: 'local' });
    });

    it('can only run once (409)', async () => {
      const res = await t.client().post('/api/setup', { displayName: 'Mallory', email: 'mallory@example.com', password: PASSWORD });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('conflict');
      expect(sessionCookie(res)).toBeNull();
      expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n).toBe(1);
      expect(await t.client().post('/api/auth/signin', { email: 'mallory@example.com', password: PASSWORD })).toMatchObject({ statusCode: 401 });
    });

    it('works without a first club', async () => {
      const other = await makeTestApp();
      try {
        const c = other.client();
        const res = await c.post('/api/setup', { displayName: 'Solo', email: 'solo@example.com', password: PASSWORD });
        expect(res.statusCode).toBe(201);
        expect(res.json<{ clubs: unknown[] }>().clubs).toEqual([]);
      } finally {
        await closeApp(other);
      }
    });
  });

  describe('sign in', () => {
    it('signs in with the right password; email case and spaces do not matter', async () => {
      const c = t.client();
      const res = await c.post('/api/auth/signin', { email: '  COLE@Example.com ', password: PASSWORD });
      expect(res.statusCode).toBe(200);
      const { user } = res.json<{ user: unknown }>();
      expect(UserSchema.parse(user)).toMatchObject({ displayName: 'Cole', email: 'cole@example.com' });
      expect((await c.get('/api/me')).statusCode).toBe(200);
    });

    it('sets an HttpOnly, SameSite=Lax, Path=/ session cookie, not Secure over plain http', async () => {
      const res = await t.client().post('/api/auth/signin', { email: 'cole@example.com', password: PASSWORD });
      const cookie = sessionCookie(res);
      expect(cookie).not.toBeNull();
      expect(cookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookie!.attrs.has('httponly')).toBe(true);
      expect(cookie!.attrs.get('samesite')).toBe('Lax');
      expect(cookie!.attrs.get('path')).toBe('/');
      expect(cookie!.attrs.has('secure')).toBe(false);
      expect(cookie!.attrs.has('domain')).toBe(false);
      // Sliding 180-day sessions keep the installed app signed in.
      const expires = new Date(cookie!.attrs.get('expires')!).getTime();
      expect(Math.abs(expires - (Date.now() + 180 * 86_400_000))).toBeLessThan(60_000);
      // Only a hash of the token is stored.
      expect(t.ctx.db.get('SELECT 1 AS x FROM sessions WHERE id_hash = ?', [cookie!.value])).toBeUndefined();
      expect(t.ctx.db.get('SELECT 1 AS x FROM sessions WHERE id_hash = ?', [sha256Hex(cookie!.value)])).toEqual({ x: 1 });
    });

    it('answers a wrong password and an unknown email the same way', async () => {
      const wrong = await t.client().post('/api/auth/signin', { email: 'cole@example.com', password: 'not the password' });
      const unknown = await t.client().post('/api/auth/signin', { email: 'nobody@example.com', password: PASSWORD });
      for (const res of [wrong, unknown]) {
        expect(res.statusCode).toBe(401);
        expect(errorOf(res)).toEqual({ code: 'invalid_credentials', message: 'That email and password do not match.' });
        expect(sessionCookie(res)).toBeNull();
      }
    });

    it('validates the sign-in form', async () => {
      const noPassword = await t.client().post('/api/auth/signin', { email: 'cole@example.com' });
      expect(noPassword.statusCode).toBe(400);
      expect(errorOf(noPassword).fields).toHaveProperty('password');
      const badEmail = await t.client().post('/api/auth/signin', { email: 'cole', password: PASSWORD });
      expect(errorOf(badEmail).fields).toEqual({ email: 'Enter a valid email address' });
    });

    it('rate-limits repeated attempts per address and email (429)', async () => {
      await joinClub(t, club, 'Rita');
      const attempt = (password: string) => t.client().post('/api/auth/signin', { email: 'rita@example.com', password });
      for (let i = 0; i < 3; i++) expect((await attempt('wrong password')).statusCode).toBe(401);
      const limited = await attempt('wrong password');
      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');
      // Even the right password is refused while the limit holds.
      expect((await attempt(PASSWORD)).statusCode).toBe(429);
      // Other accounts are unaffected.
      expect((await t.client().post('/api/auth/signin', { email: 'cole@example.com', password: PASSWORD })).statusCode).toBe(200);
    });

    it('a successful sign-in resets the attempt counter', async () => {
      await joinClub(t, club, 'Rhea');
      const attempt = (password: string) => t.client().post('/api/auth/signin', { email: 'rhea@example.com', password });
      const statuses: number[] = [];
      for (const pw of ['nope nope 1', 'nope nope 2', PASSWORD, 'nope nope 3', 'nope nope 4', PASSWORD]) statuses.push((await attempt(pw)).statusCode);
      expect(statuses).toEqual([401, 401, 200, 401, 401, 200]);
    });

    it('refuses disabled accounts, by password and by existing session', async () => {
      const dora = await joinClub(t, club, 'Dora');
      const doraId = (await dora.json<{ user: { id: string } }>(dora.get('/api/me'), 200)).user.id;
      t.ctx.db.exec('UPDATE users SET disabled_at = ? WHERE id = ?', [Date.now(), doraId]);
      expect((await dora.get('/api/me')).statusCode).toBe(401);
      const res = await t.client().post('/api/auth/signin', { email: 'dora@example.com', password: PASSWORD });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_credentials');
    });
  });

  describe('a page that names someone other than the session’s person', () => {
    it('has its changes refused (409 session_changed) and applied to nobody; reads still work', async () => {
      const me = (await owner.json<{ user: { id: string; displayName: string } }>(owner.get('/api/me'), 200)).user;
      // Another tab signed someone else in; this page still says it is someone else's.
      const stale = await owner.post('/api/me/password', { currentPassword: PASSWORD, newPassword: 'irrelevant-new-password' }, { 'x-bookclub-user': 'u_someone_else' });
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale)).toEqual({ code: 'session_changed', message: 'Someone else is signed in on this device now.' });
      // A beacon says whose it is in the address.
      expect((await owner.post('/api/books/b_nothing/progress/beacon?as=u_someone_else', {})).statusCode).toBe(409);
      // The password was not changed: the old one still signs in.
      expect((await t.client().post('/api/auth/signin', { email: 'cole@example.com', password: PASSWORD })).statusCode).toBe(200);
      // Reads, the page's own person and requests that name nobody are unaffected.
      expect((await owner.get('/api/me', { 'x-bookclub-user': 'u_someone_else' })).statusCode).toBe(200);
      expect((await owner.post('/api/books/b_nothing/progress/beacon?as=' + me.id, {})).statusCode).toBe(404);
    });
  });

  describe('session and profile', () => {
    it('/api/session and /api/me describe the signed-in user and their clubs', async () => {
      const session = SessionInfoSchema.parse(await owner.json(owner.get('/api/session'), 200));
      expect(session.user?.displayName).toBe('Cole');
      const me = await owner.json<{ user: unknown; clubs: unknown[] }>(owner.get('/api/me'), 200);
      expect(UserSchema.parse(me.user)).toEqual(session.user);
      expect(me.clubs.map((c) => ClubSummarySchema.parse(c))).toEqual([expect.objectContaining({ id: club.id, role: 'owner' })]);
    });

    it('reads the session from a raw Cookie header, as upload hooks receive it', async () => {
      const c = await signIn(t, 'cole@example.com');
      const token = c.cookies.get('bc_session')!;
      expect(userFromCookieHeader(t.ctx, `theme=dark; bc_session=${token}; other=1`)?.email).toBe('cole@example.com');
      expect(userFromCookieHeader(t.ctx, `flag; bc_session=${encodeURIComponent(token)}`)?.email).toBe('cole@example.com');
      expect(userFromCookieHeader(t.ctx, 'theme=dark; other=1')).toBeNull();
      expect(userFromCookieHeader(t.ctx, 'bc_session=not-a-real-session-token-value')).toBeNull();
      expect(userFromCookieHeader(t.ctx, '')).toBeNull();
      expect(userFromCookieHeader(t.ctx, undefined)).toBeNull();
    });

    it('anonymous requests to /api/me are 401', async () => {
      const anon = t.client();
      for (const res of [await anon.get('/api/me'), await anon.patch('/api/me', { displayName: 'X' })]) {
        expect(res.statusCode).toBe(401);
        expect(errorOf(res)).toEqual({ code: 'unauthorized', message: 'Sign in to continue.' });
      }
    });

    it('PATCH /api/me changes the display name (trimmed) everywhere it is shown', async () => {
      const renamed = await owner.json<{ user: { displayName: string } }>(owner.patch('/api/me', { displayName: '  Cole T.  ' }), 200);
      expect(renamed.user.displayName).toBe('Cole T.');
      const detail = await owner.json<{ members: Member[] }>(owner.get(`/api/clubs/${club.id}`), 200);
      expect(detail.members.find((m) => m.role === 'owner')?.displayName).toBe('Cole T.');
      // Nothing to change is fine; an empty name is not.
      expect((await owner.json<{ user: { displayName: string } }>(owner.patch('/api/me', {}), 200)).user.displayName).toBe('Cole T.');
      const empty = await owner.patch('/api/me', { displayName: '   ' });
      expect(empty.statusCode).toBe(400);
      expect(errorOf(empty).fields).toEqual({ displayName: 'Enter your name' });
      await owner.json(owner.patch('/api/me', { displayName: 'Cole' }), 200);
    });

    it('slides the session expiry forward on activity (at most hourly) and re-issues the cookie', async () => {
      const c = await signIn(t, 'cole@example.com');
      const token = c.cookies.get('bc_session')!;
      t.ctx.db.exec('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', [Date.now() - 2 * 3600_000, Date.now() + 86_400_000, sha256Hex(token)]);
      const res = await c.get('/api/me');
      expect(res.statusCode).toBe(200);
      const cookie = sessionCookie(res);
      expect(cookie?.value).toBe(token);
      expect(new Date(cookie!.attrs.get('expires')!).getTime()).toBeGreaterThan(Date.now() + 179 * 86_400_000);
      expect(sessionRow(t, c)!.expires_at).toBeGreaterThan(Date.now() + 179 * 86_400_000);
      // Within the hour nothing is re-issued.
      expect(sessionCookie(await c.get('/api/me'))).toBeNull();
    });

    it('an expired or unknown session cookie counts as signed out and is cleared', async () => {
      const c = await signIn(t, 'cole@example.com');
      const token = c.cookies.get('bc_session')!;
      t.ctx.db.exec('UPDATE sessions SET expires_at = ? WHERE id_hash = ?', [Date.now() - 1000, sha256Hex(token)]);
      const res = await c.get('/api/session');
      expect(res.json<{ user: unknown }>().user).toBeNull();
      const cleared = sessionCookie(res);
      expect(cleared?.value).toBe('');
      expect(new Date(cleared!.attrs.get('expires')!).getTime()).toBeLessThan(Date.now());
      expect(c.cookies.has('bc_session')).toBe(false);
      expect(t.ctx.db.get('SELECT 1 AS x FROM sessions WHERE id_hash = ?', [sha256Hex(token)])).toBeUndefined();

      const junk = await t.client().get('/api/me', { cookie: 'bc_session=this-is-not-a-session-token-at-all' });
      expect(junk.statusCode).toBe(401);
      expect(sessionCookie(junk)?.value).toBe('');
    });
  });

  describe('sign out', () => {
    it('deletes the session on the server, clears the cookie and asks the browser to wipe its data', async () => {
      const sam = await joinClub(t, club, 'Sam');
      const token = sam.cookies.get('bc_session')!;
      const res = await sam.post('/api/auth/signout');
      expect(res.statusCode).toBe(204);
      expect(res.headers['clear-site-data']).toBe('"cache", "storage"');
      const cleared = sessionCookie(res);
      expect(cleared?.value).toBe('');
      expect(new Date(cleared!.attrs.get('expires')!).getTime()).toBeLessThan(Date.now());
      expect(sam.cookies.has('bc_session')).toBe(false);
      expect(t.ctx.db.get('SELECT 1 AS x FROM sessions WHERE id_hash = ?', [sha256Hex(token)])).toBeUndefined();
      // Replaying the old cookie does not work.
      const replay = t.client();
      replay.cookies.set('bc_session', token);
      expect((await replay.get('/api/me')).statusCode).toBe(401);
      expect((await replay.json<{ user: unknown }>(replay.get('/api/session'), 200)).user).toBeNull();
    });

    it('signing out without a session is harmless', async () => {
      const res = await t.client().post('/api/auth/signout');
      expect(res.statusCode).toBe(204);
      expect(res.headers['clear-site-data']).toBe('"cache", "storage"');
    });

    it('sign out everywhere ends every session of that user, and only theirs', async () => {
      const phone = await joinClub(t, club, 'Evie');
      const laptop = await signIn(t, 'evie@example.com');
      const res = await laptop.post('/api/auth/signout-everywhere');
      expect(res.statusCode).toBe(204);
      expect(res.headers['clear-site-data']).toBe('"cache", "storage"');
      expect((await phone.get('/api/me')).statusCode).toBe(401);
      expect((await laptop.get('/api/me')).statusCode).toBe(401);
      expect((await owner.get('/api/me')).statusCode).toBe(200);
      expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'evie@example.com'")?.n).toBe(0);
    });

    it('sign out everywhere needs a session', async () => {
      expect((await t.client().post('/api/auth/signout-everywhere')).statusCode).toBe(401);
    });
  });

  describe('password change', () => {
    const NEW_PASSWORD = 'a brand new passphrase';
    let paul: Client;
    let paulsPhone: Client;

    beforeAll(async () => {
      paul = await joinClub(t, club, 'Paul');
      paulsPhone = await signIn(t, 'paul@example.com');
    });

    it('needs the current password', async () => {
      const res = await paul.post('/api/me/password', { currentPassword: 'definitely wrong', newPassword: NEW_PASSWORD });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({ code: 'invalid_credentials', fields: { currentPassword: 'Incorrect' } });
    });

    it('validates the new password', async () => {
      const res = await paul.post('/api/me/password', { currentPassword: PASSWORD, newPassword: 'short' });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).fields).toEqual({ newPassword: 'Use at least 10 characters' });
    });

    it('changes it, keeps this session and signs every other session out', async () => {
      const res = await paul.post('/api/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(res.statusCode).toBe(204);
      expect((await paul.get('/api/me')).statusCode).toBe(200);
      expect((await paulsPhone.get('/api/me')).statusCode).toBe(401);
      expect((await t.client().post('/api/auth/signin', { email: 'paul@example.com', password: PASSWORD })).statusCode).toBe(401);
      expect((await t.client().post('/api/auth/signin', { email: 'paul@example.com', password: NEW_PASSWORD })).statusCode).toBe(200);
    });

    it('needs a session', async () => {
      expect((await t.client().post('/api/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).statusCode).toBe(401);
    });
  });

  describe('joining with an invite', () => {
    it('creates the account and the membership in one step', async () => {
      const usesBefore = t.ctx.db.get<{ uses: number }>('SELECT uses FROM invites WHERE code = ?', [club.invite!.code])!.uses;
      const nina = t.client();
      const res = await nina.post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: ' Nina ', email: 'Nina@Example.com', password: PASSWORD });
      expect(res.statusCode).toBe(201);
      const body = res.json<{ user: unknown; clubId: string }>();
      expect(body.clubId).toBe(club.id);
      expect(UserSchema.parse(body.user)).toMatchObject({ displayName: 'Nina', email: 'nina@example.com', source: 'local' });
      expect(sessionCookie(res)).not.toBeNull();
      const detail = ClubDetailSchema.parse(await nina.json(nina.get(`/api/clubs/${club.id}`), 200));
      expect(detail.role).toBe('member');
      expect(detail.invite!.code).toBe(club.invite!.code);
      expect(t.ctx.db.get<{ uses: number }>('SELECT uses FROM invites WHERE code = ?', [club.invite!.code])!.uses).toBe(usesBefore + 1);
    });

    it('an unknown invite code is 404 invite_invalid', async () => {
      const res = await t.client().post('/api/auth/signup', { inviteCode: 'not-a-real-code', displayName: 'Ivy', email: 'ivy@example.com', password: PASSWORD });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res)).toEqual({ code: 'invite_invalid', message: 'This invite link is no longer valid. Ask for a new one.' });
      expect(t.ctx.db.get("SELECT 1 AS x FROM users WHERE email = 'ivy@example.com'")).toBeUndefined();
    });

    it('an email that already has an account is 409 email_taken', async () => {
      const res = await t.client().post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: 'Nina Two', email: 'NINA@example.com', password: PASSWORD });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'email_taken', fields: { email: 'Already registered' } });
    });

    it('a rotated invite no longer works', async () => {
      const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Rotating Club' }), 201);
      await owner.json(owner.post(`/api/clubs/${other.id}/invite/rotate`), 200);
      const res = await t.client().post('/api/auth/signup', { inviteCode: other.invite!.code, displayName: 'Late', email: 'late@example.com', password: PASSWORD });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('invite_invalid');
    });

    it('validates the sign-up form', async () => {
      const res = await t.client().post('/api/auth/signup', { inviteCode: 'short', displayName: '', email: 'x@example.com', password: 'tiny' });
      expect(res.statusCode).toBe(400);
      expect(Object.keys(errorOf(res).fields ?? {}).sort()).toEqual(['displayName', 'inviteCode', 'password']);
    });
  });

  describe('owner-issued reset links', () => {
    let ana: Client;
    let anaId: string;
    let ownerId: string;

    beforeAll(async () => {
      ana = await joinClub(t, club, 'Ana');
      anaId = (await ana.json<{ user: { id: string } }>(ana.get('/api/me'), 200)).user.id;
      ownerId = (await owner.json<{ user: { id: string } }>(owner.get('/api/me'), 200)).user.id;
    });

    const issue = (c: Client, userId: string) => c.post(`/api/clubs/${club.id}/members/${userId}/reset-link`);
    const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

    it('only the club owner can issue one, and only for a member', async () => {
      const byMember = await issue(ana, ownerId);
      expect(byMember.statusCode).toBe(403);
      expect(errorOf(byMember).code).toBe('forbidden');
      const notMember = await issue(owner, 'notamember123');
      expect(notMember.statusCode).toBe(404);
      expect(errorOf(notMember).message).toBe('Member not found.');
    });

    it('a link resets the password once, and signs the member out everywhere', async () => {
      const link = ResetLinkSchema.parse(await owner.json(issue(owner, anaId), 200));
      expect(link.url.startsWith(`${t.baseUrl}/reset/`)).toBe(true);
      expect(Math.abs(new Date(link.expiresAt).getTime() - (Date.now() + 24 * 3600_000))).toBeLessThan(60_000);
      const token = tokenOf(link.url);
      // Only the hash is stored.
      expect(t.ctx.db.get('SELECT 1 AS x FROM password_resets WHERE token_hash = ?', [token])).toBeUndefined();

      const anon = t.client();
      const res = await anon.post('/api/auth/reset', { token, newPassword: 'ana chose this one' });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ user: unknown; email: string }>();
      expect(UserSchema.parse(body.user).id).toBe(anaId);
      expect(body.email).toBe('ana@example.com');
      expect((await ana.get('/api/me')).statusCode).toBe(401);
      expect((await t.client().post('/api/auth/signin', { email: 'ana@example.com', password: PASSWORD })).statusCode).toBe(401);
      expect((await t.client().post('/api/auth/signin', { email: 'ana@example.com', password: 'ana chose this one' })).statusCode).toBe(200);

      const again = await anon.post('/api/auth/reset', { token, newPassword: 'and another one!' });
      expect(again.statusCode).toBe(401);
      expect(errorOf(again)).toEqual({ code: 'unauthorized', message: 'This reset link has expired. Ask your club owner for a new one.' });
    });

    it('an expired link is refused', async () => {
      const remy = await joinClub(t, club, 'Remy');
      const remyId = (await remy.json<{ user: { id: string } }>(remy.get('/api/me'), 200)).user.id;
      const token = tokenOf(ResetLinkSchema.parse(await owner.json(issue(owner, remyId), 200)).url);
      t.ctx.db.exec('UPDATE password_resets SET expires_at = ? WHERE token_hash = ?', [Date.now() - 1, sha256Hex(token)]);
      const res = await t.client().post('/api/auth/reset', { token, newPassword: 'remy wanted this' });
      expect(res.statusCode).toBe(401);
      expect((await remy.get('/api/me')).statusCode).toBe(200);
      expect((await t.client().post('/api/auth/signin', { email: 'remy@example.com', password: PASSWORD })).statusCode).toBe(200);
    });

    it('unknown and malformed tokens are refused', async () => {
      expect((await t.client().post('/api/auth/reset', { token: 'x'.repeat(43), newPassword: 'whatever it is' })).statusCode).toBe(401);
      const short = await t.client().post('/api/auth/reset', { token: 'short', newPassword: 'whatever it is' });
      expect(short.statusCode).toBe(400);
      expect(errorOf(short).fields).toHaveProperty('token');
    });
  });

  describe('cross-site request checks', () => {
    const clubCount = async () => (await owner.json<unknown[]>(owner.get('/api/clubs'), 200)).length;

    it('refuses a state change from a foreign Origin (403) and changes nothing', async () => {
      const before = await clubCount();
      const res = await owner.post('/api/clubs', { name: 'Evil club' }, { origin: 'https://evil.example' });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toEqual({ code: 'forbidden', message: 'Cross-origin request refused.' });
      expect(await clubCount()).toBe(before);
    });

    it('refuses an opaque "null" Origin', async () => {
      expect((await owner.post('/api/clubs', { name: 'Sandboxed' }, { origin: 'null' })).statusCode).toBe(403);
    });

    it('refuses a request marked Sec-Fetch-Site cross-site or same-site that carries no Origin', async () => {
      const c = await signIn(t, 'cole@example.com');
      c.origin = null;
      for (const site of ['cross-site', 'same-site']) {
        expect((await c.post('/api/clubs', { name: `From ${site}` }, { 'sec-fetch-site': site })).statusCode).toBe(403);
      }
    });

    it('allows requests with no Origin at all (not from a page), or marked same-origin', async () => {
      const c = await signIn(t, 'cole@example.com');
      c.origin = null;
      expect((await c.post('/api/clubs', { name: 'From a script' })).statusCode).toBe(201);
      expect((await c.post('/api/clubs', { name: 'Same origin' }, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(201);
    });

    it('checks every unsafe method, before authentication, but never safe ones', async () => {
      const evil = { origin: 'https://evil.example' };
      expect((await t.client().post('/api/auth/signin', { email: 'cole@example.com', password: PASSWORD }, evil)).statusCode).toBe(403);
      expect((await owner.request({ method: 'PATCH', url: '/api/me', payload: { displayName: 'Hacked' }, headers: evil })).statusCode).toBe(403);
      expect((await owner.request({ method: 'DELETE', url: `/api/clubs/${club.id}/members/x1234567`, headers: evil })).statusCode).toBe(403);
      expect((await owner.request({ method: 'PUT', url: '/api/books/abcdefgh/progress', payload: {}, headers: evil })).statusCode).toBe(403);
      expect((await owner.get('/api/me', evil)).statusCode).toBe(200);
      expect((await owner.json<{ user: { displayName: string } }>(owner.get('/api/me'), 200)).user.displayName).toBe('Cole');
    });

    it('ignores X-Forwarded-Proto unless the proxy is trusted', async () => {
      const res = await t.client().post('/api/auth/signin', { email: 'cole@example.com', password: PASSWORD }, { 'x-forwarded-proto': 'https' });
      expect(res.statusCode).toBe(200);
      expect(sessionCookie(res)!.attrs.has('secure')).toBe(false);
    });
  });
});

describe('a deployment that turns the browser setup off (WEB_SETUP=false)', () => {
  it('cannot be claimed from the browser while it has no owner; the CLI creates the owner', async () => {
    const t = await makeTestApp({ WEB_SETUP: 'false' });
    try {
      const anon = t.client();
      expect(SessionInfoSchema.parse(await anon.json(anon.get('/api/session'), 200)).setupRequired).toBe(false);
      const res = await anon.post('/api/setup', { displayName: 'Mallory', email: 'mallory@example.com', password: PASSWORD, clubName: 'Mine now' });
      expect(res.statusCode).toBe(403);
      expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n).toBe(0);
    } finally {
      await closeApp(t);
    }
  });
});

describe('auth behind a public origin and a TLS proxy', () => {
  it('accepts PUBLIC_ORIGIN and ALLOWED_ORIGINS, uses PUBLIC_ORIGIN for links and can force Secure cookies', async () => {
    const t = await makeTestApp({
      PUBLIC_ORIGIN: 'https://books.example/',
      ALLOWED_ORIGINS: 'https://admin.example, https://other.example',
      COOKIE_SECURE: 'true',
    });
    try {
      const owner = t.client();
      const setup = await owner.post('/api/setup', { displayName: 'Pat', email: 'pat@example.com', password: PASSWORD, clubName: 'Public' });
      expect(setup.statusCode).toBe(201);
      expectHostOnlySecureSession(setup);
      for (const origin of ['https://books.example', 'https://other.example', 'https://admin.example']) {
        expect((await owner.post('/api/clubs', { name: `via ${origin}` }, { origin })).statusCode, origin).toBe(201);
      }
      for (const origin of ['https://books.example.evil.com', 'http://books.example', 'https://books.example/']) {
        expect((await owner.post('/api/clubs', { name: 'nope' }, { origin })).statusCode, origin).toBe(403);
      }
      const clubs = await owner.json<{ id: string; name: string }[]>(owner.get('/api/clubs'), 200);
      const detail = ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${clubs.find((c) => c.name === 'Public')!.id}`), 200));
      expect(detail.invite!.url).toBe(`https://books.example/join/${detail.invite!.code}`);
      const member = await joinClub(t, detail, 'Quin');
      const quinId = (await member.json<{ user: { id: string } }>(member.get('/api/me'), 200)).user.id;
      const link = ResetLinkSchema.parse(await owner.json(owner.post(`/api/clubs/${detail.id}/members/${quinId}/reset-link`), 200));
      expect(link.url.startsWith('https://books.example/reset/')).toBe(true);
    } finally {
      await closeApp(t);
    }
  });

  it('behind a trusted proxy, the origin check and Secure cookies follow X-Forwarded-Proto', async () => {
    const t = await makeTestApp({ TRUST_PROXY: 'loopback' });
    try {
      const httpsOrigin = t.baseUrl.replace(/^http:/, 'https:');
      const c = t.client();
      c.origin = httpsOrigin;
      const body = { displayName: 'Tia', email: 'tia@example.com', password: PASSWORD, clubName: 'Proxied' };
      // The browser saw https, so an http Origin would be a foreign one.
      expect((await c.post('/api/setup', body, { 'x-forwarded-proto': 'https', origin: t.baseUrl })).statusCode).toBe(403);
      const res = await c.post('/api/setup', body, { 'x-forwarded-proto': 'https' });
      expect(res.statusCode).toBe(201);
      expectHostOnlySecureSession(res);
      const clubs = await c.json<{ id: string }[]>(c.get('/api/clubs', { 'x-forwarded-proto': 'https' }), 200);
      const detail = await c.json<ClubDetail>(c.get(`/api/clubs/${clubs[0]!.id}`, { 'x-forwarded-proto': 'https' }), 200);
      expect(detail.invite!.url.startsWith(`${httpsOrigin}/join/`)).toBe(true);
    } finally {
      await closeApp(t);
    }
  });

  it('behind a trusted proxy, a client cannot choose the address its sign-in attempts count against', async () => {
    const t = await makeTestApp({ TRUST_PROXY: 'loopback', SIGNIN_ATTEMPTS: '3' });
    try {
      const body = { displayName: 'Tia', email: 'tia@example.com', password: PASSWORD, clubName: 'Proxied' };
      expect((await t.client().post('/api/setup', body)).statusCode).toBe(201);
      // The proxy (on loopback, trusted) appends the address it saw; the client puts its own in front.
      const attempt = (spoofed: string, seen: string) =>
        t.client().post('/api/auth/signin', { email: 'tia@example.com', password: 'wrong password' }, { 'x-forwarded-for': `${spoofed}, ${seen}` });
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await attempt(`198.51.100.${i}`, '203.0.113.7')).statusCode);
      expect(statuses).toEqual([401, 401, 401, 429]);
      // Another client, as the proxy saw it, has attempts of its own.
      expect((await attempt('198.51.100.1', '203.0.113.8')).statusCode).toBe(401);
    } finally {
      await closeApp(t);
    }
  });

  it('with a proxy key, only the proxy that sends it can say who the client is (a shared host)', async () => {
    const key = 'the-proxy-key-of-these-tests-0123456789';
    const t = await makeTestApp({ TRUST_PROXY: 'loopback', TRUST_PROXY_KEY: key, SIGNIN_ATTEMPTS: '3' });
    try {
      const body = { displayName: 'Uma', email: 'uma@example.com', password: PASSWORD, clubName: 'Keyed' };
      expect((await t.client().post('/api/setup', body)).statusCode).toBe(201);
      // The scheme is the proxy's to tell: https without the key does not make the session cookie Secure.
      const signIn = (headers: Record<string, string>) => t.client().post('/api/auth/signin', { email: 'uma@example.com', password: PASSWORD }, { 'x-forwarded-for': '203.0.113.50', ...headers });
      const unkeyed = await signIn({ 'x-forwarded-proto': 'https' });
      expect(unkeyed.statusCode).toBe(200);
      expect(sessionCookie(unkeyed)!.attrs.has('secure')).toBe(false);
      // Keyed, the scheme counts: the page's Origin is then the https one.
      const keyed = await signIn({ 'x-forwarded-proto': 'https', 'x-bookclub-proxy-key': key, origin: t.baseUrl.replace(/^http:/, 'https:') });
      expect(keyed.statusCode).toBe(200);
      expectHostOnlySecureSession(keyed);

      const attempt = (address: string, headers: Record<string, string> = {}) =>
        t.client().post('/api/auth/signin', { email: 'uma@example.com', password: 'wrong password' }, { 'x-forwarded-for': address, ...headers });
      // Another user of the host, straight to the app's port, from the proxy's own address: whatever
      // client it names, its attempts are counted against its own connection.
      const direct: number[] = [];
      for (let i = 0; i < 4; i++) direct.push((await attempt(`198.51.100.${i}`)).statusCode);
      expect(direct).toEqual([401, 401, 401, 429]);
      // A wrong key is no key.
      expect((await attempt('198.51.100.9', { 'x-bookclub-proxy-key': 'not-the-proxy-key-not-the-proxy-key-0' })).statusCode).toBe(429);
      // The proxy, with its key: each reader it names has attempts of their own.
      for (let i = 0; i < 3; i++) expect((await attempt(`203.0.113.${i}`, { 'x-bookclub-proxy-key': key })).statusCode).toBe(401);
    } finally {
      await closeApp(t);
    }
  });
});
