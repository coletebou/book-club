/**
 * A stand-in for the upstream identity provider, for the demo stack and the tests (D116, D173): its
 * app sign-in grant for Book Club (client `book-club`), and its password sign-in, and nothing else.
 *
 *   GET  /api/auth/book-club/start?state=S&code_challenge=C&code_challenge_method=S256
 *          checks them as the upstream does, keeps them in a signed cookie (the transaction, 10
 *          minutes) and sends the browser to the sign-in page, on its way to `complete`
 *   GET  /login?returnTo=URL    a sign-in form (signed in already: straight on to returnTo, an
 *                               address of this stand-in's own)
 *   POST /login                 checks the account, starts this stand-in's own session (a signed,
 *                               host-only cookie) and goes on to returnTo
 *   GET  /api/auth/book-club/complete
 *          signed in: a code good once, for 90 seconds, bound to the challenge, and back to Book
 *          Club's callback with `state` and `code` (a deactivated account: `error=failed`); not
 *          signed in: back to the sign-in page; the transaction lost: `error=failed` alone
 *   POST /api/auth/book-club/exchange   { code, codeVerifier }, from Book Club's server: who it is
 *   POST /api/auth/book-club/password   { email, password, codeChallenge, codeChallengeMethod },
 *          from Book Club's server, bearer-gated (Authorization: Bearer <passwordSecret>, missing
 *          or wrong: 401; passwordSecret unset: 404, as if the route did not exist) — the same
 *          password check `/login` makes, with no page and no cookie; a match answers a code
 *          bound to the challenge, for `exchange` to redeem
 *   POST /logout                ends this stand-in's session
 *   GET  /                      who is signed in here
 *
 * The upstream has Book Club's callback fixed. Here the callbacks come from UPSTREAM_CALLBACKS, because
 * the demo is reached as 127.0.0.1 and as localhost and a browser keeps cookies per name: the one
 * used is the one by the name the browser reached this stand-in by (Book Club sends it here by
 * the name it came to Book Club by, so it comes back to the cookie Book Club set).
 *
 * Accounts (password `upstream-demo` for all): dana@upstream.test, eli@upstream.test,
 * gus@upstream.test (deactivated), and any other address at upstream.test, named after it (one
 * starting with `inactive` is deactivated, with `unverified` has its address unverified). Demo
 * only: never run this anywhere but a developer's own machine.
 *
 *   UPSTREAM_CALLBACKS=http://127.0.0.1:47100/api/auth/upstream/callback \
 *   UPSTREAM_PASSWORD_SECRET=whatever-book-club-presents \
 *   node tools/fake-upstream/server.mjs
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEMO_PASSWORD = 'upstream-demo';
/** This stand-in's own session, as the upstream has its own (host-only: no other site receives it). */
export const SESSION_COOKIE = 'upstream_demo_session';
/** The sign-in transaction between `start` and `complete`. */
const FLOW_COOKIE = 'upstream_demo_flow';
const FLOW_PATH = '/api/auth/book-club';

const KNOWN = new Map([
  ['dana@upstream.test', { name: 'Dana', isActive: true }],
  ['eli@upstream.test', { name: 'Eli', isActive: true }],
  ['gus@upstream.test', { name: 'Gus', isActive: false }],
]);

/** As the upstream checks them: the app's state, the S256 challenge, a PKCE verifier (RFC 7636). */
const STATE = /^[A-Za-z0-9_-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_MS = 90_000;
const FLOW_MS = 10 * 60_000;
const SESSION_MS = 12 * 3600_000;

/** The upstream account behind an address, or null if there is none. */
export function account(email) {
  const address = String(email).trim().toLowerCase();
  if (!/^[a-z0-9._+-]{1,64}@upstream\.test$/.test(address)) return null;
  const known = KNOWN.get(address);
  const local = address.slice(0, address.indexOf('@'));
  const word = /[a-z]+/.exec(local)?.[0] ?? 'reader';
  return {
    // The upstream's ids are MongoDB ObjectIds: 24 hex digits.
    userId: createHash('sha256').update(address).digest('hex').slice(0, 24),
    email: address,
    name: known?.name ?? word[0].toUpperCase() + word.slice(1),
    isActive: known ? known.isActive : !local.startsWith('inactive'),
    emailVerified: !local.startsWith('unverified'),
  };
}

const sha256 = (text) => createHash('sha256').update(text).digest();
const sameText = (a, b) => timingSafeEqual(sha256(String(a)), sha256(String(b)));
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function cookies(request) {
  const out = new Map();
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

const cookie = (name, value, path, maxAgeMs) => `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Upstream ID (demo)</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #101014; color: #ecebe8; font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(100% - 32px, 380px); display: grid; gap: 14px; }
  h1 { margin: 0; font-size: 1.5rem; } .demo { color: #b3aea4; font-size: 0.9rem; margin: 0; }
  label { display: grid; gap: 4px; font-size: 0.95rem; }
  input { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #55524c; background: #1b1b20; color: inherit; }
  button { font: inherit; padding: 11px 14px; border-radius: 8px; border: 0; background: #7c5cff; color: #fff; font-weight: 600; cursor: pointer; }
  .error { color: #ffb4a8; margin: 0; } form { display: grid; gap: 12px; }
</style></head>
<body><main>${body}</main></body></html>`;
}

const loginForm = (returnTo, error = '', email = '') =>
  page(
    'Sign in',
    `<h1>Upstream ID</h1>
<p class="demo">A stand-in for the upstream identity provider on this computer: it signs you in to Book Club with the upstream's sign-in grant, as the real one does. Demo accounts: dana@upstream.test, eli@upstream.test (password ${DEMO_PASSWORD}).</p>
<form method="post" action="/login">
  ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
  <input type="hidden" name="returnTo" value="${escape(returnTo)}">
  <label>Email <input name="email" type="email" autocomplete="username" required value="${escape(email)}"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in to Upstream ID</button>
</form>`,
  );

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The upstream's stand-in as an HTTP server (not yet listening). */
export function createFakeUpstream(options) {
  const key = randomBytes(32);
  const now = options.now ?? Date.now;
  /** Codes not yet redeemed, by their SHA-256: whose, for which challenge, until when. */
  const codes = new Map();

  const mac = (payload) => createHmac('sha256', key).update(payload).digest('base64url');
  /** A value only this stand-in can have written, until `ms` from now. */
  const seal = (value, ms) => {
    const payload = Buffer.from(JSON.stringify({ ...value, exp: now() + ms })).toString('base64url');
    return `${payload}.${mac(payload)}`;
  };
  const unseal = (raw) => {
    const [payload, signature, extra] = String(raw ?? '').split('.');
    if (!payload || !signature || extra !== undefined || !sameText(signature, mac(payload))) return null;
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return typeof value.exp === 'number' && value.exp > now() ? value : null;
    } catch {
      return null;
    }
  };
  const signedIn = (request) => {
    const session = unseal(cookies(request).get(SESSION_COOKIE));
    return session ? account(session.email) : null;
  };
  const forget = () => {
    for (const [hash, grant] of codes) if (grant.expires <= now()) codes.delete(hash);
  };

  /** Book Club's callback by the name the browser reached this stand-in by (else the first one). */
  const callbackFor = (host) => {
    const known = options.callbacks.filter((c) => URL.canParse(c)).map((c) => new URL(c));
    return known.find((c) => c.hostname === host.hostname) ?? known[0] ?? null;
  };
  const backTo = (callback, params) => {
    const url = new URL(callback);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.href;
  };
  /** An address of this stand-in's own, as a URL, or null. */
  const ownAddress = (raw, host) => {
    try {
      const url = new URL(String(raw), host.origin);
      return url.origin === host.origin ? url : null;
    } catch {
      return null;
    }
  };

  const send = (response, status, html, headers = {}) => {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', ...headers });
    response.end(html);
  };
  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const redirect = (response, location, headers = {}) => {
    response.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
    response.end();
  };
  /** Only the upstream's own pages may sign someone in or out of it (another site could plant an account). */
  const fromItsOwnPage = (request, host) => {
    const site = request.headers['sec-fetch-site'];
    const origin = request.headers.origin;
    return (site === undefined || site === 'same-origin' || site === 'none') && (origin === undefined || origin === host.origin);
  };
  const refusedCode = { success: false, error: 'Sign-in expired or could not be verified. Start again.' };
  // As the upstream's own password endpoint answers: the same body whether the address, the password
  // or the account was wrong (no account enumeration).
  const refusedPassword = { success: false, error: 'Invalid email or password.' };
  // A missing or wrong bearer never reaches the credential check, so it gets a different body —
  // as the upstream's own bearer check does.
  const refusedBearer = { success: false, error: 'Invalid sign-in request.' };

  return createServer(async (request, response) => {
    try {
      const host = new URL(`http://${request.headers.host ?? '127.0.0.1'}`);
      const url = new URL(request.url ?? '/', host);
      const complete = new URL(`${FLOW_PATH}/complete`, host.origin).href;
      const toLogin = `/login?returnTo=${encodeURIComponent(complete)}`;
      const endFlow = cookie(FLOW_COOKIE, '', FLOW_PATH, 0);

      if (request.method === 'GET' && url.pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
        return;
      }
      if (request.method === 'GET' && url.pathname === `${FLOW_PATH}/start`) {
        const state = url.searchParams.get('state') ?? '';
        const challenge = url.searchParams.get('code_challenge') ?? '';
        if (!STATE.test(state) || !CHALLENGE.test(challenge) || url.searchParams.get('code_challenge_method') !== 'S256') {
          return send(response, 400, page('Refused', '<h1>Upstream ID</h1><p class="error">That is not a sign-in Upstream ID starts.</p>'));
        }
        return redirect(response, toLogin, { 'set-cookie': cookie(FLOW_COOKIE, seal({ state, challenge }, FLOW_MS), FLOW_PATH, FLOW_MS) });
      }
      if (request.method === 'GET' && url.pathname === `${FLOW_PATH}/complete`) {
        const callback = callbackFor(host);
        if (!callback) return send(response, 500, page('Not set up', '<h1>Upstream ID</h1><p class="error">No callback for Book Club is set (UPSTREAM_CALLBACKS).</p>'));
        const flow = unseal(cookies(request).get(FLOW_COOKIE));
        if (!flow) return redirect(response, backTo(callback, { error: 'failed' }), { 'set-cookie': endFlow });
        const who = signedIn(request);
        if (!who) return redirect(response, toLogin);
        if (!who.isActive) return redirect(response, backTo(callback, { state: flow.state, error: 'failed' }), { 'set-cookie': endFlow });
        forget();
        const code = randomBytes(32).toString('base64url');
        codes.set(sha256(code).toString('hex'), { email: who.email, challenge: flow.challenge, expires: now() + CODE_MS });
        return redirect(response, backTo(callback, { state: flow.state, code }), { 'set-cookie': endFlow });
      }
      if (request.method === 'POST' && url.pathname === `${FLOW_PATH}/exchange`) {
        // Book Club's server, not a page: no cookies, nothing but JSON.
        if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return json(response, 400, refusedCode);
        let body;
        try {
          body = JSON.parse(await readBody(request));
        } catch {
          return json(response, 400, refusedCode);
        }
        const { code, codeVerifier } = body ?? {};
        if (typeof code !== 'string' || !CHALLENGE.test(code) || typeof codeVerifier !== 'string' || !VERIFIER.test(codeVerifier)) return json(response, 400, refusedCode);
        forget();
        const hash = sha256(code).toString('hex');
        const grant = codes.get(hash);
        const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
        // As the upstream's: only the code, with the verifier of its challenge, in time, redeems it, once.
        if (!grant || grant.expires <= now() || !sameText(challenge, grant.challenge)) return json(response, 400, refusedCode);
        codes.delete(hash);
        const who = account(grant.email);
        if (!who?.isActive) return json(response, 400, refusedCode);
        return json(response, 200, { success: true, user: { id: who.userId, name: who.name, email: who.email, emailVerified: who.emailVerified } });
      }
      if (request.method === 'POST' && url.pathname === `${FLOW_PATH}/password`) {
        // A password typed into Book Club's own form instead of this stand-in's page (D173):
        // server to server again, no cookies, nothing but JSON. As the upstream's own now does: a
        // credential check, refused to anyone without the bearer only Book Club holds; unset
        // passwordSecret answers 404, as if this route did not exist.
        if (!options.passwordSecret) return send(response, 404, page('Not found', '<h1>Not found</h1>'));
        const auth = request.headers.authorization ?? '';
        const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!given || !sameText(given, options.passwordSecret)) return json(response, 401, refusedBearer);
        if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return json(response, 400, refusedCode);
        let body;
        try {
          body = JSON.parse(await readBody(request));
        } catch {
          return json(response, 400, refusedCode);
        }
        const { email, password, codeChallenge, codeChallengeMethod } = body ?? {};
        if (typeof codeChallenge !== 'string' || !CHALLENGE.test(codeChallenge) || codeChallengeMethod !== 'S256'
          || typeof email !== 'string' || typeof password !== 'string') {
          return json(response, 400, refusedCode);
        }
        const who = account(email);
        if (!who || !who.isActive || !sameText(password, DEMO_PASSWORD)) return json(response, 401, refusedPassword);
        forget();
        const code = randomBytes(32).toString('base64url');
        codes.set(sha256(code).toString('hex'), { email: who.email, challenge: codeChallenge, expires: now() + CODE_MS });
        return json(response, 200, { success: true, code });
      }
      if (request.method === 'GET' && url.pathname === '/login') {
        const raw = url.searchParams.get('returnTo') ?? '';
        const target = raw ? ownAddress(raw, host) : null;
        if (raw && !target) return send(response, 400, page('Unknown address', '<h1>Upstream ID</h1><p class="error">That return address is not one of Upstream ID\'s.</p>'));
        if (target && signedIn(request)) return redirect(response, target.href);
        return send(response, 200, loginForm(raw));
      }
      if (request.method === 'POST' && !fromItsOwnPage(request, host)) return send(response, 403, page('Refused', '<h1>Upstream ID</h1><p class="error">Sign in from Upstream ID\'s own page.</p>'));
      if (request.method === 'POST' && url.pathname === '/login') {
        const form = new URLSearchParams(await readBody(request));
        const raw = form.get('returnTo') ?? '';
        const who = account(form.get('email') ?? '');
        if (!who || !sameText(form.get('password') ?? '', DEMO_PASSWORD)) return send(response, 401, loginForm(raw, 'That email and password do not match.', form.get('email') ?? ''));
        const target = raw ? ownAddress(raw, host) : null;
        return redirect(response, target?.href ?? '/', { 'set-cookie': cookie(SESSION_COOKIE, seal({ email: who.email }, SESSION_MS), '/', SESSION_MS) });
      }
      if (request.method === 'POST' && url.pathname === '/logout') {
        return redirect(response, '/', { 'set-cookie': cookie(SESSION_COOKIE, '', '/', 0) });
      }
      if (request.method === 'GET' && url.pathname === '/') {
        const who = signedIn(request);
        const body = who
          ? `<h1>Upstream ID</h1><p>Signed in as ${escape(who.name)} (${escape(who.email)}).</p><form method="post" action="/logout"><button type="submit">Sign out of Upstream ID</button></form>`
          : `<h1>Upstream ID</h1><p>Not signed in.</p><p><a href="/login">Sign in</a></p>`;
        return send(response, 200, page('Upstream ID', body));
      }
      send(response, 404, page('Not found', '<h1>Not found</h1>'));
    } catch {
      if (!response.headersSent) send(response, 400, page('Bad request', '<h1>Bad request</h1>'));
      else response.destroy();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const callbacks = (process.env.UPSTREAM_CALLBACKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (callbacks.length === 0 || !callbacks.every((c) => URL.canParse(c))) {
    console.error("Set UPSTREAM_CALLBACKS: Book Club's callback addresses, comma-separated.");
    process.exit(2);
  }
  const server = createFakeUpstream({ callbacks, passwordSecret: process.env.UPSTREAM_PASSWORD_SECRET || undefined });
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 47101);
  server.listen(port, host, () => console.warn(`fake upstream on http://${host}:${port} (demo only)`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
