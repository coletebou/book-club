/**
 * A stand-in for Google's own OAuth/OpenID endpoints, for the demo stack and its E2E suite
 * (D178): a minimal authorization-code-with-PKCE grant and the OpenID Connect pieces Book Club's
 * server actually reads (the JWKS, an id_token), and nothing else. One file, no dependencies —
 * ES256 JWT signing uses only `node:crypto`, the same way `tools/fake-upstream/server.mjs` (D116)
 * needs none for its HMAC-signed cookies.
 *
 *   GET  /o/oauth2/v2/auth?client_id=&redirect_uri=&response_type=code&scope=&state=&
 *          code_challenge=&code_challenge_method=S256
 *          checks them, keeps them in a signed cookie (the flow, 10 minutes) and shows a sign-in
 *          form (signed in already: straight back to redirect_uri)
 *   GET/POST /login             a sign-in form; POST starts this stand-in's own session and goes
 *          on to the grant's own completion
 *   GET  /complete               signed in: a code good once, for 90 seconds, bound to the
 *          challenge, back to redirect_uri with `state` and `code`
 *   POST /token                  { client_id, client_secret, code, code_verifier, redirect_uri,
 *          grant_type=authorization_code } → { id_token, access_token, token_type: "Bearer" }
 *   GET  /certs                  this stand-in's own JWKS (one ES256 key), for the server's
 *          `createRemoteJWKSet` to verify the id_token against, exactly as it would Google's real
 *          https://www.googleapis.com/oauth2/v3/certs
 *   POST /logout, GET /          as fake-upstream's
 *
 * Accounts (password `google-demo` for all): ana@google.test, gus@google.test (an unverified
 * address: gus's id_token reports email_verified: false), and any other address at google.test.
 * Demo only: never run this anywhere but a developer's own machine or CI.
 *
 *   GOOGLE_CALLBACKS=http://127.0.0.1:47100/api/auth/google/callback \
 *   GOOGLE_CLIENT_ID=bookclub-demo.apps.googleusercontent.com \
 *   GOOGLE_CLIENT_SECRET=whatever-book-club-presents \
 *   node tools/fake-google/server.mjs
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as cryptoSign, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEMO_PASSWORD = 'google-demo';
export const SESSION_COOKIE = 'google_demo_session';
const FLOW_COOKIE = 'google_demo_flow';
const KID = 'fake-google-1';

const STATE = /^[A-Za-z0-9_-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_MS = 90_000;
const FLOW_MS = 10 * 60_000;
const SESSION_MS = 12 * 3600_000;

const KNOWN = new Map([
  ['ana@google.test', { name: 'Ana', emailVerified: true }],
  ['gus@google.test', { name: 'Gus', emailVerified: false }],
]);

/** The Google account behind an address, or null if there is none (the demo's own closed set). */
export function account(email) {
  const address = String(email).trim().toLowerCase();
  if (!/^[a-z0-9._+-]{1,64}@google\.test$/.test(address)) return null;
  const known = KNOWN.get(address);
  const local = address.slice(0, address.indexOf('@'));
  const word = /[a-z]+/.exec(local)?.[0] ?? 'reader';
  return {
    sub: createHash('sha256').update(address).digest('hex').slice(0, 21),
    email: address,
    name: known?.name ?? word[0].toUpperCase() + word.slice(1),
    emailVerified: known ? known.emailVerified : true,
  };
}

const sha256 = (text) => createHash('sha256').update(text).digest();
const sameText = (a, b) => timingSafeEqual(sha256(String(a)), sha256(String(b)));
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A signed ES256 id_token, built with only `node:crypto` (no `jose`: this is the demo image). */
function signIdToken(privateKey, claims) {
  const header = { alg: 'ES256', typ: 'JWT', kid: KID };
  const segment = (obj) => b64url(JSON.stringify(obj));
  const signingInput = `${segment(header)}.${segment(claims)}`;
  // JOSE's ES256 wants a fixed-length r||s signature ("ieee-p1363"), not the DER Node signs by
  // default: without this option a real JWT library's verifier (jose's `jwtVerify`, used by the
  // real server) rejects the token outright.
  const signature = cryptoSign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

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
<title>${escape(title)} · Google (demo)</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #fff; color: #202124; font: 16px/1.5 Roboto, system-ui, sans-serif; }
  main { width: min(100% - 32px, 380px); display: grid; gap: 14px; border: 1px solid #dadce0; border-radius: 8px; padding: 24px; }
  h1 { margin: 0; font-size: 1.5rem; } .demo { color: #5f6368; font-size: 0.9rem; margin: 0; }
  label { display: grid; gap: 4px; font-size: 0.95rem; }
  input { font: inherit; padding: 10px 12px; border-radius: 4px; border: 1px solid #dadce0; }
  button { font: inherit; padding: 11px 14px; border-radius: 4px; border: 0; background: #1a73e8; color: #fff; font-weight: 600; cursor: pointer; }
  .error { color: #d93025; margin: 0; } form { display: grid; gap: 12px; }
</style></head>
<body><main>${body}</main></body></html>`;
}

const loginForm = (returnTo, error = '', email = '') =>
  page(
    'Sign in',
    `<h1>Google</h1>
<p class="demo">A stand-in for accounts.google.com on this computer (D178). Demo accounts: ana@google.test, gus@google.test (unverified email), password ${DEMO_PASSWORD}.</p>
<form method="post" action="/login">
  ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
  <input type="hidden" name="returnTo" value="${escape(returnTo)}">
  <label>Email <input name="email" type="email" autocomplete="username" required value="${escape(email)}"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in to Google</button>
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

/** The Google stand-in as an HTTP server (not yet listening). */
export function createFakeGoogle(options) {
  const key = randomBytes(32);
  const now = options.now ?? Date.now;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' };
  /** Authorization codes not yet redeemed, by their SHA-256: for whom, which challenge, until when. */
  const codes = new Map();

  const mac = (payload) => createHmac('sha256', key).update(payload).digest('base64url');
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
  const fromItsOwnPage = (request, host) => {
    const site = request.headers['sec-fetch-site'];
    const origin = request.headers.origin;
    return (site === undefined || site === 'same-origin' || site === 'none') && (origin === undefined || origin === host.origin);
  };
  const invalidGrant = { error: 'invalid_grant' };

  return createServer(async (request, response) => {
    try {
      const host = new URL(`http://${request.headers.host ?? '127.0.0.1'}`);
      const url = new URL(request.url ?? '/', host);
      const authorizePath = '/o/oauth2/v2/auth';

      if (request.method === 'GET' && url.pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/certs') {
        return json(response, 200, { keys: [jwk] });
      }
      if (request.method === 'GET' && url.pathname === authorizePath) {
        const clientId = url.searchParams.get('client_id') ?? '';
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const challenge = url.searchParams.get('code_challenge') ?? '';
        const ok =
          clientId === options.clientId &&
          options.callbacks.some((c) => c === redirectUri) &&
          STATE.test(state) &&
          CHALLENGE.test(challenge) &&
          url.searchParams.get('code_challenge_method') === 'S256';
        if (!ok) return send(response, 400, page('Refused', '<h1>Google</h1><p class="error">That is not a sign-in Google starts.</p>'));
        const flow = seal({ state, challenge, redirectUri }, FLOW_MS);
        return redirect(response, '/login', { 'set-cookie': cookie(FLOW_COOKIE, flow, '/', FLOW_MS) });
      }
      if (request.method === 'GET' && url.pathname === '/login') {
        if (signedIn(request)) return redirect(response, '/complete');
        return send(response, 200, loginForm(''));
      }
      if (request.method === 'POST' && !fromItsOwnPage(request, host)) {
        return send(response, 403, page('Refused', '<h1>Google</h1><p class="error">Sign in from Google\'s own page.</p>'));
      }
      if (request.method === 'POST' && url.pathname === '/login') {
        const form = new URLSearchParams(await readBody(request));
        const who = account(form.get('email') ?? '');
        if (!who || !sameText(form.get('password') ?? '', DEMO_PASSWORD)) {
          return send(response, 401, loginForm('', 'Wrong email or password.', form.get('email') ?? ''));
        }
        return redirect(response, '/complete', { 'set-cookie': cookie(SESSION_COOKIE, seal({ email: who.email }, SESSION_MS), '/', SESSION_MS) });
      }
      if (request.method === 'GET' && url.pathname === '/complete') {
        const flow = unseal(cookies(request).get(FLOW_COOKIE));
        const endFlow = cookie(FLOW_COOKIE, '', '/', 0);
        if (!flow) return send(response, 400, page('Expired', '<h1>Google</h1><p class="error">That sign-in expired. Start again.</p>'), { 'set-cookie': endFlow });
        const who = signedIn(request);
        if (!who) return redirect(response, '/login');
        forget();
        const code = randomBytes(32).toString('base64url');
        codes.set(sha256(code).toString('hex'), { who, challenge: flow.challenge, expires: now() + CODE_MS });
        return redirect(response, `${flow.redirectUri}?state=${encodeURIComponent(flow.state)}&code=${code}`, { 'set-cookie': endFlow });
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers['content-type'] ?? '')) return json(response, 400, invalidGrant);
        const form = new URLSearchParams(await readBody(request));
        const code = form.get('code') ?? '';
        const verifier = form.get('code_verifier') ?? '';
        if (form.get('client_id') !== options.clientId || form.get('client_secret') !== options.clientSecret || form.get('grant_type') !== 'authorization_code') {
          return json(response, 401, invalidGrant);
        }
        forget();
        const hash = sha256(code).toString('hex');
        const grant = codes.get(hash);
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!grant || grant.expires <= now() || !VERIFIER.test(verifier) || !sameText(challenge, grant.challenge)) return json(response, 400, invalidGrant);
        codes.delete(hash);
        const iat = Math.floor(now() / 1000);
        const idToken = signIdToken(privateKey, {
          iss: `${host.origin}`,
          aud: options.clientId,
          sub: grant.who.sub,
          email: grant.who.email,
          email_verified: grant.who.emailVerified,
          name: grant.who.name,
          iat,
          exp: iat + 600,
        });
        return json(response, 200, { id_token: idToken, access_token: randomBytes(16).toString('hex'), token_type: 'Bearer' });
      }
      if (request.method === 'POST' && url.pathname === '/logout') {
        return redirect(response, '/', { 'set-cookie': cookie(SESSION_COOKIE, '', '/', 0) });
      }
      if (request.method === 'GET' && url.pathname === '/') {
        const who = signedIn(request);
        const body = who
          ? `<h1>Google</h1><p>Signed in as ${escape(who.name)} (${escape(who.email)}).</p><form method="post" action="/logout"><button type="submit">Sign out of Google</button></form>`
          : `<h1>Google</h1><p>Not signed in.</p><p><a href="/login">Sign in</a></p>`;
        return send(response, 200, page('Google', body));
      }
      send(response, 404, page('Not found', '<h1>Not found</h1>'));
    } catch {
      if (!response.headersSent) send(response, 400, page('Bad request', '<h1>Bad request</h1>'));
      else response.destroy();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const callbacks = (process.env.GOOGLE_CALLBACKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const clientId = process.env.GOOGLE_CLIENT_ID ?? '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  if (callbacks.length === 0 || !clientId || !clientSecret) {
    console.error('Set GOOGLE_CALLBACKS, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    process.exit(2);
  }
  const server = createFakeGoogle({ callbacks, clientId, clientSecret });
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 47102);
  server.listen(port, host, () => console.warn(`fake Google on http://${host}:${port} (demo only)`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
