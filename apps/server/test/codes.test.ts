import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { ApiErrorSchema, SignInCodeSchema, UserSchema, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIGN_IN_CODE_MS, claimSignInCode, issueSignInCode } from '../src/repos/codes';
import { type Client, PASSWORD, type Res, type TestApp, closeApp, joinClub, makeTestApp, setupOwner, signIn } from './helpers';

/*
 * One-time sign-in codes (D87): made where you are signed in, typed where you are not (the app on
 * a phone's Home Screen, whose cookies are not the browser's, or another device).
 */
const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

/** The upstream's exchange, as far as these tests need it (D116): every code it is given is Eli's. */
const upstream = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, user: { id: 'bl-77', name: 'Eli', email: 'eli@upstream.test', emailVerified: true } }));
  });
});

describe('one-time sign-in codes (D87)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;

  beforeAll(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t = await makeTestApp({
      UPSTREAM_START_URL: 'https://id.example.com/api/auth/book-club/start',
      UPSTREAM_EXCHANGE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api/auth/book-club/exchange`,
      UPSTREAM_NAME: 'Upstream ID',
    });
    ({ owner, club } = await setupOwner(t));
  });
  afterAll(async () => {
    await closeApp(t);
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });

  const issue = async (c: Client) => SignInCodeSchema.parse(await c.json(c.post('/api/auth/codes'), 201));
  const redeem = (code: string, c: Client = t.client()) => c.post('/api/auth/code', { code });
  const meOf = async (c: Client) => UserSchema.parse((await c.json<{ user: unknown }>(c.get('/api/me'), 200)).user);

  it('signs in a browser with no cookies of its own as the person who made the code, once', async () => {
    const ana = await joinClub(t, club, 'Ana');
    const { code, expiresAt } = await issue(ana);
    expect(code).toMatch(/^\d{8}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(SIGN_IN_CODE_MS - 60_000);
    // The app on the Home Screen: a browser of its own.
    const app = t.client();
    const res = await redeem(`${code.slice(0, 4)} ${code.slice(4)}`, app);
    expect(res.statusCode).toBe(200);
    expect(res.setCookies.some((c) => c.startsWith('bc_session=') && !c.startsWith('bc_session=;'))).toBe(true);
    expect((await meOf(app)).displayName).toBe('Ana');
    // Both stay signed in; the code is spent.
    expect((await meOf(ana)).displayName).toBe('Ana');
    const again = await redeem(code);
    expect(again.statusCode).toBe(401);
    expect(errorOf(again)).toMatchObject({ code: 'invalid_code', message: 'That code does not work. A code works once, for 10 minutes: get a new one where you are signed in.' });
  });

  it('takes a code with spaces or dashes, and refuses one that is not eight digits', async () => {
    const ben = await joinClub(t, club, 'Ben');
    const { code } = await issue(ben);
    expect((await redeem(`${code.slice(0, 4)}-${code.slice(4)}`)).statusCode).toBe(200);
    for (const bad of ['1234567', '123456789', 'abcd efgh', '']) {
      const res = await redeem(bad);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).fields).toMatchObject({ code: 'A sign-in code is eight digits.' });
    }
  });

  it('needs a session to make one', async () => {
    expect((await t.client().post('/api/auth/codes')).statusCode).toBe(401);
  });

  it('works only while new: a newer code, a new password and signing out everywhere retire it', async () => {
    const cleo = await joinClub(t, club, 'Cleo');
    const first = await issue(cleo);
    const second = await issue(cleo);
    expect((await redeem(first.code)).statusCode).toBe(401);
    const third = await issue(cleo);
    expect((await cleo.post('/api/me/password', { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' })).statusCode).toBe(204);
    expect((await redeem(third.code)).statusCode).toBe(401);
    expect(second.code).not.toBe(third.code);
    const laptop = await signIn(t, 'cleo@example.com', 'a brand new passphrase');
    const fourth = await issue(laptop);
    expect((await laptop.post('/api/auth/signout-everywhere')).statusCode).toBe(204);
    expect((await redeem(fourth.code)).statusCode).toBe(401);
  });

  it('lasts ten minutes, and of two requests with the same code only one wins', () => {
    const userId = t.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE display_name = 'Cole'")!.id;
    const made = issueSignInCode(t.ctx.db, userId, 1_000_000);
    expect(made.expiresAt).toBe(1_000_000 + SIGN_IN_CODE_MS);
    expect(claimSignInCode(t.ctx.db, made.code, 1_000_000 + SIGN_IN_CODE_MS + 1)).toBeUndefined();
    const fresh = issueSignInCode(t.ctx.db, userId, 2_000_000);
    expect(claimSignInCode(t.ctx.db, fresh.code, 2_000_001)).toBe(userId);
    expect(claimSignInCode(t.ctx.db, fresh.code, 2_000_002)).toBeUndefined();
    // Kept as a hash only.
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sign_in_codes WHERE code_hash = ?', [fresh.code])!.n).toBe(0);
  });

  it('signs in nobody whose account is disabled', async () => {
    const dora = await joinClub(t, club, 'Dora');
    const { code } = await issue(dora);
    const doraId = (await meOf(dora)).id;
    t.ctx.db.exec('UPDATE users SET disabled_at = ? WHERE id = ?', [Date.now(), doraId]);
    expect((await redeem(code)).statusCode).toBe(401);
  });

  it('signs in an upstream friend, who has no password to type in the app on the Home Screen', async () => {
    // In Safari, through the upstream's sign-in grant: off to the upstream, and back with a code from it.
    const safari = t.client();
    const start = new URL(String((await safari.get('/api/auth/upstream?next=%2F')).headers.location));
    expect((await safari.get(`/api/auth/upstream/callback?state=${start.searchParams.get('state')}&code=a-code-from-upstream`)).headers.location).toBe('/');
    expect((await meOf(safari)).source).toBe('upstream');
    const { code } = await issue(safari);
    const app = t.client();
    expect((await redeem(code, app)).statusCode).toBe(200);
    expect(await meOf(app)).toMatchObject({ displayName: 'Eli', source: 'upstream' });
  });

  it('limits guesses per address, and wrong codes from every address together', async () => {
    // An app of its own behind a trusted proxy, so that guesses come from addresses of their own.
    const app = await makeTestApp({ TRUST_PROXY: 'loopback' });
    try {
      const { owner: cole } = await setupOwner(app);
      const guess = (code: string, from: string) => app.client().post('/api/auth/code', { code }, { 'x-forwarded-for': from });
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await guess(String(10_000_000 + i), '203.0.113.1')).statusCode);
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
      // Fifty wrong codes in all (forty more, from forty other addresses): then no code is tried for
      // a while, from anywhere, even the right one; a password still signs in.
      for (let i = 0; i < 40; i++) expect((await guess(String(20_000_000 + i), `198.51.100.${i}`)).statusCode).toBe(401);
      const { code } = SignInCodeSchema.parse(await cole.json(cole.post('/api/auth/codes'), 201));
      expect((await guess(code, '192.0.2.200')).statusCode).toBe(429);
      expect((await app.client().post('/api/auth/signin', { email: 'cole@example.com', password: PASSWORD }, { 'x-forwarded-for': '192.0.2.201' })).statusCode).toBe(200);
    } finally {
      await closeApp(app);
    }
  });

  it('limits how many codes one person makes', async () => {
    const fern = await joinClub(t, club, 'Fern');
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await fern.post('/api/auth/codes')).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await owner.post('/api/auth/codes')).statusCode).toBe(201);
  });
});
