import { createHash } from 'node:crypto';
import { SessionInfoSchema, type ClubDetail } from '@bookclub/shared';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

/** Avoids naming `CryptoKey` directly: this project's tsconfig has no `lib: ["dom"]`, where that name is a type; without it, `@types/node`'s own global of the same name is a value instead. */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppleKeySet } from '../src/auth/apple';
import { type Client, type TestApp, closeApp, makeTestApp, openSocket, setupOwner } from './helpers';

/* Native "Sign in with Apple" (D178): POST /api/auth/apple, verified against a throwaway ES256
 * key stood in for Apple's own JWKS (setAppleKeySet), never against the real appleid.apple.com. */

const AUD = 'com.example.bookclub';
const ISSUER = 'https://appleid.apple.com';
const KID = 'test-key-1';
const RAW_NONCE = 'the-raw-nonce-the-app-generated';

const sha256Hex = (raw: string) => createHash('sha256').update(raw).digest('hex');

interface Claims {
  readonly sub?: string;
  readonly aud?: string | string[];
  readonly iss?: string;
  /** The raw nonce this token's `nonce` claim is the SHA-256 (hex) of; defaults to RAW_NONCE. */
  readonly rawNonce?: string;
  /** Override the `nonce` claim directly (to test a mismatch), instead of hashing rawNonce. */
  readonly nonce?: string;
  readonly email?: string;
  readonly email_verified?: boolean | string;
  readonly exp?: string;
}

describe('native "Sign in with Apple" (D178)', () => {
  let t: TestApp;
  let privateKey: PrivateKey;
  let owner: Client;
  let club: ClubDetail;

  async function appleToken(claims: Claims = {}): Promise<string> {
    const nonce = claims.nonce ?? sha256Hex(claims.rawNonce ?? RAW_NONCE);
    const payload: Record<string, unknown> = { nonce };
    if (claims.email !== undefined) payload.email = claims.email;
    if (claims.email_verified !== undefined) payload.email_verified = claims.email_verified;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer(claims.iss ?? ISSUER)
      .setAudience(claims.aud ?? AUD)
      .setSubject(claims.sub ?? 'apple-subject-1')
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? '10m')
      .sign(privateKey);
  }

  beforeAll(async () => {
    const { publicKey, privateKey: sk } = await generateKeyPair('ES256', { extractable: true });
    privateKey = sk;
    const jwk = await exportJWK(publicKey);
    jwk.kid = KID;
    jwk.alg = 'ES256';
    setAppleKeySet(createLocalJWKSet({ keys: [jwk] }));
    t = await makeTestApp({ APPLE_AUDIENCES: AUD, SIGNIN_ATTEMPTS: '1000' });
    ({ owner, club } = await setupOwner(t));
  });

  afterAll(async () => {
    setAppleKeySet(null);
    await closeApp(t);
  });

  const signIn = (identityToken: string, nonce = RAW_NONCE, fullName?: string) => t.client().post('/api/auth/apple', { identityToken, nonce, ...(fullName ? { fullName } : {}) });

  it('is off (404) when APPLE_AUDIENCES is not configured', async () => {
    const off = await makeTestApp({});
    expect((await off.client().post('/api/auth/apple', { identityToken: 'x', nonce: 'y' })).statusCode).toBe(404);
    const session = SessionInfoSchema.parse(await off.client().json(off.client().get('/api/session'), 200));
    expect(session.providers).toEqual({ apple: false, google: false });
    await closeApp(off);
  });

  it('says providers.apple is true once configured', async () => {
    const session = SessionInfoSchema.parse(await owner.json(owner.get('/api/session'), 200));
    expect(session.providers).toEqual({ apple: true, google: false });
  });

  it('signs a new person in, creating a passwordless account from the token and the client-sent name', async () => {
    const res = await signIn(await appleToken({ sub: 'apple-ana', email: 'ana@icloud.example', email_verified: true }), RAW_NONCE, 'Ana Reader');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ user: { id: string; displayName: string; email: string | null; source: string } }>();
    expect(body.user).toMatchObject({ displayName: 'Ana Reader', email: 'ana@icloud.example', source: 'apple' });
    const row = t.ctx.db.get<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = ?', [body.user.id]);
    expect(row!.password_hash).toBeNull();
  });

  it('signs the same person back in on a later visit, by subject, even with no fullName this time', async () => {
    const first = (await signIn(await appleToken({ sub: 'apple-bea', email_verified: false }), RAW_NONCE, 'Bea')).json<{ user: { id: string } }>();
    const second = (await signIn(await appleToken({ sub: 'apple-bea', email_verified: false }))).json<{ user: { id: string; displayName: string } }>();
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.displayName).toBe('Bea');
  });

  it('a new account can start a club like any other (D176 applies the same way)', async () => {
    const c = t.client();
    const res = await c.post('/api/auth/apple', { identityToken: await appleToken({ sub: 'apple-cleo' }), nonce: RAW_NONCE });
    expect(res.statusCode).toBe(200);
    expect((await c.post('/api/clubs', { name: 'Cleo’s Club' })).statusCode).toBe(201);
  });

  it('refuses an expired token', async () => {
    expect((await signIn(await appleToken({ sub: 'apple-exp', exp: '-1m' }))).statusCode).toBe(401);
  });

  it('refuses a token for the wrong audience', async () => {
    expect((await signIn(await appleToken({ sub: 'apple-aud', aud: 'com.someone.else' }))).statusCode).toBe(401);
  });

  it('refuses a token from the wrong issuer', async () => {
    expect((await signIn(await appleToken({ sub: 'apple-iss', iss: 'https://not-apple.example' }))).statusCode).toBe(401);
  });

  it('refuses a nonce that is not the SHA-256 of the raw value sent', async () => {
    expect((await signIn(await appleToken({ sub: 'apple-nonce', rawNonce: 'one-value' }), 'a-different-raw-value')).statusCode).toBe(401);
  });

  it('refuses a token whose nonce claim is simply not a nonce at all', async () => {
    expect((await signIn(await appleToken({ sub: 'apple-nononce', nonce: 'not-a-sha256-hex-digest' }))).statusCode).toBe(401);
  });

  it('refuses a disabled account, the same way as any other refusal', async () => {
    const made = (await signIn(await appleToken({ sub: 'apple-disabled' }))).json<{ user: { id: string } }>();
    t.ctx.db.exec('UPDATE users SET disabled_at = ? WHERE id = ?', [Date.now(), made.user.id]);
    expect((await signIn(await appleToken({ sub: 'apple-disabled' }))).statusCode).toBe(401);
  });

  describe('account linking by a verified email (D178)', () => {
    it('links to an existing local account with a password: clears the password, revokes every session and closes its live sockets (PR #25 review)', async () => {
      const dave = t.client();
      await dave.post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: 'Dave', email: 'dave@example.com', password: 'correct horse battery' });
      const elsewhere = t.client();
      await elsewhere.post('/api/auth/signin', { email: 'dave@example.com', password: 'correct horse battery' });
      expect((await elsewhere.get('/api/me')).statusCode).toBe(200);
      // A live realtime socket of the pre-registrar's, open when the real owner links: must not
      // keep receiving the club's notes and chat after the takeover the revocation is meant to stop.
      const socket = await openSocket(t, elsewhere);
      socket.send({ type: 'subscribe', clubId: club.id });

      const viaApple = t.client();
      const res = await viaApple.post('/api/auth/apple', { identityToken: await appleToken({ sub: 'apple-dave', email: 'dave@example.com', email_verified: true }), nonce: RAW_NONCE });
      expect(res.statusCode).toBe(200);
      // The provider proved the email, not whoever typed a password against it first: the account
      // is passwordless and provider-linked now, not still `local` (PR #25 review — password_hash
      // left in place let the pre-registrar keep durable password access after the real owner linked).
      const body = res.json<{ user: { id: string; source: string } }>();
      expect(body.user).toMatchObject({ source: 'apple' });

      // Every session this account had before linking is revoked, signup's own included; the fresh Apple one is not.
      expect((await dave.get('/api/me')).statusCode).toBe(401);
      expect((await elsewhere.get('/api/me')).statusCode).toBe(401);
      expect((await viaApple.get('/api/me')).statusCode).toBe(200);
      // Its live socket closes the same way sign-out-everywhere's does.
      expect(await socket.closed).toEqual({ code: 4001, reason: 'signed out' });
      // The old password is gone, not merely bypassed: it does not come back to life for a plain sign-in either.
      const replay = await t.client().post('/api/auth/signin', { email: 'dave@example.com', password: 'correct horse battery' });
      expect(replay.statusCode).toBe(401);
      expect(t.ctx.db.get<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = ?', [body.user.id])!.password_hash).toBeNull();
    });

    it('links to an existing passwordless account (made elsewhere, no password of its own) without revoking anything', async () => {
      const first = (await signIn(await appleToken({ sub: 'apple-gus-1', email: 'gus@icloud.example', email_verified: true }))).json<{ user: { id: string } }>();
      const stillSignedIn = t.client();
      await stillSignedIn.post('/api/auth/apple', { identityToken: await appleToken({ sub: 'apple-gus-1', email: 'gus@icloud.example', email_verified: true }), nonce: RAW_NONCE });
      const res = await t.client().post('/api/auth/apple', { identityToken: await appleToken({ sub: 'apple-gus-2', email: 'gus@icloud.example', email_verified: true }), nonce: RAW_NONCE });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ user: { id: string } }>().user.id).toBe(first.user.id);
      // The first session is unaffected: no password-holder to protect, so nothing was revoked.
      expect((await stillSignedIn.get('/api/me')).statusCode).toBe(200);
    });

    it('never links on an email Apple has not verified: a fresh account instead', async () => {
      const finnOwner = t.client();
      await finnOwner.post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: 'Finn', email: 'finn@example.com', password: 'correct horse battery' });
      const res = await t.client().post('/api/auth/apple', { identityToken: await appleToken({ sub: 'apple-finn-imposter', email: 'finn@example.com', email_verified: false }), nonce: RAW_NONCE });
      expect(res.statusCode).toBe(200);
      const made = res.json<{ user: { id: string; email: string | null } }>().user;
      const finn = t.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'finn@example.com' COLLATE NOCASE AND password_hash IS NOT NULL")!;
      expect(made.id).not.toBe(finn.id);
      expect(made.email).toBeNull();
      // Finn's own session is untouched: nobody actually proved that email.
      expect((await finnOwner.get('/api/me')).statusCode).toBe(200);
    });
  });

  describe('rate limiting', () => {
    it('refuses after enough failed verifications from one address', async () => {
      const limited = await makeTestApp({ APPLE_AUDIENCES: AUD, SIGNIN_ATTEMPTS: '2' });
      const c = limited.client();
      for (let i = 0; i < 2; i++) expect((await c.post('/api/auth/apple', { identityToken: 'not-a-real-jwt', nonce: RAW_NONCE })).statusCode).toBe(401);
      expect((await c.post('/api/auth/apple', { identityToken: 'not-a-real-jwt', nonce: RAW_NONCE })).statusCode).toBe(429);
      await closeApp(limited);
    });
  });

  describe('input validation', () => {
    it.each([
      ['no body', {}],
      ['an empty token', { identityToken: '', nonce: RAW_NONCE }],
      ['no nonce', { identityToken: 'x' }],
    ])('rejects %s with 400', async (_what, body) => {
      expect((await t.client().post('/api/auth/apple', body)).statusCode).toBe(400);
    });
  });
});
