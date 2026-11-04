import { createHash, timingSafeEqual } from 'node:crypto';
import { EmailSchema, LIMITS, appPath } from '@bookclub/shared';
import { z } from 'zod';
import { type Config } from '../config';
import { type AppContext } from '../context';
import { newToken } from '../lib/crypto';

/*
 * "Continue with <name>" through the upstream's app sign-in grant (D116), the one its other client
 * apps use too: an authorization code with PKCE (RFC 7636, S256) for a callback the upstream
 * has fixed for this app, client `book-club`.
 *
 *   1. GET /api/auth/upstream keeps a state and a code verifier in a cookie of this host's (the
 *      flight) and sends the browser to the upstream's start address with the state and the
 *      verifier's SHA-256.
 *   2. The upstream signs the person in on its own pages and sends the browser back to
 *      GET /api/auth/upstream/callback with the state and a code, good once, for 90 seconds.
 *   3. This server redeems the code at the upstream's exchange address with the verifier, which
 *      only this device's cookie carried, and is told who the person is.
 *
 * No secret of the upstream's is kept here, and it shares no cookie and keeps no session for us.
 */

export interface UpstreamIdentity {
  readonly subject: string;
  readonly displayName: string;
  readonly email: string | null;
}

/** The flight's cookie: `__Host-` over HTTPS (cookieName), so no sibling subdomain can plant one. */
export const UPSTREAM_COOKIE = 'bc_upstream';

/** From leaving for the upstream to coming back: time to sign in there, even to make an account. */
export const UPSTREAM_FLIGHT_MS = 10 * 60_000;

/** A sign-in under way on one device: what its way back must carry, and where it goes after. */
export interface Flight {
  readonly state: string;
  readonly verifier: string;
  readonly next: string;
  readonly expires: number;
}

/** 32 random bytes, base64url: a state or a verifier as newToken() makes them. */
const RANDOM = /^[A-Za-z0-9_-]{43}$/;

const FlightSchema = z.object({ state: z.string().regex(RANDOM), verifier: z.string().regex(RANDOM), next: z.string(), expires: z.number() });

/** A new sign-in that goes on to `next` (a path appPath has passed). */
export function newFlight(next: string, now = Date.now()): Flight {
  return { state: newToken(), verifier: newToken(), next, expires: now + UPSTREAM_FLIGHT_MS };
}

/** The flight as its cookie keeps it. */
export function sealFlight(flight: Flight): string {
  return Buffer.from(JSON.stringify(flight)).toString('base64url');
}

/** The flight a cookie keeps, or null if it keeps none. */
export function openFlight(value: string | undefined): Flight | null {
  if (!value || value.length > 4096) return null;
  try {
    const parsed = FlightSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return parsed.success ? { ...parsed.data, next: appPath(parsed.data.next) ?? '/' } : null;
  } catch {
    return null;
  }
}

/** S256: the challenge for a verifier is base64url(SHA-256(verifier)). */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Whether the browser came back with the state it left with, compared in constant time. */
export function sameState(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Where the browser goes to sign in, for a request to this app by `hostname`. On a developer's
 * machine (the demo stack) the app and the upstream's stand-in are both on loopback, reached as
 * 127.0.0.1 or as localhost; a browser keeps cookies per name, so it keeps the name it came by,
 * the stand-in sends it back to the callback by that name, and the flight's cookie is there. An
 * upstream that is not on loopback (the real one, in production) is gone to as configured.
 */
export function startAddress(upstream: NonNullable<Config['upstream']>, flight: Flight, hostname: string): string {
  const url = new URL(upstream.startUrl);
  const came = hostname.toLowerCase();
  if (LOOPBACK.has(url.hostname) && LOOPBACK.has(came)) url.hostname = came;
  url.searchParams.set('state', flight.state);
  url.searchParams.set('code_challenge', challengeOf(flight.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

/** How long the exchange may take, and how much of its answer is read (tests make them small). */
export interface UpstreamLimits {
  /** For all of it: connecting, asking and reading the answer. */
  readonly exchangeMs: number;
  /** The upstream's answer is a few hundred bytes. */
  readonly answerBytes: number;
}

export const UPSTREAM_LIMITS: UpstreamLimits = { exchangeMs: 10_000, answerBytes: 16 * 1024 };

const limitsOf = new WeakMap<AppContext, UpstreamLimits>();

/** Give one server other limits. */
export function setUpstreamLimits(ctx: AppContext, limits: Partial<UpstreamLimits>): void {
  limitsOf.set(ctx, { ...(limitsOf.get(ctx) ?? UPSTREAM_LIMITS), ...limits });
}

/** The exchange's answer for a code it redeemed: who the person is, and nothing else (D116). */
const ExchangeAnswerSchema = z.object({
  success: z.literal(true),
  user: z.object({ id: z.string().min(1).max(200), name: z.string(), email: z.string().nullable(), emailVerified: z.boolean() }),
});

export type UpstreamUser = z.infer<typeof ExchangeAnswerSchema>['user'];

/** At most `max` UTF-16 units of a text, without cutting a character in two. Shared with auth/apple.ts and auth/google.ts's display-name clipping (D178). */
export function clip(text: string, max: number): string {
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

/** The person as this app keeps them: the upstream's id, and its name and email for them. */
export function identityOf(user: UpstreamUser): UpstreamIdentity {
  // An address the upstream has not verified is not taken as theirs here: it could be someone
  // else's, and would then stand in the way of that person's own sign-up (SA36).
  const email = user.emailVerified && user.email !== null ? (EmailSchema.safeParse(user.email).data ?? null) : null;
  const name = user.name.trim() || email?.slice(0, email.indexOf('@')) || 'Reader';
  return { subject: `upstream:${user.id}`, displayName: clip(name, LIMITS.displayName).trim(), email };
}

export type Redeemed = { readonly identity: UpstreamIdentity } | { readonly refused: string; readonly detail?: Record<string, unknown> };

/** A response's body as text, or null once it is longer than `max` bytes (read no further). */
async function readAtMost(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return '';
  // fetch's body is a stream of bytes, which its type does not say.
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
 * Redeem a code at the upstream's exchange, server to server: the person it is for, or why not.
 * The code and the verifier go there and nowhere else (no redirect is followed), and neither is
 * ever part of a reason.
 */
export async function redeemCode(ctx: AppContext, upstream: NonNullable<Config['upstream']>, code: string, verifier: string): Promise<Redeemed> {
  const limits = limitsOf.get(ctx) ?? UPSTREAM_LIMITS;
  const signal = AbortSignal.timeout(limits.exchangeMs);
  try {
    const res = await fetch(upstream.exchangeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, codeVerifier: verifier }),
      redirect: 'error',
      signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { refused: 'the exchange did not redeem the code', detail: { status: res.status } };
    }
    const text = await readAtMost(res, limits.answerBytes);
    if (text === null) return { refused: 'the exchange answered more than an identity' };
    const answer = ExchangeAnswerSchema.safeParse(jsonOrNothing(text));
    if (!answer.success) return { refused: 'the exchange answered something else' };
    return { identity: identityOf(answer.data.user) };
  } catch (err) {
    if (signal.aborted) return { refused: 'the exchange did not answer in time' };
    // fetch() says only "fetch failed"; what failed is its cause (a refused connection, a redirect).
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    const error = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : err instanceof Error ? err.name : 'unknown';
    return { refused: 'the exchange could not be asked', detail: { error: error.slice(0, 120) } };
  }
}

/** The upstream's answer to a password it checked: a code, good once, bound to the challenge sent. */
const PasswordAnswerSchema = z.object({ success: z.literal(true), code: z.string().min(1).max(512) });

/**
 * A password typed into this app's own form (D173, D116), checked at the upstream's own password
 * endpoint instead of its page: a fresh PKCE pair made here, the challenge sent with the
 * credentials, and the code it answers with redeemed at the exchange address exactly as a browser
 * completing the upstream's page would be — `redeemCode` above, unchanged. The verifier never
 * leaves this process; the password never goes anywhere but the one request below.
 */
export async function redeemPassword(
  ctx: AppContext,
  upstream: NonNullable<Config['upstream']>,
  email: string,
  password: string,
  clientIp: string,
): Promise<Redeemed> {
  if (!upstream.passwordUrl || !upstream.passwordSecret) return { refused: 'no password endpoint is configured for the upstream' };
  const limits = limitsOf.get(ctx) ?? UPSTREAM_LIMITS;
  const verifier = newToken();
  const signal = AbortSignal.timeout(limits.exchangeMs);
  try {
    const res = await fetch(upstream.passwordUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // The upstream's password check is bearer-gated (only this server may call it) and,
        // because only this server may, also trusts the real end-user address it is asking on
        // behalf of here, for its own rate limiting.
        authorization: `Bearer ${upstream.passwordSecret}`,
        'x-book-club-client-ip': clientIp,
      },
      body: JSON.stringify({ email, password, codeChallenge: challengeOf(verifier), codeChallengeMethod: 'S256' }),
      redirect: 'error',
      signal,
    });
    if (res.status === 401) {
      await res.body?.cancel();
      return { refused: 'that email and password do not match' };
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      return { refused: 'the password check refused the attempt', detail: { status: res.status } };
    }
    const text = await readAtMost(res, limits.answerBytes);
    if (text === null) return { refused: 'the password check answered more than a code' };
    const answer = PasswordAnswerSchema.safeParse(jsonOrNothing(text));
    if (!answer.success) return { refused: 'the password check answered something else' };
    // The code is good once, for 90 seconds, bound to the challenge above: redeemed the same way
    // a browser's own code from the upstream's page is.
    return redeemCode(ctx, upstream, answer.data.code, verifier);
  } catch (err) {
    if (signal.aborted) return { refused: 'the password check did not answer in time' };
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    const error = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : err instanceof Error ? err.name : 'unknown';
    return { refused: 'the password check could not be asked', detail: { error: error.slice(0, 120) } };
  }
}
