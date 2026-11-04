import { createHash } from 'node:crypto';
import { type Server, type ServerResponse, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { SessionInfoSchema, type ClubDetail } from '@bookclub/shared';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Client, type Res, type TestApp, closeApp, makeTestApp, openSocket, setupOwner } from './helpers';

/*
 * "Continue with Google" (D178): the server-side authorization-code-with-PKCE flow, against a
 * local HTTP stand-in for Google's token endpoint and its JWKS (GOOGLE_TOKEN_URL, GOOGLE_JWKS_URL
 * — the same env-configurable addresses the demo stack points at `tools/fake-google` with) —
 * never the real accounts.google.com or oauth2.googleapis.com.
 */

/** Avoids naming `CryptoKey` directly: this project's tsconfig has no `lib: ["dom"]`, where that name is a type; without it, `@types/node`'s own global of the same name is a value instead. */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const CLIENT_ID = 'book-club-test.apps.googleusercontent.com';
const REDIRECT_URI = 'https://books.example/api/auth/google/callback';
const ISSUER = 'https://accounts.google.com';
const KID = 'test-google-key';

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

interface GoogleUser {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Google's token endpoint and JWKS as a test plays them, on one real local HTTP server: a code
 * registered ahead of time redeems once, with its own challenge's verifier, and `/jwks` serves
 * whatever JWK this test gave it — a real network round trip (`createRemoteJWKSet`), the same
 * path a deployment pointed at `tools/fake-google` takes.
 */
class StubGoogleToken {
  readonly grants = new Map<string, { readonly challenge: string; readonly idToken: string }>();
  answer: ((res: ServerResponse) => void) | null = null;
  jwks: unknown = { keys: [] };
  url = '';
  jwksUrl = '';
  readonly server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/jwks') {
      sendJson(res, 200, this.jwks);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (this.answer) {
        this.answer(res);
        return;
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const code = form.get('code') ?? '';
      const verifier = form.get('code_verifier') ?? '';
      const grant = this.grants.get(code);
      if (!grant || s256(verifier) !== grant.challenge) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      this.grants.delete(code);
      sendJson(res, 200, { id_token: grant.idToken, access_token: 'unused', token_type: 'Bearer' });
    });
  });

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}/token`;
    this.jwksUrl = `http://127.0.0.1:${port}/jwks`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

describe('"Continue with Google" (D178)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let privateKey: PrivateKey;
  const stub = new StubGoogleToken();

  async function googleIdToken(user: GoogleUser, overrides: { aud?: string; iss?: string; exp?: string } = {}): Promise<string> {
    const payload: Record<string, unknown> = {};
    if (user.email !== undefined) payload.email = user.email;
    if (user.email_verified !== undefined) payload.email_verified = user.email_verified;
    if (user.name !== undefined) payload.name = user.name;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer(overrides.iss ?? ISSUER)
      .setAudience(overrides.aud ?? CLIENT_ID)
      .setSubject(user.sub)
      .setIssuedAt()
      .setExpirationTime(overrides.exp ?? '10m')
      .sign(privateKey);
  }

  beforeAll(async () => {
    const { publicKey, privateKey: sk } = await generateKeyPair('ES256', { extractable: true });
    privateKey = sk;
    const jwk = await exportJWK(publicKey);
    jwk.kid = KID;
    jwk.alg = 'ES256';
    await stub.listen();
    stub.jwks = { keys: [jwk] };
    t = await makeTestApp({
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'test-secret-value',
      GOOGLE_REDIRECT_URI: REDIRECT_URI,
      GOOGLE_TOKEN_URL: stub.url,
      GOOGLE_JWKS_URL: stub.jwksUrl,
      GOOGLE_ISSUERS: ISSUER,
      SIGNIN_ATTEMPTS: '1000',
    });
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

  const where = (res: Res) => res.headers.location ?? '';

  /** `/api/auth/google/start`: the browser's own leg, and what it carries back (state, challenge). */
  async function leave(c: Client, params: Record<string, string> = {}): Promise<{ res: Res; start: URL }> {
    const query = new URLSearchParams(params);
    const res = await c.get(`/api/auth/google/start?${query.toString()}`);
    expect(res.statusCode).toBe(303);
    return { res, start: new URL(where(res)) };
  }

  /** Google signed `user` in: register an id_token for the challenge this leg left with, and come back. */
  async function comeBack(c: Client, start: URL, user: GoogleUser, idTokenOverride?: string): Promise<Res> {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    stub.grants.set(code, { challenge: start.searchParams.get('code_challenge')!, idToken: idTokenOverride ?? (await googleIdToken(user)) });
    return c.get(`/api/auth/google/callback?state=${start.searchParams.get('state')}&code=${code}`);
  }

  it('is off (404 on start) when the three GOOGLE_* settings are not all present', async () => {
    const off = await makeTestApp({});
    expect((await off.client().get('/api/auth/google/start')).statusCode).toBe(404);
    expect((await off.client().get('/api/auth/google/callback')).statusCode).toBe(404);
    const session = SessionInfoSchema.parse(await off.client().json(off.client().get('/api/session'), 200));
    expect(session.providers).toEqual({ apple: false, google: false });
    await closeApp(off);
  });

  it('says providers.google is true once configured', async () => {
    const session = SessionInfoSchema.parse(await owner.json(owner.get('/api/session'), 200));
    expect(session.providers).toEqual({ apple: false, google: true });
  });

  it('sends the browser to Google with a state and a PKCE challenge, and keeps the flight in a cookie of its own', async () => {
    const { res, start } = await leave(t.client(), { next: '/clubs/x' });
    expect(`${start.origin}${start.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(start.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(start.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(start.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = res.setCookies.find((v) => v.startsWith('bc_google='))!;
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
  });

  it('another site, or a sibling subdomain, cannot start a sign-in: it lands on the sign-in page (PR #25 review)', async () => {
    // The same guard GET /api/auth/upstream has (upstream.test.ts's own version of this test);
    // this route had none at all.
    for (const site of ['cross-site', 'same-site']) {
      const c = t.client();
      const res = await c.get('/api/auth/google/start?next=%2Fsettings', { 'sec-fetch-site': site });
      expect(res.statusCode, site).toBe(303);
      expect(where(res), site).toBe('/signin?next=%2Fsettings');
      expect(res.setCookies, site).toEqual([]);
    }
    // From this app's own page, or typed in, or (for the app) no Sec-Fetch-Site at all — a
    // user-initiated top navigation, which is what ASWebAuthenticationSession sends: to Google.
    for (const site of ['same-origin', 'none', undefined]) {
      const headers = site === undefined ? undefined : { 'sec-fetch-site': site };
      const res = await t.client().get('/api/auth/google/start?next=%2Fsettings', headers);
      expect(where(res), String(site)).toMatch(/^https:\/\/accounts\.google\.com\//);
    }
  });

  it('signs a new person in from a browser, and goes on to next', async () => {
    const c = t.client();
    const { start } = await leave(c, { next: '/clubs/x' });
    const res = await comeBack(c, start, { sub: 'google-ana', email: 'ana@google.example', email_verified: true, name: 'Ana G' });
    expect(res.statusCode).toBe(303);
    expect(where(res)).toBe('/clubs/x');
    expect(res.setCookies.some((v) => /^(__Host-)?bc_session=[^;]/.test(v))).toBe(true);
    const me = await c.json<{ user: { displayName: string; email: string | null; source: string } }>(c.get('/api/me'), 200);
    expect(me.user).toMatchObject({ displayName: 'Ana G', email: 'ana@google.example', source: 'google' });
  });

  it('signs in with no email at all reported unverified, just with no address on file', async () => {
    const c = t.client();
    const { start } = await leave(c);
    await comeBack(c, start, { sub: 'google-no-email', email: 'ghost@google.example', email_verified: false });
    const me = await c.json<{ user: { email: string | null } }>(c.get('/api/me'), 200);
    expect(me.user.email).toBeNull();
  });

  it('refuses when Google reports an error', async () => {
    const c = t.client();
    const { start } = await leave(c, { next: '/x' });
    const res = await c.get(`/api/auth/google/callback?state=${start.searchParams.get('state')}&error=access_denied`);
    expect(where(res)).toBe('/signin?google=refused&next=%2Fx');
  });

  it('refuses a state that does not match this device’s flight', async () => {
    const c = t.client();
    await leave(c);
    const res = await c.get('/api/auth/google/callback?state=not-the-real-state&code=whatever');
    expect(where(res)).toContain('google=refused');
  });

  it('refuses once the flight has expired', async () => {
    const c = t.client();
    const { start } = await leave(c);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    const res = await comeBack(c, start, { sub: 'google-late' });
    expect(where(res)).toContain('google=refused');
  });

  it('refuses an id_token for the wrong audience', async () => {
    const c = t.client();
    const { start } = await leave(c);
    const res = await comeBack(c, start, { sub: 'google-badaud' }, await googleIdToken({ sub: 'google-badaud' }, { aud: 'someone-elses-client-id' }));
    expect(where(res)).toContain('google=refused');
  });

  it('refuses an id_token from the wrong issuer', async () => {
    const c = t.client();
    const { start } = await leave(c);
    const res = await comeBack(c, start, { sub: 'google-badiss' }, await googleIdToken({ sub: 'google-badiss' }, { iss: 'https://not-google.example' }));
    expect(where(res)).toContain('google=refused');
  });

  it('links to an existing local password account on a verified email: clears the password, revokes its sessions and closes its live sockets (PR #25 review)', async () => {
    const dave = t.client();
    await dave.post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: 'Dave', email: 'dave2@example.com', password: 'correct horse battery' });
    const socket = await openSocket(t, dave);
    socket.send({ type: 'subscribe', clubId: club.id });

    const c = t.client();
    const { start } = await leave(c);
    await comeBack(c, start, { sub: 'google-dave', email: 'dave2@example.com', email_verified: true });
    expect((await dave.get('/api/me')).statusCode).toBe(401);
    expect((await c.get('/api/me')).statusCode).toBe(200);
    // The provider proved the email: source is `google` now, not still `local` with the password
    // just bypassed (PR #25 review — password_hash left in place let the pre-registrar keep
    // durable password access after the real owner linked).
    expect((await c.json<{ user: { source: string } }>(c.get('/api/me'), 200)).user.source).toBe('google');
    expect(await socket.closed).toEqual({ code: 4001, reason: 'signed out' });
    const replay = await t.client().post('/api/auth/signin', { email: 'dave2@example.com', password: 'correct horse battery' });
    expect(replay.statusCode).toBe(401);
  });

  describe('the app’s own handoff (D178)', () => {
    const APP_VERIFIER = 'a-verifier-the-app-generated-abcdefghijklmnop01';
    const appChallenge = (verifier: string) => s256(verifier);

    it('needs a PKCE challenge to start the app flow', async () => {
      const res = await t.client().get('/api/auth/google/start?app=1');
      expect(res.statusCode).toBe(400);
    });

    it('still runs the app flow when a Book Club session is already open in this browser (PR #25 review)', async () => {
      // ASWebAuthenticationSession shares Safari's cookies by default: a Book Club session
      // already signed in there must not make `start` take its usual "signed in already, go on
      // to next" shortcut — the native engine would then get no `bookclub://auth` code at all,
      // and the WebView would stay signed out.
      const c = t.client();
      await c.post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: 'Finch', email: `finch-${Math.random().toString(36).slice(2)}@example.com`, password: 'correct horse battery' });
      expect((await c.get('/api/me')).statusCode).toBe(200);
      const res = await c.get(`/api/auth/google/start?app=1&challenge=${appChallenge(APP_VERIFIER)}`);
      expect(res.statusCode).toBe(303);
      const start = new URL(where(res));
      expect(`${start.origin}${start.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      // Still signed in as Finch here: the app's flow runs in its own ephemeral browser session,
      // which does not touch this one's cookie.
      expect((await c.get('/api/me')).statusCode).toBe(200);
    });

    /** `bookclub://auth?code=…`, the custom scheme Expo's `WebBrowser.openAuthSessionAsync` is told to catch; `new URL` on a non-special scheme is not worth trusting here, so a plain string match does the job. */
    const codeFrom = (location: string): string | null => /^bookclub:\/\/auth\?code=([^&]+)$/.exec(location)?.[1] ?? null;

    it('hands the app a one-time code at bookclub://auth instead of a session cookie', async () => {
      const c = t.client();
      const { start } = await leave(c, { app: '1', challenge: appChallenge(APP_VERIFIER) });
      const res = await comeBack(c, start, { sub: 'google-app-1', email: 'app1@google.example', email_verified: true });
      expect(res.statusCode).toBe(303);
      expect(codeFrom(where(res))).toBeTruthy();
      // Not signed in on this (ephemeral browser) session: the WebView redeems the code instead.
      expect((await c.get('/api/me')).statusCode).toBe(401);
    });

    async function handoffCode(sub = 'google-app-2', email = 'app2@google.example', verifier = APP_VERIFIER): Promise<string> {
      const c = t.client();
      const { start } = await leave(c, { app: '1', challenge: appChallenge(verifier) });
      const res = await comeBack(c, start, { sub, email, email_verified: true });
      return decodeURIComponent(codeFrom(where(res))!);
    }

    it('redeems the code with the matching verifier, signing in with its own session cookie', async () => {
      const code = await handoffCode();
      const c = t.client();
      const res = await c.post('/api/auth/app-code', { code, verifier: APP_VERIFIER });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ user: { source: string } }>().user.source).toBe('google');
      expect((await c.get('/api/me')).statusCode).toBe(200);
    });

    it('refuses the code with the wrong verifier: an intercepted code is useless alone', async () => {
      const code = await handoffCode('google-app-3', 'app3@google.example');
      const res = await t.client().post('/api/auth/app-code', { code, verifier: 'the-wrong-verifier-entirely-xx' });
      expect(res.statusCode).toBe(401);
    });

    it('a code works once', async () => {
      const code = await handoffCode('google-app-4', 'app4@google.example');
      expect((await t.client().post('/api/auth/app-code', { code, verifier: APP_VERIFIER })).statusCode).toBe(200);
      expect((await t.client().post('/api/auth/app-code', { code, verifier: APP_VERIFIER })).statusCode).toBe(401);
    });

    it('a code expires', async () => {
      const code = await handoffCode('google-app-5', 'app5@google.example');
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000);
      expect((await t.client().post('/api/auth/app-code', { code, verifier: APP_VERIFIER })).statusCode).toBe(401);
    });
  });

  describe('rate limiting', () => {
    it('refuses app-code attempts after enough wrong verifiers from one address', async () => {
      const limited = await makeTestApp({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: REDIRECT_URI, SIGNIN_ATTEMPTS: '2' });
      const c = limited.client();
      for (let i = 0; i < 2; i++) expect((await c.post('/api/auth/app-code', { code: 'nope', verifier: 'nope' })).statusCode).toBe(401);
      expect((await c.post('/api/auth/app-code', { code: 'nope', verifier: 'nope' })).statusCode).toBe(429);
      await closeApp(limited);
    });
  });
});
