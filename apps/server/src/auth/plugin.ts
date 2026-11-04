import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { type AppContext } from '../context';
import { conflict, forbidden, unauthorized } from '../lib/errors';
import { createSession, resolveSession } from '../repos/sessions';
import { type UserRow } from '../repos/users';

export const SESSION_COOKIE = 'bc_session';

function secure(ctx: AppContext, request: FastifyRequest): boolean {
  if (ctx.config.COOKIE_SECURE === 'true') return true;
  if (ctx.config.COOKIE_SECURE === 'false') return false;
  // Behind a TLS proxy the request itself may look like plain HTTP: the public address decides.
  return request.protocol === 'https' || /^https:/i.test(ctx.config.PUBLIC_ORIGIN ?? '');
}

/**
 * Over HTTPS our cookies carry the `__Host-` prefix, which a browser accepts only from this very
 * host, Secure, for path `/` and without a Domain: a sibling subdomain (Book Club served from the
 * upstream's own domain, beside its hosts and its tenants' sites) cannot plant a session,
 * or a sign-in under way, of its choosing.
 */
export function cookieName(ctx: AppContext, request: FastifyRequest, name: string): string {
  return secure(ctx, request) ? `__Host-${name}` : name;
}

export const cookieOptions = (ctx: AppContext, request: FastifyRequest) => ({ httpOnly: true, sameSite: 'lax' as const, secure: secure(ctx, request), path: '/' });

export function setSessionCookie(ctx: AppContext, request: FastifyRequest, reply: FastifyReply, token: string, expiresAt: number): void {
  reply.setCookie(cookieName(ctx, request, SESSION_COOKIE), token, { ...cookieOptions(ctx, request), expires: new Date(expiresAt) });
}

export function clearSessionCookie(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(cookieName(ctx, request, SESSION_COOKIE), cookieOptions(ctx, request));
}

/** The address people use for this app: the configured public one, else the one this request came to. */
export function publicOrigin(ctx: AppContext, request: FastifyRequest): string {
  return (ctx.config.PUBLIC_ORIGIN ?? requestOrigin(request)).replace(/\/$/, '');
}

/** Start a session for a user and set the cookie. */
export function signIn(ctx: AppContext, request: FastifyRequest, reply: FastifyReply, user: UserRow): string {
  const { token, expiresAt } = createSession(ctx.db, user.id, ctx.config.SESSION_DAYS, request.headers['user-agent'] ?? '');
  setSessionCookie(ctx, request, reply, token, expiresAt);
  request.user = user;
  request.sessionToken = token;
  return token;
}

/** Resolve a request's user from the session cookie. */
export function authenticate(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): void {
  const token = request.cookies[cookieName(ctx, request, SESSION_COOKIE)];
  if (!token) return;
  const resolved = resolveSession(ctx.db, token, ctx.config.SESSION_DAYS);
  if (!resolved) {
    clearSessionCookie(ctx, request, reply);
    return;
  }
  request.user = resolved.user;
  request.sessionToken = token;
  if (resolved.renewedUntil) setSessionCookie(ctx, request, reply, token, resolved.renewedUntil);
}

/**
 * Resolve the user behind a raw Cookie header (a tus request without its Fastify request). The
 * `__Host-` cookie can only have come from this host; the plain one counts unless the settings
 * say every request is HTTPS.
 */
export function userFromCookieHeader(ctx: AppContext, cookieHeader: string | null | undefined): UserRow | null {
  if (!cookieHeader) return null;
  const alwaysSecure = ctx.config.COOKIE_SECURE === 'true' || (ctx.config.COOKIE_SECURE === 'auto' && /^https:/i.test(ctx.config.PUBLIC_ORIGIN ?? ''));
  const names = alwaysSecure ? [`__Host-${SESSION_COOKIE}`] : [`__Host-${SESSION_COOKIE}`, SESSION_COOKIE];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (!names.includes(part.slice(0, eq).trim())) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    return resolveSession(ctx.db, value, ctx.config.SESSION_DAYS)?.user ?? null;
  }
  return null;
}

export function requireUser(request: FastifyRequest): UserRow {
  if (!request.user) throw unauthorized();
  return request.user;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The scheme://host[:port] this request was addressed to. */
export function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

export function originAllowed(ctx: AppContext, request: FastifyRequest, origin: string): boolean {
  if (origin === requestOrigin(request)) return true;
  if (ctx.config.PUBLIC_ORIGIN && origin === ctx.config.PUBLIC_ORIGIN.replace(/\/$/, '')) return true;
  return ctx.config.allowedOrigins.includes(origin);
}

/**
 * CSRF defence: state-changing requests must come from our own pages. Browsers send `Origin` on
 * every cross-origin and same-origin POST/PUT/PATCH/DELETE (and `Sec-Fetch-Site`); requests
 * without either header do not come from a page and cannot carry a victim's cookies by accident.
 */
export function checkOrigin(ctx: AppContext, request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null' || !originAllowed(ctx, request, origin)) throw forbidden('Cross-origin request refused.');
    return;
  }
  const site = request.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') throw forbidden('Cross-origin request refused.');
}

/** The header a page sends with each change, naming whose page it is. */
export const EXPECTED_USER_HEADER = 'x-bookclub-user';

/**
 * A page says whose it is with every change it makes (the header, or `as` on a beacon, which
 * cannot set headers). If the device's session has meanwhile become someone else's (signed out
 * and in again in another tab), the change is refused rather than applied to the new person:
 * one person's reading must never open another's spoilers.
 */
export function checkExpectedUser(request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method) || !request.user) return;
  const header = request.headers[EXPECTED_USER_HEADER];
  const query = request.query as Record<string, unknown> | undefined;
  const expected = typeof header === 'string' ? header : typeof query?.as === 'string' ? query.as : '';
  if (expected !== '' && expected !== request.user.id) throw conflict('Someone else is signed in on this device now.', 'session_changed');
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.addHook('onRequest', async (request, reply) => {
    checkOrigin(ctx, request);
    authenticate(ctx, request, reply);
    checkExpectedUser(request);
  });
}
