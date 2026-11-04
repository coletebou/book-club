import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import { appPath } from '@bookclub/shared';
import { z } from 'zod';
import { type Config } from '../config';
import { type AppContext } from '../context';
import { newToken } from '../lib/crypto';
import { challengeOf } from './upstream';

/*
 * "Continue with Google" (D178): a server-side OAuth authorization-code flow with PKCE (RFC 7636),
 * for both the browser's sign-in page and, through a handoff, the iOS app. The shape follows the
 * upstream grant (D116, auth/upstream.ts) closely on purpose — a state and a PKCE verifier
 * kept in a sealed, `__Host-` cookie for the round trip, the same constant-time state comparison —
 * but talks to Google's own endpoints instead of a grant the upstream built for this app specifically:
 *
 *   1. GET /api/auth/google/start keeps a state and a verifier in this device's cookie (the
 *      flight) and sends the browser to Google's own authorization endpoint with the state and
 *      the verifier's SHA-256. For the app (`app=1`), the flight also keeps the *app's own*,
 *      separate PKCE challenge (`challenge`, generated on the device, never sent to Google) that
 *      the eventual app-code handoff below is bound to.
 *   2. Google signs the person in on its own pages and sends the browser back to
 *      GET /api/auth/google/callback with the state and a code.
 *   3. This server exchanges the code at Google's token endpoint with the verifier (which only
 *      this device's cookie carried) and verifies the id_token it gets back against Google's JWKS.
 *   4. A browser sign-in (no `app` on the flight) gets a session cookie and goes on to `next`. An
 *      app sign-in mints a one-time code bound to the app's own challenge (`repos/app-codes.ts`)
 *      and redirects to `bookclub://auth?code=…`; the app redeems that code from inside its
 *      WebView (`POST /api/auth/app-code`), so the session cookie lands in the shared cookie store
 *      the WebView and native playback both read (D133) rather than in the ephemeral browser
 *      session `WebBrowser.openAuthSessionAsync` used to reach Google.
 */

export const GOOGLE_COOKIE = 'bc_google';
export const GOOGLE_FLIGHT_MS = 10 * 60_000;

const RANDOM = /^[A-Za-z0-9_-]{43}$/;

const FlightSchema = z.object({
  state: z.string().regex(RANDOM),
  verifier: z.string().regex(RANDOM),
  next: z.string(),
  expires: z.number(),
  /** Set only for the app's own handoff (step 4 above); absent for a plain browser sign-in. */
  appChallenge: z.string().regex(RANDOM).nullable(),
});

export interface GoogleFlight {
  readonly state: string;
  readonly verifier: string;
  readonly next: string;
  readonly expires: number;
  readonly appChallenge: string | null;
}

export function newGoogleFlight(next: string, appChallenge: string | null, now = Date.now()): GoogleFlight {
  return { state: newToken(), verifier: newToken(), next, appChallenge, expires: now + GOOGLE_FLIGHT_MS };
}

export function sealGoogleFlight(flight: GoogleFlight): string {
  return Buffer.from(JSON.stringify(flight)).toString('base64url');
}

export function openGoogleFlight(value: string | undefined): GoogleFlight | null {
  if (!value || value.length > 4096) return null;
  try {
    const parsed = FlightSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return parsed.success ? { ...parsed.data, next: appPath(parsed.data.next) ?? '/' } : null;
  } catch {
    return null;
  }
}

/**
 * Google's own endpoints, as `Config['google']` carries them (config.ts's `GOOGLE_AUTH_URL`,
 * `GOOGLE_TOKEN_URL`, `GOOGLE_JWKS_URL`, `GOOGLE_ISSUERS`): the real ones by default, exactly the
 * way `UPSTREAM_START_URL`/`UPSTREAM_EXCHANGE_URL` make the upstream grant's addresses
 * configurable rather than hard-coded, so the demo stack and its E2E suite can point this whole
 * flow at a local stand-in (`tools/fake-google`) over plain HTTP with no code change here.
 */
const jwksOf = new Map<string, JWTVerifyGetKey>();

function jwksFor(jwksUrl: string): JWTVerifyGetKey {
  let keys = jwksOf.get(jwksUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 5 * 60_000 });
    jwksOf.set(jwksUrl, keys);
  }
  return keys;
}

/** Where the browser goes to sign in with Google. */
export function googleStartAddress(google: NonNullable<Config['google']>, flight: GoogleFlight): string {
  const url = new URL(google.authUrl);
  url.searchParams.set('client_id', google.clientId);
  url.searchParams.set('redirect_uri', google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', flight.state);
  url.searchParams.set('code_challenge', challengeOf(flight.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  // One account picker every time: this device's flight has no memory of who last signed in here.
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('access_type', 'online');
  return url.href;
}

export interface GoogleIdentity {
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string;
}

export type GoogleResult = { readonly identity: GoogleIdentity } | { readonly refused: string; readonly detail?: Record<string, unknown> };

const TokenAnswerSchema = z.object({ id_token: z.string().min(1) });

/** How long the token exchange may take, and how much of its answer is read (tests make them small). */
export interface GoogleLimits {
  readonly exchangeMs: number;
  readonly answerBytes: number;
}
export const GOOGLE_LIMITS: GoogleLimits = { exchangeMs: 10_000, answerBytes: 16 * 1024 };
const limitsOf = new WeakMap<AppContext, GoogleLimits>();
export function setGoogleLimits(ctx: AppContext, limits: Partial<GoogleLimits>): void {
  limitsOf.set(ctx, { ...(limitsOf.get(ctx) ?? GOOGLE_LIMITS), ...limits });
}

async function readAtMost(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

function jsonOrNothing(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Exchange the code Google sent back at its token endpoint (with the PKCE verifier only this
 * device's cookie carried), then verify the id_token it returns against Google's JWKS: issuer,
 * audience (this server's own client id), expiry (jose's own check), and `email_verified`.
 */
export async function exchangeGoogleCode(ctx: AppContext, google: NonNullable<Config['google']>, code: string, verifier: string): Promise<GoogleResult> {
  const limits = limitsOf.get(ctx) ?? GOOGLE_LIMITS;
  const signal = AbortSignal.timeout(limits.exchangeMs);
  try {
    const res = await fetch(google.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: google.clientId,
        client_secret: google.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: google.redirectUri,
        grant_type: 'authorization_code',
      }),
      redirect: 'error',
      signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { refused: 'the token exchange did not redeem the code', detail: { status: res.status } };
    }
    const text = await readAtMost(res, limits.answerBytes);
    if (text === null) return { refused: 'the token exchange answered more than a token' };
    const answer = TokenAnswerSchema.safeParse(jsonOrNothing(text));
    if (!answer.success) return { refused: 'the token exchange answered something else' };
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(answer.data.id_token, jwksFor(google.jwksUrl), { issuer: [...google.issuers], audience: google.clientId }));
    } catch (err) {
      return { refused: err instanceof Error ? err.name : 'the id_token did not verify' };
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return { refused: 'no subject in the id_token' };
    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
    const email = emailVerified && typeof payload.email === 'string' ? payload.email : null;
    const displayName = typeof payload.name === 'string' && payload.name.trim() ? payload.name : email?.slice(0, email.indexOf('@')) || 'Reader';
    return { identity: { subject: payload.sub, email, emailVerified, displayName } };
  } catch (err) {
    if (signal.aborted) return { refused: 'the token exchange did not answer in time' };
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    const error = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : err instanceof Error ? err.name : 'unknown';
    return { refused: 'the token exchange could not be asked', detail: { error: error.slice(0, 120) } };
  }
}
