import { createHash, randomBytes } from 'node:crypto';
import { type Server, type ServerResponse, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiErrorSchema, SessionInfoSchema, type ClubDetail } from '@bookclub/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_PASSWORD, SESSION_COOKIE, account, createFakeUpstream } from '../../../tools/fake-upstream/server.mjs';
import { type BuiltApp, buildApp } from '../src/app';
import { UPSTREAM_LIMITS, setUpstreamLimits } from '../src/auth/upstream';
import { loadConfig } from '../src/config';
import { Client, type Res, type TestApp, closeApp, makeTestApp, rawRequest, setupOwner } from './helpers';

/** S256 (RFC 7636), worked out here rather than taken from the code under test. */
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const newCode = () => randomBytes(32).toString('base64url');

const UPSTREAM_START = 'https://id.example.com/api/auth/book-club/start';

interface UpstreamUser {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
}

const BEA: UpstreamUser = { id: '66f0c0ffee0000000000b001', name: 'Bea', email: 'Bea@Upstream.example', emailVerified: true };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The upstream's exchange as a test plays it: a code it was told of redeems once, with its challenge's verifier. */
class StubExchange {
  readonly asked: { readonly body: Record<string, unknown>; readonly contentType: string | undefined }[] = [];
  readonly grants = new Map<string, { readonly challenge: string; readonly user: UpstreamUser }>();
  /** Answer every request this way instead, until set back to null. */
  answer: ((res: ServerResponse) => void) | null = null;
  url = '';
  readonly server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      this.asked.push({ body, contentType: req.headers['content-type'] });
      if (this.answer) {
        this.answer(res);
        return;
      }
      const grant = typeof body.code === 'string' ? this.grants.get(body.code) : undefined;
      if (!grant || typeof body.codeVerifier !== 'string' || s256(body.codeVerifier) !== grant.challenge) {
        sendJson(res, 400, { success: false, error: 'Sign-in expired or could not be verified. Start again.' });
        return;
      }
      this.grants.delete(body.code as string);
      sendJson(res, 200, { success: true, user: grant.user });
    });
  });

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/auth/book-club/exchange`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** A sign-in on its way to the upstream: where the app sent the browser, and what it sent along. */
interface Leaving {
  readonly res: Res;
  readonly start: URL;
  readonly state: string;
  readonly challenge: string;
}

const where = (res: Res) => res.headers.location ?? '';
const hasSessionCookie = (res: Res) => res.setCookies.some((c) => /^(__Host-)?bc_session=[^;]/.test(c));
const refusedTo = (next: string) => `/signin?upstream=refused&next=${encodeURIComponent(next)}`;

describe('continuing with the upstream through its sign-in grant', () => {
  const stub = new StubExchange();
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;

  beforeAll(async () => {
    await stub.listen();
    // Plenty of sign-ins from this one address: the limit has a test of its own.
    t = await makeTestApp({ UPSTREAM_START_URL: UPSTREAM_START, UPSTREAM_EXCHANGE_URL: stub.url, UPSTREAM_NAME: 'Upstream ID', SIGNIN_ATTEMPTS: '1000' });
    ({ owner, club } = await setupOwner(t));
  });

  afterEach(() => {
    stub.answer = null;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeApp(t);
    await stub.close();
  });

  /** "Continue with Upstream ID": the browser is sent to the upstream's start address. */
  async function leave(c: Client, next = '/'): Promise<Leaving> {
    const res = await c.get(`/api/auth/upstream?next=${encodeURIComponent(next)}`);
    expect(res.statusCode).toBe(303);
    const start = new URL(where(res));
    return { res, start, state: start.searchParams.get('state')!, challenge: start.searchParams.get('code_challenge')! };
  }

  /** The upstream signed `user` in: a code for the challenge, and the browser back at the callback with it. */
  async function comeBack(c: Client, leaving: Leaving, user: UpstreamUser = BEA): Promise<Res> {
    const code = newCode();
    stub.grants.set(code, { challenge: leaving.challenge, user });
    return c.get(`/api/auth/upstream/callback?state=${leaving.state}&code=${code}`);
  }

  async function throughUpstream(user: UpstreamUser = BEA, next = '/', c = t.client()): Promise<{ c: Client; res: Res }> {
    return { c, res: await comeBack(c, await leave(c, next), user) };
  }

  const me = async (c: Client) => (await c.json<{ user: { id: string; displayName: string; email: string | null; source: string }; clubs: unknown[] }>(c.get('/api/me'), 200)).user;
  const nobody = async (c: Client) => SessionInfoSchema.parse(await c.json(c.get('/api/session'), 200)).user === null;
  const usersWithSubject = (id: string) => t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE upstream_subject = ?', [`upstream:${id}`])!.n;

  it('offers anonymous visitors to continue with the upstream account, by its name', async () => {
    const session = SessionInfoSchema.parse(await t.client().json(t.client().get('/api/session'), 200));
    // No UPSTREAM_PASSWORD_URL in this describe's app: continuing through the upstream's own page
    // is the only way in with it (`password: false`); the nested describe below configures it.
    expect(session).toEqual({ user: null, setupRequired: false, upstream: { name: 'Upstream ID', password: false }, providers: { apple: false, google: false } });
  });

  it('sends the browser to the upstream with a state and a PKCE challenge, and keeps the sign-in under way in a cookie of its own', async () => {
    const c = t.client();
    const leaving = await leave(c, `/join/${club.invite!.code}`);
    expect(`${leaving.start.origin}${leaving.start.pathname}`).toBe(UPSTREAM_START);
    expect(leaving.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(leaving.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(leaving.start.searchParams.get('code_challenge_method')).toBe('S256');
    expect([...leaving.start.searchParams.keys()].sort()).toEqual(['code_challenge', 'code_challenge_method', 'state']);
    const cookie = leaving.res.setCookies.find((v) => v.startsWith('bc_upstream='))!;
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    expect(cookie).toMatch(/; Max-Age=600(;|$)/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(hasSessionCookie(leaving.res)).toBe(false);
    // Each sign-in has its own.
    const again = await leave(t.client());
    expect(again.state).not.toBe(leaving.state);
    expect(again.challenge).not.toBe(leaving.challenge);
  });

  it('back with a code, the server redeems it with the verifier only this device had, and signs the person in', async () => {
    const c = t.client();
    const leaving = await leave(c, '/books/book_x?at=0.5');
    const asked = stub.asked.length;
    const res = await comeBack(c, leaving);
    expect(res.statusCode).toBe(303);
    expect(where(res)).toBe('/books/book_x?at=0.5');
    expect(hasSessionCookie(res)).toBe(true);
    // Its way back is spent.
    expect(res.setCookies.some((v) => /^bc_upstream=;/.test(v))).toBe(true);
    expect(c.cookies.has('bc_upstream')).toBe(false);
    // Once, server to server, as JSON: the code, and the verifier whose S256 the browser took to the upstream.
    expect(stub.asked).toHaveLength(asked + 1);
    const exchange = stub.asked.at(-1)!;
    expect(exchange.contentType).toMatch(/^application\/json/);
    expect(Object.keys(exchange.body).sort()).toEqual(['code', 'codeVerifier']);
    expect(s256(String(exchange.body.codeVerifier))).toBe(leaving.challenge);
    // The verifier itself never went to the upstream by the browser.
    expect(leaving.start.href).not.toContain(String(exchange.body.codeVerifier));
    expect(await me(c)).toMatchObject({ displayName: 'Bea', email: 'bea@upstream.example', source: 'upstream' });
    // The upstream grants nothing here: membership comes only from invites.
    expect((await c.json<{ clubs: unknown[] }>(c.get('/api/me'), 200)).clubs).toEqual([]);
  });

  it('a repeat sign-in is the same person here, with the name and the address the upstream has now', async () => {
    const first = await me((await throughUpstream()).c);
    const renamed = await me((await throughUpstream({ ...BEA, name: 'Beatrice', email: 'beatrice@upstream.example' })).c);
    expect(renamed).toMatchObject({ id: first.id, displayName: 'Beatrice', email: 'beatrice@upstream.example' });
    expect((await me((await throughUpstream()).c)).id).toBe(first.id);
    expect(usersWithSubject(BEA.id)).toBe(1);
  });

  it.each([
    ['a name trimmed, to 60 characters', { name: `  ${'N'.repeat(70)}  `, email: 'n@upstream.example' }, 'N'.repeat(60), 'n@upstream.example'],
    ['a name cut short without breaking a character', { name: `${'n'.repeat(59)}😀😀`, email: null }, 'n'.repeat(59), null],
    ['no name: the name of the address', { name: '  ', email: 'Carl.Jung@Upstream.example' }, 'carl.jung', 'carl.jung@upstream.example'],
    ['no name and no address', { name: '', email: null }, 'Reader', null],
    ['an account made by phone, as the upstream names it, and without an address', { name: 'Phone User', email: null, emailVerified: false }, 'Phone User', null],
    ['an address that is not one', { name: 'Odd', email: 'not-an-address' }, 'Odd', null],
  ])('%s', async (_label, fields, displayName, email) => {
    const id = `bl-name-${displayName.length}-${String(email)}`;
    const { c } = await throughUpstream({ id, emailVerified: true, ...fields });
    expect(await me(c)).toMatchObject({ displayName, email });
  });

  it('an address the upstream has not verified is not taken as theirs', async () => {
    const { c } = await throughUpstream({ id: 'bl-unverified', name: '', email: 'una@upstream.example', emailVerified: false });
    // Nor its name: the address is none of theirs here.
    expect(await me(c)).toMatchObject({ displayName: 'Reader', email: null, source: 'upstream' });
  });

  it('never gives an upstream account the email of an account here', async () => {
    const { c } = await throughUpstream({ id: 'bl-copycat', name: 'Copycat', email: 'COLE@example.com', emailVerified: true });
    expect(await me(c)).toMatchObject({ displayName: 'Copycat', email: null });
    expect((await me(owner)).email).toBe('cole@example.com');
  });

  it('a state other than the one this device left with is refused, and that sign-in is spent', async () => {
    const c = t.client();
    const leaving = await leave(c, '/clubs');
    const asked = stub.asked.length;
    const wrong = await comeBack(c, { ...leaving, state: newCode() });
    expect(wrong.statusCode).toBe(303);
    expect(where(wrong)).toBe(refusedTo('/clubs'));
    expect(hasSessionCookie(wrong)).toBe(false);
    // The right one after it finds nothing under way.
    expect(where(await comeBack(c, leaving))).toBe(refusedTo('/'));
    expect(stub.asked).toHaveLength(asked);
    expect(await nobody(c)).toBe(true);
  });

  it('someone else’s code sent to this browser signs it in as nobody (login CSRF)', async () => {
    // Mallory signs in at the upstream in her own browser, and keeps the way back instead of following it.
    const mallory = t.client();
    const hers = await leave(mallory);
    const code = newCode();
    stub.grants.set(code, { challenge: hers.challenge, user: { id: 'bl-mallory', name: 'Mallory', email: 'mallory@upstream.example', emailVerified: true } });
    const trap = `/api/auth/upstream/callback?state=${hers.state}&code=${code}`;
    const asked = stub.asked.length;
    // A browser with no sign-in under way, and one with its own.
    const victim = t.client();
    expect(where(await victim.get(trap))).toBe(refusedTo('/'));
    const busy = t.client();
    await leave(busy, '/settings');
    expect(where(await busy.get(trap))).toBe(refusedTo('/settings'));
    for (const c of [victim, busy]) expect(await nobody(c)).toBe(true);
    expect(stub.asked).toHaveLength(asked);
    expect(usersWithSubject('bl-mallory')).toBe(0);
  });

  it('a sign-in that took more than ten minutes is refused', async () => {
    const c = t.client();
    const leaving = await leave(c, '/clubs');
    const later = Date.now() + 10 * 60_000 + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const res = await comeBack(c, leaving, { ...BEA, id: 'bl-slow' });
    vi.restoreAllMocks();
    expect(where(res)).toBe(refusedTo('/clubs'));
    expect(usersWithSubject('bl-slow')).toBe(0);
  });

  it('the way back works once: the same address again, even with the cookie put back, signs nobody in', async () => {
    const c = t.client();
    const leaving = await leave(c);
    const cookie = c.cookies.get('bc_upstream')!;
    const code = newCode();
    stub.grants.set(code, { challenge: leaving.challenge, user: { ...BEA, id: 'bl-replay' } });
    const callback = `/api/auth/upstream/callback?state=${leaving.state}&code=${code}`;
    expect(where(await c.get(callback))).toBe('/');
    // Another browser replaying it: nothing under way there.
    expect(where(await t.client().get(callback))).toBe(refusedTo('/'));
    // The same browser, its cookie back (a copy kept): the upstream redeems a code once.
    const copy = t.client();
    copy.cookies.set('bc_upstream', cookie);
    const res = await copy.get(callback);
    expect(where(res)).toBe(refusedTo('/'));
    expect(hasSessionCookie(res)).toBe(false);
    expect(usersWithSubject('bl-replay')).toBe(1);
  });

  it('the upstream saying it did not sign them in (error=failed), with the state or without it, is refused whatever the browser holds', async () => {
    const asked = stub.asked.length;
    const c = t.client();
    const leaving = await leave(c, '/clubs');
    expect(where(await c.get(`/api/auth/upstream/callback?state=${leaving.state}&error=failed`))).toBe(refusedTo('/clubs'));
    // The upstream lost its own transaction: no state. The sign-in under way here is spent all the same.
    const lost = t.client();
    await leave(lost, '/clubs');
    const res = await lost.get('/api/auth/upstream/callback?error=failed');
    expect(where(res)).toBe(refusedTo('/clubs'));
    expect(res.setCookies.some((v) => /^bc_upstream=;/.test(v))).toBe(true);
    // Nothing under way, one that is not a sign-in, or one too old.
    expect(where(await t.client().get('/api/auth/upstream/callback?error=failed'))).toBe(refusedTo('/'));
    const garbled = t.client();
    garbled.cookies.set('bc_upstream', 'not-a-sign-in');
    expect(where(await garbled.get('/api/auth/upstream/callback?error=failed'))).toBe(refusedTo('/'));
    const old = t.client();
    await leave(old, '/clubs');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    const late = await old.get('/api/auth/upstream/callback?error=failed');
    vi.restoreAllMocks();
    expect(where(late)).toBe(refusedTo('/clubs'));
    // A code beside an error is no sign-in either.
    const both = t.client();
    const hers = await leave(both);
    stub.grants.set('a-code', { challenge: hers.challenge, user: BEA });
    expect(where(await both.get(`/api/auth/upstream/callback?state=${hers.state}&code=a-code&error=failed`))).toBe(refusedTo('/'));
    expect(stub.asked).toHaveLength(asked);
  });

  it('a way back without a code, or with two, is refused', async () => {
    for (const query of ['', '&code=', '&code=a&code=b', `&code=${'x'.repeat(513)}`]) {
      const c = t.client();
      const leaving = await leave(c);
      expect(where(await c.get(`/api/auth/upstream/callback?state=${leaving.state}${query}`)), query).toBe(refusedTo('/'));
    }
  });

  it.each<[string, (res: ServerResponse) => void]>([
    ['a code the upstream does not know (400)', (res) => sendJson(res, 400, { success: false, error: 'Sign-in expired or could not be verified. Start again.' })],
    ['a suspended account (403)', (res) => sendJson(res, 403, { success: false, error: 'This account is suspended.' })],
    ['an account being deleted (409)', (res) => sendJson(res, 409, { success: false, error: 'This account is being deleted.' })],
    ['the upstream unavailable (503)', (res) => sendJson(res, 503, { success: false, error: 'Sign-in is temporarily unavailable. Start again.' })],
    ['the upstream’s limit for Book Club’s address spent (429)', (res) => sendJson(res, 429, { success: false, error: 'Too many authentication attempts, please try again later.', code: 'AUTH_RATE_LIMIT' })],
    ['a 200 that is no success', (res) => sendJson(res, 200, { success: false })],
    ['a 200 without the person', (res) => sendJson(res, 200, { success: true })],
    ['a 200 with a person without an id', (res) => sendJson(res, 200, { success: true, user: { name: 'X', email: null, emailVerified: true } })],
    ['a 200 with an id too long to be one', (res) => sendJson(res, 200, { success: true, user: { id: 'x'.repeat(201), name: 'X', email: null, emailVerified: true } })],
    ['a 200 that is not JSON', (res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><p>Signed in!</p>')],
    ['a 200 longer than an identity', (res) => sendJson(res, 200, { success: true, user: { ...BEA, id: 'bl-huge' }, padding: 'x'.repeat(20_000) })],
    [
      'a 200 longer than an identity, without saying so',
      (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(`{"success":true,"user":${JSON.stringify({ ...BEA, id: 'bl-huge' })},"padding":"`);
        res.end(`${'x'.repeat(20_000)}"}`);
      },
    ],
    ['the connection dropped', (res) => res.socket?.destroy()],
  ])('%s signs nobody in', async (_label, answer) => {
    stub.answer = answer;
    const { c, res } = await throughUpstream({ ...BEA, id: 'bl-bad-answer' }, '/clubs');
    expect(res.statusCode).toBe(303);
    expect(where(res)).toBe(refusedTo('/clubs'));
    expect(hasSessionCookie(res)).toBe(false);
    expect(await nobody(c)).toBe(true);
    expect(usersWithSubject('bl-huge') + usersWithSubject('bl-bad-answer')).toBe(0);
  });

  it('an exchange that does not answer in time signs nobody in, and the server keeps answering', async () => {
    setUpstreamLimits(t.ctx, { exchangeMs: 300 });
    const held: ServerResponse[] = [];
    stub.answer = (res) => held.push(res);
    try {
      const started = Date.now();
      const { res } = await throughUpstream({ ...BEA, id: 'bl-slow-exchange' });
      expect(where(res)).toBe(refusedTo('/'));
      expect(Date.now() - started).toBeLessThan(5000);
      expect((await t.client().get('/api/session')).statusCode).toBe(200);
    } finally {
      setUpstreamLimits(t.ctx, UPSTREAM_LIMITS);
      for (const res of held) res.destroy();
    }
    expect(usersWithSubject('bl-slow-exchange')).toBe(0);
  });

  it('an exchange that sends it elsewhere is not followed: the code goes to the upstream’s address only', async () => {
    const thief = new StubExchange();
    await thief.listen();
    try {
      thief.answer = (res) => sendJson(res, 200, { success: true, user: { ...BEA, id: 'bl-redirected' } });
      stub.answer = (res) => res.writeHead(307, { location: thief.url }).end();
      const { res } = await throughUpstream({ ...BEA, id: 'bl-redirected' });
      expect(where(res)).toBe(refusedTo('/'));
      expect(thief.asked).toEqual([]);
      expect(usersWithSubject('bl-redirected')).toBe(0);
    } finally {
      await thief.close();
    }
  });

  it.each(['https://evil.example/', '//evil.example/', '/\\evil.example/', 'join/x', '/..//evil.example/', '/%2e%2e//evil.example', '/a/../..//evil.example'])(
    'never leads anywhere but this app: %j',
    async (next) => {
      expect(where((await throughUpstream(BEA, next)).res)).toBe('/');
      const c = t.client();
      const leaving = await leave(c, next);
      expect(where(await c.get(`/api/auth/upstream/callback?state=${leaving.state}&error=failed`))).toBe(refusedTo('/'));
    },
  );

  it('a next with characters beyond ASCII is sent on percent-encoded, not refused', async () => {
    const { res } = await throughUpstream(BEA, '/books/☃?q=é#ü');
    expect(res.statusCode).toBe(303);
    expect(where(res)).toBe('/books/%E2%98%83?q=%C3%A9#%C3%BC');
  });

  it('someone signed in here already just goes on, as who they are', async () => {
    const asked = stub.asked.length;
    const res = await owner.get('/api/auth/upstream?next=%2Fsettings');
    expect(where(res)).toBe('/settings');
    expect(res.setCookies).toEqual([]);
    expect((await me(owner)).email).toBe('cole@example.com');
    // Signed in meanwhile, in another tab: the way back leaves them as they are.
    const c = t.client();
    const leaving = await leave(c, '/clubs');
    c.cookies.set('bc_session', owner.cookies.get('bc_session')!);
    expect(where(await comeBack(c, leaving, { ...BEA, id: 'bl-meanwhile' }))).toBe('/clubs');
    expect((await me(c)).email).toBe('cole@example.com');
    expect(stub.asked).toHaveLength(asked);
  });

  it('another site, or a sibling subdomain, cannot start a sign-in: it lands on the sign-in page', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const c = t.client();
      const res = await c.get('/api/auth/upstream?next=%2Fsettings', { 'sec-fetch-site': site });
      expect(res.statusCode, site).toBe(303);
      expect(where(res), site).toBe('/signin?next=%2Fsettings');
      expect(res.setCookies, site).toEqual([]);
    }
    // From this app's own page, or typed in: to the upstream.
    for (const site of ['same-origin', 'none']) {
      expect(where(await t.client().get('/api/auth/upstream?next=%2Fsettings', { 'sec-fetch-site': site })), site).toMatch(/^https:\/\/id\.example\.com\//);
    }
  });

  it('an account disabled here is refused, and its open sessions too', async () => {
    const dee: UpstreamUser = { id: 'bl-dee', name: 'Dee', email: 'dee@upstream.example', emailVerified: true };
    const { c } = await throughUpstream(dee);
    t.ctx.db.exec('UPDATE users SET disabled_at = ? WHERE id = ?', [Date.now(), (await me(c)).id]);
    expect((await c.get('/api/me')).statusCode).toBe(401);
    const { c: again, res } = await throughUpstream(dee, '/clubs');
    expect(where(res)).toBe(refusedTo('/clubs'));
    expect(hasSessionCookie(res)).toBe(false);
    expect(await nobody(again)).toBe(true);
  });

  it('signing out here signs out here only; Continue goes through the upstream again, and nothing holds the device', async () => {
    const { c } = await throughUpstream();
    const out = await c.post('/api/auth/signout');
    expect(out.statusCode).toBe(204);
    expect(out.setCookies.some((v) => v.startsWith('bc_upstream'))).toBe(false);
    expect(await nobody(c)).toBe(true);
    const back = await leave(c);
    expect(`${back.start.origin}${back.start.pathname}`).toBe(UPSTREAM_START);
    expect(where(await comeBack(c, back))).toBe('/');
    expect((await me(c)).email).toBe('bea@upstream.example');
    // Everywhere: every device out, until each continues again.
    const phone = (await throughUpstream()).c;
    expect((await c.post('/api/auth/signout-everywhere')).statusCode).toBe(204);
    expect(await nobody(phone)).toBe(true);
    expect(where(await comeBack(phone, await leave(phone)))).toBe('/');
    expect(await nobody(phone)).toBe(false);
  });

  it('upstream members manage their name and password upstream, not here', async () => {
    const { c } = await throughUpstream();
    const rename = await c.patch('/api/me', { displayName: 'Someone else' });
    expect(rename.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(rename.json()).error.message).toBe('Your name comes from your main account.');
    expect((await c.json<{ user: { displayName: string } }>(c.patch('/api/me', {}), 200)).user.displayName).toBe('Bea');
    const password = await c.post('/api/me/password', { currentPassword: 'anything at all', newPassword: 'something new here' });
    expect(password.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(password.json()).error.code).toBe('invalid_credentials');
  });

  it('upstream members join a club with its invite link, and the owner cannot issue them a reset link', async () => {
    const { c } = await throughUpstream(BEA, `/join/${club.invite!.code}`);
    const accepted = await c.json<{ clubId: string; joined: boolean }>(c.post(`/api/invites/${club.invite!.code}/accept`), 200);
    expect(accepted).toEqual({ clubId: club.id, joined: true });
    const reset = await owner.post(`/api/clubs/${club.id}/members/${(await me(c)).id}/reset-link`);
    expect(reset.statusCode).toBe(400);
    // Generalised by D178 to cover a native Apple/Google member too, who also has no password here.
    expect(ApiErrorSchema.parse(reset.json()).error.message).toBe('This member has no password here to reset.');
  });

  it('an upstream account may start a club before joining any (D52’s invite-first restriction was reversed: anyone signed in may start a club)', async () => {
    const { c } = await throughUpstream({ id: 'bl-stray', name: 'Stray', email: 'stray@upstream.example', emailVerified: true });
    expect((await c.post('/api/clubs', { name: 'Mine' })).statusCode).toBe(201);
  });

  it('on this machine, the browser keeps the name it came by, 127.0.0.1 or localhost; the upstream’s own address never changes', async () => {
    const loop = await makeTestApp({ UPSTREAM_START_URL: 'http://127.0.0.1:47101/api/auth/book-club/start?client=x', UPSTREAM_EXCHANGE_URL: stub.url });
    try {
      for (const [came, goes] of [
        ['localhost', 'http://localhost:47101/api/auth/book-club/start'],
        ['127.0.0.1', 'http://127.0.0.1:47101/api/auth/book-club/start'],
        ['[::1]', 'http://[::1]:47101/api/auth/book-club/start'],
        ['books.example.org', 'http://127.0.0.1:47101/api/auth/book-club/start'],
      ]) {
        const port = new URL(loop.baseUrl).port;
        const res = await rawRequest(loop.baseUrl, 'GET', '/api/auth/upstream?next=%2F', { host: `${came}:${port}` });
        const start = new URL(String(res.headers.location));
        expect(`${start.origin}${start.pathname}`, came).toBe(goes);
        // Its own query is kept.
        expect(start.searchParams.get('client'), came).toBe('x');
      }
      const port = new URL(t.baseUrl).port;
      const prod = await rawRequest(t.baseUrl, 'GET', '/api/auth/upstream?next=%2F', { host: `localhost:${port}` });
      expect(String(prod.headers.location)).toMatch(/^https:\/\/id\.example\.com\/api\/auth\/book-club\/start\?/);
    } finally {
      await closeApp(loop);
    }
  });
});

describe('the sign-in grant’s edges', () => {
  const stub = new StubExchange();

  beforeAll(async () => {
    await stub.listen();
  });

  afterAll(async () => {
    await stub.close();
  });

  it('without an upstream configured there is nothing to continue with', async () => {
    const t = await makeTestApp();
    try {
      expect(SessionInfoSchema.parse(await t.client().json(t.client().get('/api/session'), 200)).upstream).toBeNull();
      expect((await t.client().get('/api/auth/upstream?next=%2F')).statusCode).toBe(404);
      expect((await t.client().get('/api/auth/upstream/callback?state=x&code=y')).statusCode).toBe(404);
    } finally {
      await closeApp(t);
    }
  });

  it('with the OAuth grant configured but no password address, sign-in refuses a non-local email without asking the upstream for anything', async () => {
    const t = await makeTestApp({ UPSTREAM_START_URL: UPSTREAM_START, UPSTREAM_EXCHANGE_URL: stub.url });
    try {
      const asked = stub.asked.length;
      const res = await t.client().post('/api/auth/signin', { email: 'nobody-here@example.com', password: 'whatever it is' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'invalid_credentials', message: 'That email and password do not match.' } });
      // Nothing of this reached the stub exchange: there is no password address to ask.
      expect(stub.asked).toHaveLength(asked);
    } finally {
      await closeApp(t);
    }
  });

  it('over HTTPS the sign-in under way is a __Host- cookie, and one a sibling subdomain could plant is not read', async () => {
    const t = await makeTestApp({ PUBLIC_ORIGIN: 'https://books.example.org', UPSTREAM_START_URL: UPSTREAM_START, UPSTREAM_EXCHANGE_URL: stub.url });
    try {
      const c = t.client();
      const res = await c.get('/api/auth/upstream?next=%2F');
      const cookie = res.setCookies.find((v) => v.startsWith('__Host-bc_upstream='))!;
      expect(cookie).toMatch(/; Secure/i);
      expect(cookie).toMatch(/; Path=\/(;|$)/);
      expect(cookie).not.toMatch(/Domain=/i);
      expect(res.setCookies.some((v) => v.startsWith('bc_upstream='))).toBe(false);
      // A sibling's planted sign-in, the way it would write one, with a state it knows.
      const state = newCode();
      const verifier = newCode();
      const planted = Buffer.from(JSON.stringify({ state, verifier, next: '/', expires: Date.now() + 60_000 })).toString('base64url');
      const victim = t.client();
      victim.cookies.set('bc_upstream', planted);
      const code = newCode();
      stub.grants.set(code, { challenge: s256(verifier), user: { ...BEA, id: 'bl-planted' } });
      const back = await victim.get(`/api/auth/upstream/callback?state=${state}&code=${code}`);
      expect(back.headers.location).toBe(refusedTo('/'));
      expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE upstream_subject = 'upstream:bl-planted'")!.n).toBe(0);
    } finally {
      await closeApp(t);
    }
  });

  it('a run of failed sign-ins from one address stops before it reaches the upstream, whose budget all of Book Club shares; sign-ins that work are not counted', async () => {
    const t = await makeTestApp({ UPSTREAM_START_URL: UPSTREAM_START, UPSTREAM_EXCHANGE_URL: stub.url, SIGNIN_ATTEMPTS: '3' });
    try {
      const attempt = async (good: boolean): Promise<string> => {
        const c = t.client();
        const res = await c.get('/api/auth/upstream?next=%2F');
        const start = new URL(String(res.headers.location));
        const code = newCode();
        if (good) stub.grants.set(code, { challenge: start.searchParams.get('code_challenge')!, user: { ...BEA, id: 'bl-burst' } });
        return String((await c.get(`/api/auth/upstream/callback?state=${start.searchParams.get('state')}&code=${code}`)).headers.location);
      };
      // Everyone behind one address (a household, the demo stack) signs in as often as they like.
      for (let i = 0; i < 5; i++) expect(await attempt(true)).toBe('/');
      expect(await attempt(false)).toBe(refusedTo('/'));
      expect(await attempt(false)).toBe(refusedTo('/'));
      expect(await attempt(true)).toBe('/');
      expect(await attempt(false)).toBe(refusedTo('/'));
      const asked = stub.asked.length;
      // Three that failed in the window: the next is not even asked about, good or not.
      expect(await attempt(true)).toBe(refusedTo('/'));
      expect(await attempt(false)).toBe(refusedTo('/'));
      expect(stub.asked).toHaveLength(asked);
    } finally {
      await closeApp(t);
    }
  });

  it('refusals are logged, and no line holds the code, the verifier or the cookie', async () => {
    const lines: string[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-upstream-log-'));
    let built: BuiltApp | null = null;
    try {
      built = await buildApp({
        config: loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, SCRYPT_LOG_N: '12', UPSTREAM_START_URL: UPSTREAM_START, UPSTREAM_EXCHANGE_URL: stub.url }),
        logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
        background: false,
      });
      const baseUrl = await built.app.listen({ host: '127.0.0.1', port: 0 });
      const secrets: string[] = [];
      const flight = async (answer: ((res: ServerResponse) => void) | null, state?: string): Promise<string> => {
        const c = new Client(baseUrl);
        const start = new URL(String((await c.get('/api/auth/upstream?next=%2F')).headers.location));
        const code = newCode();
        stub.answer = answer;
        stub.grants.set(code, { challenge: start.searchParams.get('code_challenge')!, user: { ...BEA, id: 'bl-logged' } });
        secrets.push(code, c.cookies.get('bc_upstream')!);
        const res = await c.get(`/api/auth/upstream/callback?state=${state ?? start.searchParams.get('state')}&code=${code}`);
        stub.answer = null;
        return String(res.headers.location);
      };
      expect(await flight(null, newCode())).toBe(refusedTo('/'));
      expect(await flight((res) => sendJson(res, 403, { success: false, error: 'suspended' }))).toBe(refusedTo('/'));
      expect(await flight(null)).toBe('/');
      for (const asked of stub.asked.slice(-2)) secrets.push(String(asked.body.codeVerifier));
      const entries = lines.map((line) => JSON.parse(line) as { level: number; msg: string; reason?: string; status?: number; req?: { url: string } });
      expect(entries.filter((e) => e.msg === 'upstream sign-in refused').map((e) => [e.level, e.reason, e.status])).toEqual([
        [40, 'not the state this device left with', undefined],
        [40, 'the exchange did not redeem the code', 403],
      ]);
      expect(entries.some((e) => e.req?.url.startsWith('/api/auth/upstream/callback?state=[redacted]&code=[redacted]'))).toBe(true);
      const log = lines.join('');
      for (const secret of secrets) expect(log).not.toContain(secret);
    } finally {
      built?.app.server.closeAllConnections();
      await built?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A browser's cookies at the stand-in (its session, its transaction), sent back as a browser would. */
class Jar {
  readonly cookies = new Map<string, string>();

  async fetch(url: string, init: { method?: string; body?: URLSearchParams | string; headers?: Record<string, string> } = {}): Promise<Response> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...init.headers, ...(cookie ? { cookie } : {}) } });
    for (const raw of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = raw.split(';');
      const name = pair.slice(0, pair.indexOf('=')).trim();
      const value = pair.slice(pair.indexOf('=') + 1).trim();
      if (value === '' || attrs.some((a) => /^\s*max-age=0$/i.test(a))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
}

const STAND_IN_PASSWORD_SECRET = 'upstream-stand-in-password-secret-fixture';

describe('with the upstream stand-in (tools/fake-upstream): the whole grant over HTTP', () => {
  const callbacks: string[] = [];
  let clock: number | null = null;
  const upstream = createFakeUpstream({ callbacks, now: () => clock ?? Date.now(), passwordSecret: STAND_IN_PASSWORD_SECRET });
  let upstreamUrl: string;
  let t: TestApp;
  let club: ClubDetail;

  beforeAll(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    t = await makeTestApp({
      UPSTREAM_START_URL: `${upstreamUrl}/api/auth/book-club/start`,
      UPSTREAM_EXCHANGE_URL: `${upstreamUrl}/api/auth/book-club/exchange`,
      UPSTREAM_PASSWORD_URL: `${upstreamUrl}/api/auth/book-club/password`,
      UPSTREAM_PASSWORD_SECRET: STAND_IN_PASSWORD_SECRET,
      UPSTREAM_NAME: 'Upstream ID',
    });
    const port = new URL(t.baseUrl).port;
    callbacks.push(`${t.baseUrl}/api/auth/upstream/callback`, `http://localhost:${port}/api/auth/upstream/callback`);
    ({ club } = await setupOwner(t));
  });

  afterEach(() => {
    clock = null;
  });

  afterAll(async () => {
    await closeApp(t);
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });

  /**
   * What a browser does: Continue with Upstream ID, follow it there, sign in on its form if it shows
   * one, and come back. Returns the answer of the way back, and whether the form was shown.
   */
  async function throughUpstream(c: Client, jar: Jar, email: string, next = '/'): Promise<{ back: Res; sawForm: boolean; callback: string }> {
    let url = String((await c.get(`/api/auth/upstream?next=${encodeURIComponent(next)}`)).headers.location);
    expect(url.startsWith(`${upstreamUrl}/api/auth/book-club/start?`)).toBe(true);
    let sawForm = false;
    for (let hops = 0; new URL(url).origin === upstreamUrl; hops++) {
      expect(hops).toBeLessThan(6);
      const res = await jar.fetch(url);
      if (res.status === 303) {
        url = new URL(res.headers.get('location')!, url).href;
        continue;
      }
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Sign in to Upstream ID');
      sawForm = true;
      const returnTo = new URL(url).searchParams.get('returnTo')!;
      const signedIn = await jar.fetch(`${upstreamUrl}/login`, { method: 'POST', body: new URLSearchParams({ email, password: DEMO_PASSWORD, returnTo }) });
      expect(signedIn.status).toBe(303);
      expect(signedIn.headers.get('location')).toBe(returnTo);
      url = returnTo;
    }
    const back = new URL(url);
    expect(`${back.origin}${back.pathname}`).toBe(`${t.baseUrl}/api/auth/upstream/callback`);
    return { back: await c.get(`${back.pathname}${back.search}`), sawForm, callback: url };
  }

  const session = async (c: Client) => SessionInfoSchema.parse(await c.json(c.get('/api/session'), 200)).user;
  const exchange = (body: unknown, contentType = 'application/json') =>
    fetch(`${upstreamUrl}/api/auth/book-club/exchange`, { method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  /** A code from the stand-in for Dana, as Book Club's server would receive it, and its verifier. */
  async function codeFor(email: string): Promise<{ code: string; verifier: string }> {
    const jar = new Jar();
    await jar.fetch(`${upstreamUrl}/login`, { method: 'POST', body: new URLSearchParams({ email, password: DEMO_PASSWORD, returnTo: '' }) });
    const verifier = newCode();
    await jar.fetch(`${upstreamUrl}/api/auth/book-club/start?state=${newCode()}&code_challenge=${s256(verifier)}&code_challenge_method=S256`);
    const back = new URL(String((await jar.fetch(`${upstreamUrl}/api/auth/book-club/complete`)).headers.get('location')));
    return { code: back.searchParams.get('code')!, verifier };
  }

  it('signs an upstream account in here, named and addressed as the upstream has it, through its sign-in page', async () => {
    const c = t.client();
    const jar = new Jar();
    const { back, sawForm } = await throughUpstream(c, jar, 'Dana@upstream.test', '/settings');
    expect(sawForm).toBe(true);
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe('/settings');
    expect(await session(c)).toMatchObject({ displayName: 'Dana', email: 'dana@upstream.test', source: 'upstream' });
    const subject = `upstream:${account('dana@upstream.test')!.userId}`;
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE upstream_subject = ?', [subject])!.n).toBe(1);
    // The upstream's session is its own: a cookie on its host, which Book Club never reads.
    expect(jar.cookies.has(SESSION_COOKIE)).toBe(true);
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it('signed out here but still signed in at the upstream, Continue brings the person back through the upstream with no form', async () => {
    const c = t.client();
    const jar = new Jar();
    expect((await throughUpstream(c, jar, 'eli@upstream.test')).sawForm).toBe(true);
    expect((await c.post('/api/auth/signout')).statusCode).toBe(204);
    expect(await session(c)).toBeNull();
    const again = await throughUpstream(c, jar, 'eli@upstream.test');
    expect(again.sawForm).toBe(false);
    expect(again.back.headers.location).toBe('/');
    expect(await session(c)).toMatchObject({ displayName: 'Eli' });
  });

  it('a deactivated upstream account is turned away (error=failed), and nothing is created', async () => {
    const c = t.client();
    const { back, callback } = await throughUpstream(c, new Jar(), 'gus@upstream.test', '/clubs');
    expect(new URL(callback).searchParams.get('error')).toBe('failed');
    expect(new URL(callback).searchParams.has('code')).toBe(false);
    expect(back.headers.location).toBe(refusedTo('/clubs'));
    expect(await session(c)).toBeNull();
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE display_name = 'Gus'")!.n).toBe(0);
  });

  it('an address the upstream has not verified is left out', async () => {
    const c = t.client();
    await throughUpstream(c, new Jar(), 'unverified.una@upstream.test');
    expect(await session(c)).toMatchObject({ displayName: 'Unverified', email: null, source: 'upstream' });
  });

  it('a way back replayed, in this browser or another, signs nobody in', async () => {
    const c = t.client();
    const { callback } = await throughUpstream(c, new Jar(), 'replay@upstream.test');
    const back = new URL(callback);
    expect((await c.post('/api/auth/signout')).statusCode).toBe(204);
    for (const browser of [c, t.client()]) {
      expect((await browser.get(`${back.pathname}${back.search}`)).headers.location).toBe(refusedTo('/'));
      expect(await session(browser)).toBeNull();
    }
  });

  it('the stand-in redeems a code once, with the verifier of its challenge, within 90 seconds', async () => {
    const dana = await codeFor('dana@upstream.test');
    expect((await exchange({ code: dana.code, codeVerifier: newCode() })).status).toBe(400);
    const ok = await exchange({ code: dana.code, codeVerifier: dana.verifier });
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie()).toEqual([]);
    const who = account('dana@upstream.test')!;
    expect(await ok.json()).toEqual({ success: true, user: { id: who.userId, name: 'Dana', email: 'dana@upstream.test', emailVerified: true } });
    expect((await exchange({ code: dana.code, codeVerifier: dana.verifier })).status).toBe(400);
    const late = await codeFor('dana@upstream.test');
    clock = Date.now() + 91_000;
    expect((await exchange({ code: late.code, codeVerifier: late.verifier })).status).toBe(400);
    clock = null;
    expect((await exchange({ code: newCode(), codeVerifier: newCode() })).status).toBe(400);
    expect((await exchange({ code: late.code })).status).toBe(400);
    expect((await exchange('{not json')).status).toBe(400);
    expect((await exchange(`code=${late.code}&codeVerifier=${late.verifier}`, 'application/x-www-form-urlencoded')).status).toBe(400);
    const refused = await exchange({ code: newCode(), codeVerifier: newCode() });
    expect(await refused.json()).toEqual({ success: false, error: 'Sign-in expired or could not be verified. Start again.' });
  });

  it('the stand-in starts only a sign-in the upstream would', async () => {
    const challenge = s256(newCode());
    for (const query of [
      `state=short&code_challenge=${challenge}&code_challenge_method=S256`,
      `state=${newCode()}&code_challenge=not-one&code_challenge_method=S256`,
      `state=${newCode()}&code_challenge=${challenge}&code_challenge_method=plain`,
      `state=${newCode()}&code_challenge=${challenge}`,
    ]) {
      expect((await fetch(`${upstreamUrl}/api/auth/book-club/start?${query}`, { redirect: 'manual' })).status, query).toBe(400);
    }
    const ok = await fetch(`${upstreamUrl}/api/auth/book-club/start?state=${newCode()}&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: 'manual' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/login?returnTo=${encodeURIComponent(`${upstreamUrl}/api/auth/book-club/complete`)}`);
  });

  it('the stand-in sends the browser back by the name it came by, and says error=failed alone once it lost the sign-in', async () => {
    const port = new URL(upstreamUrl).port;
    const jar = new Jar();
    await jar.fetch(`${upstreamUrl}/login`, { method: 'POST', body: new URLSearchParams({ email: 'dana@upstream.test', password: DEMO_PASSWORD, returnTo: '' }) });
    await jar.fetch(`${upstreamUrl}/api/auth/book-club/start?state=${newCode()}&code_challenge=${s256(newCode())}&code_challenge_method=S256`);
    const cookie = [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const byName = await rawRequest(upstreamUrl, 'GET', '/api/auth/book-club/complete', { host: `localhost:${port}`, cookie });
    const back = new URL(String(byName.headers.location));
    expect(`${back.origin}${back.pathname}`).toBe(`http://localhost:${new URL(t.baseUrl).port}/api/auth/upstream/callback`);
    expect(back.searchParams.has('code')).toBe(true);
    // The browser no longer has the transaction (cleared, or never sent): the upstream cannot know the state.
    for (const name of [...jar.cookies.keys()]) if (name !== SESSION_COOKIE) jar.cookies.delete(name);
    const lost = new URL(String((await jar.fetch(`${upstreamUrl}/api/auth/book-club/complete`)).headers.get('location')));
    expect(`${lost.origin}${lost.pathname}`).toBe(`${t.baseUrl}/api/auth/upstream/callback`);
    expect([...lost.searchParams]).toEqual([['error', 'failed']]);
  });

  it('the stand-in sends nobody back to an address not its own', async () => {
    const res = await fetch(`${upstreamUrl}/login?returnTo=${encodeURIComponent('https://evil.example/')}`);
    expect(res.status).toBe(400);
    const post = await fetch(`${upstreamUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ email: 'dana@upstream.test', password: DEMO_PASSWORD, returnTo: 'https://evil.example/' }),
    });
    expect(post.headers.get('location')).toBe('/');
    const wrong = await fetch(`${upstreamUrl}/login`, { method: 'POST', body: new URLSearchParams({ email: 'dana@upstream.test', password: 'not it' }) });
    expect(wrong.status).toBe(401);
  });

  it('the stand-in signs nobody in from another site’s page', async () => {
    const body = new URLSearchParams({ email: 'dana@upstream.test', password: DEMO_PASSWORD, returnTo: '' });
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      const res = await fetch(`${upstreamUrl}/login`, { method: 'POST', redirect: 'manual', headers, body });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    const own = await fetch(`${upstreamUrl}/login`, { method: 'POST', redirect: 'manual', headers: { origin: upstreamUrl, 'sec-fetch-site': 'same-origin' }, body });
    expect(own.status).toBe(303);
  });

  describe('an upstream password, typed into this app’s own form (D173)', () => {
    const wrongCreds = { error: { code: 'invalid_credentials', message: 'That email and password do not match.' } };

    it('signs an upstream account in with no bounce to its page: the same identity the OAuth grant would give', async () => {
      const c = t.client();
      const res = await c.post('/api/auth/signin', { email: 'Dana@Upstream.test', password: DEMO_PASSWORD });
      expect(res.statusCode).toBe(200);
      expect(await session(c)).toMatchObject({ displayName: 'Dana', email: 'dana@upstream.test', source: 'upstream' });
      const subject = `upstream:${account('dana@upstream.test')!.userId}`;
      expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE upstream_subject = ?', [subject])!.n).toBe(1);
    });

    it('a wrong password is refused the same way a wrong local password is, not an upstream-specific message', async () => {
      const c = t.client();
      const res = await c.post('/api/auth/signin', { email: 'dana@upstream.test', password: 'not it' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(wrongCreds);
      expect(await session(c)).toBeNull();
    });

    it('an unknown address is refused the same generic message, never asking the upstream for it', async () => {
      const c = t.client();
      const res = await c.post('/api/auth/signin', { email: `${randomBytes(8).toString('hex')}@not-upstream.example`, password: 'whatever' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(wrongCreds);
    });

    it('a deactivated upstream account’s password is refused, and no row for it is created', async () => {
      const c = t.client();
      const res = await c.post('/api/auth/signin', { email: 'gus@upstream.test', password: DEMO_PASSWORD });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(wrongCreds);
      expect(await session(c)).toBeNull();
      expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE display_name = 'Gus'")!.n).toBe(0);
    });

    it('the same account the OAuth grant made is who the password signs in, not a second one', async () => {
      const { back } = await throughUpstream(t.client(), new Jar(), 'parity@upstream.test');
      expect(back.statusCode).toBe(303);
      const bySubject = t.ctx.db.get<{ id: string }>('SELECT id FROM users WHERE upstream_subject = ?', [`upstream:${account('parity@upstream.test')!.userId}`])!;
      const c = t.client();
      await c.post('/api/auth/signin', { email: 'parity@upstream.test', password: DEMO_PASSWORD });
      expect((await session(c))!.id).toBe(bySubject.id);
      expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = 'parity@upstream.test'")!.n).toBe(1);
    });

    it('a local account’s own password is checked, never the upstream’s, even sharing an upstream email', async () => {
      // A fresh address the earlier tests above never touch: an upstream account of this name
      // exists (any @upstream.test address does, fake-upstream/server.mjs), but no Book Club
      // account has used it yet, local or upstream.
      const email = 'local-first@upstream.test';
      const c = t.client();
      await c.post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: 'Local First', email, password: 'a password of her own here' });
      await c.post('/api/auth/signout');
      // Her Book Club password signs her in; the upstream's own password for the same address does not.
      const own = await c.post('/api/auth/signin', { email, password: 'a password of her own here' });
      expect(own.statusCode).toBe(200);
      await c.post('/api/auth/signout');
      const theirs = await c.post('/api/auth/signin', { email, password: DEMO_PASSWORD });
      expect(theirs.statusCode).toBe(401);
      // One row for the address, local, never joined by an upstream one.
      expect(t.ctx.db.get<{ n: number; upstream: number }>(
        "SELECT COUNT(*) AS n, SUM(upstream_subject IS NOT NULL) AS upstream FROM users WHERE email = ?", [email],
      )).toEqual({ n: 1, upstream: 0 });
    });

    it('a run of wrong upstream passwords from one address stops before it asks the upstream, sharing the same limiter local sign-ins use', async () => {
      const limited = await makeTestApp({
        UPSTREAM_START_URL: `${upstreamUrl}/api/auth/book-club/start`,
        UPSTREAM_EXCHANGE_URL: `${upstreamUrl}/api/auth/book-club/exchange`,
        UPSTREAM_PASSWORD_URL: `${upstreamUrl}/api/auth/book-club/password`,
        UPSTREAM_PASSWORD_SECRET: STAND_IN_PASSWORD_SECRET,
        SIGNIN_ATTEMPTS: '3',
      });
      try {
        const c = limited.client();
        for (let i = 0; i < 3; i++) expect((await c.post('/api/auth/signin', { email: 'dana@upstream.test', password: 'nope' })).statusCode).toBe(401);
        const fourth = await c.post('/api/auth/signin', { email: 'dana@upstream.test', password: DEMO_PASSWORD });
        expect(fourth.statusCode).toBe(429);
      } finally {
        await closeApp(limited);
      }
    });

    it.each<[string, (res: ServerResponse) => void]>([
      ['a 500', (res) => { res.writeHead(500); res.end(); }],
      ['a 200 that is not JSON', (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('not json')],
      ['a 200 without a code', (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true }))],
      ['a 200 longer than a code', (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, code: 'x', padding: 'y'.repeat(20_000) }))],
      ['the connection dropped', (res) => res.socket?.destroy()],
    ])('a password endpoint that answers with %s refuses the sign-in, not a 500', async (_label, answer) => {
      const bad = createServer((_req, res) => answer(res));
      await new Promise<void>((resolve) => bad.listen(0, '127.0.0.1', resolve));
      const badUrl = `http://127.0.0.1:${(bad.address() as AddressInfo).port}`;
      const broken = await makeTestApp({
        UPSTREAM_START_URL: `${upstreamUrl}/api/auth/book-club/start`,
        UPSTREAM_EXCHANGE_URL: `${upstreamUrl}/api/auth/book-club/exchange`,
        UPSTREAM_PASSWORD_URL: badUrl,
        UPSTREAM_PASSWORD_SECRET: STAND_IN_PASSWORD_SECRET,
      });
      try {
        const res = await broken.client().post('/api/auth/signin', { email: 'dana@upstream.test', password: DEMO_PASSWORD });
        expect(res.statusCode).toBe(401);
      } finally {
        await closeApp(broken);
        bad.closeAllConnections();
        await new Promise((resolve) => bad.close(resolve));
      }
    });

    it('a password endpoint that never answers refuses the sign-in once its own budget runs out, not forever', async () => {
      const held: ServerResponse[] = [];
      const bad = createServer((_req, res) => held.push(res));
      await new Promise<void>((resolve) => bad.listen(0, '127.0.0.1', resolve));
      const badUrl = `http://127.0.0.1:${(bad.address() as AddressInfo).port}`;
      const broken = await makeTestApp({
        UPSTREAM_START_URL: `${upstreamUrl}/api/auth/book-club/start`,
        UPSTREAM_EXCHANGE_URL: `${upstreamUrl}/api/auth/book-club/exchange`,
        UPSTREAM_PASSWORD_URL: badUrl,
        UPSTREAM_PASSWORD_SECRET: STAND_IN_PASSWORD_SECRET,
      });
      setUpstreamLimits(broken.ctx, { exchangeMs: 300 });
      try {
        const started = Date.now();
        const res = await broken.client().post('/api/auth/signin', { email: 'dana@upstream.test', password: DEMO_PASSWORD });
        expect(res.statusCode).toBe(401);
        expect(Date.now() - started).toBeLessThan(5000);
      } finally {
        setUpstreamLimits(broken.ctx, UPSTREAM_LIMITS);
        for (const res of held) res.destroy();
        await closeApp(broken);
        bad.closeAllConnections();
        await new Promise((resolve) => bad.close(resolve));
      }
    });
  });
});
