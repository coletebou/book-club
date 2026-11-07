import {
  AppCodeBodySchema,
  AppleSignInBodySchema,
  ChangePasswordBodySchema,
  appPath,
  LIMITS,
  ResetPasswordBodySchema,
  SetupBodySchema,
  SignInBodySchema,
  type SignInCode,
  SignInWithCodeBodySchema,
  SignUpBodySchema,
  UpdateMeBodySchema,
  type SessionInfo,
} from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { verifyAppleIdentityToken } from '../auth/apple';
import { resolveExternalUser } from '../auth/external-identity';
import {
  GOOGLE_COOKIE,
  GOOGLE_FLIGHT_MS,
  exchangeGoogleCode,
  googleStartAddress,
  newGoogleFlight,
  openGoogleFlight,
  sealGoogleFlight,
} from '../auth/google';
import { clearSessionCookie, cookieName, cookieOptions, requireUser, signIn } from '../auth/plugin';
import { RateLimiter } from '../auth/ratelimit';
import { UPSTREAM_COOKIE, UPSTREAM_FLIGHT_MS, challengeOf, clip, newFlight, openFlight, redeemCode, redeemPassword, sameState, sealFlight, startAddress } from '../auth/upstream';
import { type AppContext } from '../context';
import { assertRoomToJoin } from '../services/plans';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/crypto';
import { isoRequired } from '../lib/json';
import { HttpError, badRequest, conflict, forbidden, notFound, parse, tooMany, unauthorized } from '../lib/errors';
import { addMember, clubsForUser, countInviteUse, createClub, inviteByCode, membership } from '../repos/clubs';
import { claimSignInCode, issueSignInCode, revokeSignInCodes } from '../repos/codes';
import { claimAppCode, issueAppCode } from '../repos/app-codes';
import { externalProvider } from '../repos/identities';
import { claimResetLink, revokeResetLinks } from '../repos/resets';
import { endSession, endUserSessions } from '../repos/sessions';
import { countUsers, createLocalUser, setPasswordHash, toUser, updateDisplayName, upsertUpstreamUser, userByEmail, userById } from '../repos/users';

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const signInLimiter = new RateLimiter(ctx.config.SIGNIN_ATTEMPTS, 15 * 60_000);
  const signUpLimiter = new RateLimiter(20, 60 * 60_000);
  const signInFailures = new RateLimiter(ctx.config.SIGNIN_ATTEMPTS * 5, 15 * 60_000);
  const passwordLimiter = new RateLimiter(10, 15 * 60_000);
  const resetLimiter = new RateLimiter(20, 15 * 60_000);
  // Each code redeemed is a request to the upstream from this server's one address, out of a budget all
  // of Book Club's sign-ins share (about 90 in 15 minutes): a run of codes that do not sign anyone
  // in (anyone can make one up) stops before it spends that. Those that do are taken back: a
  // household, or the demo stack, is one address for all its browsers.
  const exchangeLimiter = new RateLimiter(ctx.config.SIGNIN_ATTEMPTS, 15 * 60_000);
  // A separate budget for the upstream's password check (D173), per address and email like
  // signInLimiter above: a run of guesses against the upstream must never spend exchangeLimiter's
  // budget, which would also refuse "Continue with <name>" sign-ins for the rest of the window —
  // a real account's correct password, typed right after, looking like a mismatch because the
  // limiter (not the password) failed.
  const upstreamPasswordLimiter = new RateLimiter(ctx.config.SIGNIN_ATTEMPTS, 15 * 60_000);
  const codeIssueLimiter = new RateLimiter(10, 15 * 60_000);
  const codeLimiter = new RateLimiter(10, 15 * 60_000);
  // Wrong codes from every address together: guessing one of the few codes that work at a time
  // must take far longer than they last, from however many addresses.
  const codeFailures = new RateLimiter(50, 15 * 60_000);
  // Native "Sign in with Apple" (D178): a failed verification (a bad token, a stale nonce) is an
  // attempt like any other password guess, budgeted the same way, per address.
  const appleLimiter = new RateLimiter(ctx.config.SIGNIN_ATTEMPTS, 15 * 60_000);
  // "Continue with Google" (D178): the callback is where a code, once Google has sent it to this
  // browser, gets spent — budgeted per address like the upstream grant's own exchangeLimiter above,
  // separately, since the two providers share no budget with each other or with local sign-in.
  const googleLimiter = new RateLimiter(ctx.config.SIGNIN_ATTEMPTS, 15 * 60_000);
  // Redeeming the app's own one-time handoff code (POST /api/auth/app-code): wrong or reused
  // verifiers from one address, bounded the same way a guessed sign-in code would be.
  const appCodeLimiter = new RateLimiter(ctx.config.SIGNIN_ATTEMPTS, 15 * 60_000);

  app.get('/api/session', async (request): Promise<SessionInfo> => ({
    user: request.user ? toUser(request.user, externalProvider(ctx.db, request.user.id)) : null,
    setupRequired: ctx.config.WEB_SETUP && countUsers(ctx.db) === 0,
    upstream: ctx.config.upstream ? { name: ctx.config.upstream.name, password: ctx.config.upstream.passwordUrl !== null } : null,
    providers: { apple: ctx.config.apple !== null, google: ctx.config.google !== null },
  }));

  /**
   * "Continue with <name>" (D116). Signed in here already: go on to `next`. Otherwise to the
   * upstream's sign-in grant, with a state and a PKCE challenge, the sign-in under way kept on this
   * device in a cookie of its own for ten minutes.
   */
  app.get('/api/auth/upstream', async (request, reply) => {
    const upstream = ctx.config.upstream;
    if (!upstream) throw notFound();
    const query = request.query as Record<string, unknown>;
    // As the browser will read it (dot segments resolved, beyond-ASCII encoded), so it is safe as a Location.
    const next = typeof query.next === 'string' ? (appPath(query.next) ?? '/') : '/';
    // Only this app's own pages start a sign-in. Another site, or a sibling subdomain (the
    // upstream's tenants' sites among them), sending a browser here could sign the person back in
    // through the upstream after they signed out here: it gets the button instead.
    const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return reply.redirect(`/signin?next=${encodeURIComponent(next)}`, 303);
    if (request.user) return reply.redirect(next, 303);
    const flight = newFlight(next);
    reply.setCookie(cookieName(ctx, request, UPSTREAM_COOKIE), sealFlight(flight), { ...cookieOptions(ctx, request), maxAge: UPSTREAM_FLIGHT_MS / 1000 });
    return reply.redirect(startAddress(upstream, flight, request.hostname), 303);
  });

  /**
   * The way back from the upstream (D116), with `state` and `code`, or `error`. The sign-in under
   * way on this device must be here, in time, with the state the browser left with: someone
   * else's code sent to this browser (to sign it in as them) finds none of that, and is refused.
   * Then this server redeems the code, and the person is signed in here as the upstream knows them.
   */
  app.get('/api/auth/upstream/callback', async (request, reply) => {
    const upstream = ctx.config.upstream;
    if (!upstream) throw notFound();
    const query = request.query as Record<string, unknown>;
    const name = cookieName(ctx, request, UPSTREAM_COOKIE);
    const flight = openFlight(request.cookies[name]);
    // One way back for each sign-in, whatever it brings.
    if (request.cookies[name] !== undefined) reply.clearCookie(name, cookieOptions(ctx, request));
    const next = flight?.next ?? '/';
    // Logged without the code, the verifier or the cookie.
    const refuse = (reason: string, detail: Record<string, unknown> = {}) => {
      request.log.warn({ reason, ...detail }, 'upstream sign-in refused');
      return reply.redirect(`/signin?upstream=refused&next=${encodeURIComponent(next)}`, 303);
    };
    // With or without the state (the upstream sends none when it lost its own transaction), whatever this device holds.
    if (query.error !== undefined) return refuse('the upstream did not sign them in', { error: typeof query.error === 'string' ? query.error.slice(0, 40) : 'more than one' });
    if (!flight) return refuse('no sign-in under way on this device');
    if (flight.expires <= Date.now()) return refuse('the sign-in took too long');
    if (!sameState(query.state, flight.state)) return refuse('not the state this device left with');
    if (typeof query.code !== 'string' || query.code === '' || query.code.length > 512) return refuse('no code');
    // Signed in here meanwhile (in another tab): they go on as who they are.
    if (request.user) return reply.redirect(next, 303);
    if (!exchangeLimiter.attempt(request.ip)) return refuse('too many sign-ins from this address');
    const redeemed = await redeemCode(ctx, upstream, query.code, flight.verifier);
    if ('refused' in redeemed) return refuse(redeemed.refused, redeemed.detail);
    const user = upsertUpstreamUser(ctx.db, redeemed.identity);
    if (user.disabled_at !== null) return refuse('the account is disabled here');
    exchangeLimiter.forgive(request.ip);
    signIn(ctx, request, reply, user);
    return reply.redirect(next, 303);
  });

  /**
   * Native "Sign in with Apple" (D178): the app already has an identity token from
   * `expo-apple-authentication`, gotten in-process — there is no round trip through this server
   * to start, unlike the upstream grant above. This verifies what Apple signed (auth/apple.ts) and
   * signs the person in. A refused verification and a disabled account answer the same generic
   * 401 as a wrong local password: nothing here distinguishes why.
   */
  app.post('/api/auth/apple', async (request, reply) => {
    const apple = ctx.config.apple;
    if (!apple) throw notFound();
    const body = parse(AppleSignInBodySchema, request.body);
    if (!appleLimiter.attempt(request.ip)) throw tooMany();
    const verified = await verifyAppleIdentityToken(apple, body.identityToken, body.nonce);
    if ('refused' in verified) {
      request.log.warn({ reason: verified.refused }, 'Apple sign-in refused');
      throw unauthorized();
    }
    appleLimiter.forgive(request.ip);
    const named = body.fullName?.trim() || verified.identity.email?.slice(0, verified.identity.email.indexOf('@')) || 'Reader';
    const { user, revokedOtherSessions } = resolveExternalUser(ctx.db, request.log, {
      provider: 'apple',
      subject: verified.identity.subject,
      email: verified.identity.email,
      emailVerified: verified.identity.emailVerified,
      displayName: clip(named, LIMITS.displayName).trim() || 'Reader',
    });
    if (user.disabled_at !== null) throw unauthorized();
    // A verified email just took this account over from a local password (external-identity.ts):
    // its HTTP sessions are already gone; its live realtime sockets are not, until told (PR #25
    // review), the same `hub.revalidate`/`hub.disconnectUser` pair password change and
    // sign-out-everywhere use.
    if (revokedOtherSessions) {
      ctx.hub.revalidate();
      ctx.hub.disconnectUser(user.id);
    }
    signIn(ctx, request, reply, user);
    return { user: toUser(user, externalProvider(ctx.db, user.id)) };
  });

  /**
   * "Continue with Google" (D178), browser or app: this device's own flight (state, PKCE
   * verifier, and, for the app, the app's own separate PKCE challenge) in a sealed cookie, and
   * off to Google's authorization endpoint (auth/google.ts). `app=1` marks the app's own flow
   * (step 4 of auth/google.ts's own comment), which hands a one-time code back into the WebView
   * instead of setting a cookie in this ephemeral browser session.
   */
  app.get('/api/auth/google/start', async (request, reply) => {
    const google = ctx.config.google;
    if (!google) throw notFound();
    const query = request.query as Record<string, unknown>;
    const next = typeof query.next === 'string' ? (appPath(query.next) ?? '/') : '/';
    const isApp = query.app === '1' || query.app === 'true';
    const appChallenge = typeof query.challenge === 'string' ? query.challenge : null;
    if (isApp && (!appChallenge || !/^[A-Za-z0-9_-]{43}$/.test(appChallenge))) throw badRequest('A native sign-in needs a PKCE challenge.');
    // Only this app's own pages, or the app's own ASWebAuthenticationSession (a user-initiated top
    // navigation to this address, not embedded in another site's page: no Sec-Fetch-Site at all,
    // or "none" — never "cross-site"/"same-site"), start a sign-in. The same guard
    // GET /api/auth/upstream uses above (PR #25 review: this route had none at all).
    const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return reply.redirect(`/signin?next=${encodeURIComponent(next)}`, 303);
    // Never for the app's own handoff: ASWebAuthenticationSession shares Safari's cookies by
    // default, so a Book Club session already open in Safari would otherwise make this redirect
    // straight to `next` instead of ever reaching Google — the native engine then gets no
    // `bookclub://auth` code at all, and the WebView stays signed out (PR #25 review).
    if (!isApp && request.user) return reply.redirect(next, 303);
    const flight = newGoogleFlight(next, isApp ? appChallenge : null);
    reply.setCookie(cookieName(ctx, request, GOOGLE_COOKIE), sealGoogleFlight(flight), { ...cookieOptions(ctx, request), maxAge: GOOGLE_FLIGHT_MS / 1000 });
    return reply.redirect(googleStartAddress(google, flight), 303);
  });

  /**
   * The way back from Google (D178), with `state` and `code`, or `error`. A browser sign-in gets a
   * session cookie and goes on to `next`, exactly like the upstream callback above; the app's own
   * flow (the flight's `appChallenge`) instead mints a one-time code bound to that challenge
   * (`repos/app-codes.ts`) and sends the browser (really `WebBrowser.openAuthSessionAsync`'s
   * ephemeral session) to `bookclub://auth?code=…`, which the app's own redirect handler in Expo
   * recognises as its sign-in finishing.
   */
  app.get('/api/auth/google/callback', async (request, reply) => {
    const google = ctx.config.google;
    if (!google) throw notFound();
    const query = request.query as Record<string, unknown>;
    const name = cookieName(ctx, request, GOOGLE_COOKIE);
    const flight = openGoogleFlight(request.cookies[name]);
    if (request.cookies[name] !== undefined) reply.clearCookie(name, cookieOptions(ctx, request));
    const next = flight?.next ?? '/';
    const refuse = (reason: string, detail: Record<string, unknown> = {}) => {
      request.log.warn({ reason, ...detail }, 'Google sign-in refused');
      // Its own query param, not `upstream=refused`: that one names the upstream account by its
      // configured name (SignInPage.tsx), which would misname a Google failure as an upstream one.
      return reply.redirect(`/signin?google=refused&next=${encodeURIComponent(next)}`, 303);
    };
    if (query.error !== undefined) return refuse('Google did not sign them in', { error: typeof query.error === 'string' ? query.error.slice(0, 40) : 'more than one' });
    if (!flight) return refuse('no sign-in under way on this device');
    if (flight.expires <= Date.now()) return refuse('the sign-in took too long');
    if (!sameState(query.state, flight.state)) return refuse('not the state this device left with');
    if (typeof query.code !== 'string' || query.code === '' || query.code.length > 512) return refuse('no code');
    if (!flight.appChallenge && request.user) return reply.redirect(next, 303);
    if (!googleLimiter.attempt(request.ip)) return refuse('too many sign-ins from this address');
    const redeemed = await exchangeGoogleCode(ctx, google, query.code, flight.verifier);
    if ('refused' in redeemed) return refuse(redeemed.refused, redeemed.detail);
    const displayName = clip(redeemed.identity.displayName, LIMITS.displayName).trim() || 'Reader';
    const { user, revokedOtherSessions } = resolveExternalUser(ctx.db, request.log, {
      provider: 'google',
      subject: redeemed.identity.subject,
      email: redeemed.identity.email,
      emailVerified: redeemed.identity.emailVerified,
      displayName,
    });
    if (user.disabled_at !== null) return refuse('the account is disabled here');
    googleLimiter.forgive(request.ip);
    // Same as the Apple route above: a password holder a verified email just took over from keeps
    // no live realtime socket either (PR #25 review).
    if (revokedOtherSessions) {
      ctx.hub.revalidate();
      ctx.hub.disconnectUser(user.id);
    }
    if (flight.appChallenge) {
      // Handed to the app, not signed in on this (ephemeral browser) session: the WebView redeems
      // this code with the matching verifier (POST /api/auth/app-code), which is where its own
      // session cookie actually lands (D133).
      const { code } = issueAppCode(ctx.db, user.id, flight.appChallenge);
      return reply.redirect(`bookclub://auth?code=${encodeURIComponent(code)}`, 303);
    }
    signIn(ctx, request, reply, user);
    return reply.redirect(next, 303);
  });

  /**
   * The app redeems its native Google sign-in's one-time code from inside the WebView (D178), so
   * that the session cookie this sets lands in the shared cookie store native playback also reads
   * (D133) rather than in the ephemeral browser session that talked to Google.
   */
  app.post('/api/auth/app-code', async (request, reply) => {
    if (!appCodeLimiter.attempt(request.ip)) throw tooMany();
    const body = parse(AppCodeBodySchema, request.body);
    const userId = claimAppCode(ctx.db, body.code, challengeOf, body.verifier);
    const user = userId ? userById(ctx.db, userId) : undefined;
    if (!user || user.disabled_at !== null) {
      throw new HttpError(401, 'invalid_code', 'That sign-in did not finish. Try Continue with Google again.');
    }
    appCodeLimiter.forgive(request.ip);
    signIn(ctx, request, reply, user);
    return { user: toUser(user, externalProvider(ctx.db, user.id)) };
  });

  /** First run: create the owner account (and optionally the first club). */
  app.post('/api/setup', async (request, reply) => {
    if (!ctx.config.WEB_SETUP) throw forbidden('This Book Club is set up with the bookclub create-owner command.');
    const body = parse(SetupBodySchema, request.body);
    const passwordHash = await hashPassword(body.password);
    const user = ctx.db.tx(() => {
      if (countUsers(ctx.db) > 0) throw conflict('This Book Club is already set up. Sign in instead.');
      const u = createLocalUser(ctx.db, { displayName: body.displayName, email: body.email, passwordHash });
      if (body.clubName) createClub(ctx.db, { name: body.clubName, description: '', ownerId: u.id });
      return u;
    });
    signIn(ctx, request, reply, user);
    return reply.code(201).send({ user: toUser(user), clubs: clubsForUser(ctx.db, user.id) });
  });

  app.post('/api/auth/signin', async (request, reply) => {
    const body = parse(SignInBodySchema, request.body);
    const key = `${request.ip}|${body.email}`;
    // Per address and email, and per address alone (so cycling emails buys nothing); attempts
    // count while they are checked, so a burst cannot slip past, and successes are taken back.
    // Both branches below share this one budget: typing the upstream's password here instead of
    // its page (D173) is still a sign-in attempt, not a second thing to guess at for free.
    if (!signInLimiter.attempt(key)) throw tooMany();
    if (!signInFailures.attempt(request.ip)) {
      signInLimiter.forgive(key);
      throw tooMany();
    }
    const local = userByEmail(ctx.db, body.email);
    // A local account with a password signs in as it always has, never asking the upstream.
    if (local?.password_hash) {
      const ok = await verifyPassword(body.password, local.password_hash);
      if (!ok || local.disabled_at !== null) throw new HttpError(401, 'invalid_credentials', 'That email and password do not match.');
      signInLimiter.reset(key);
      signInFailures.forgive(request.ip);
      signIn(ctx, request, reply, local);
      return { user: toUser(local) };
    }
    // No local account, or one made from the upstream with no password of its own here (D173):
    // one scrypt against a hash nobody has, so the two cases take the same time either way, then
    // the upstream's own password check, if it offers one.
    await verifyPassword(body.password, DUMMY_PASSWORD_HASH);
    const upstream = ctx.config.upstream;
    if (!upstream?.passwordUrl || !upstreamPasswordLimiter.attempt(key)) {
      throw new HttpError(401, 'invalid_credentials', 'That email and password do not match.');
    }
    const redeemed = await redeemPassword(ctx, upstream, body.email, body.password, request.ip);
    if ('refused' in redeemed) {
      request.log.warn({ reason: redeemed.refused, ...redeemed.detail }, 'upstream password sign-in refused');
      throw new HttpError(401, 'invalid_credentials', 'That email and password do not match.');
    }
    const user = upsertUpstreamUser(ctx.db, redeemed.identity);
    if (user.disabled_at !== null) throw new HttpError(401, 'invalid_credentials', 'That email and password do not match.');
    upstreamPasswordLimiter.forgive(key);
    signInLimiter.reset(key);
    signInFailures.forgive(request.ip);
    signIn(ctx, request, reply, user);
    return { user: toUser(user) };
  });

  /**
   * A one-time code to sign in where you are not (D87): the app on your Home Screen, whose cookies
   * are not the browser's (an upstream friend has no password to type there), or another device.
   */
  app.post('/api/auth/codes', async (request, reply): Promise<SignInCode> => {
    const user = requireUser(request);
    if (!codeIssueLimiter.attempt(user.id)) throw tooMany();
    const { code, expiresAt } = issueSignInCode(ctx.db, user.id);
    reply.code(201);
    return { code, expiresAt: isoRequired(expiresAt) };
  });

  app.post('/api/auth/code', async (request, reply) => {
    if (!codeLimiter.attempt(request.ip) || codeFailures.blocked('all')) throw tooMany();
    const body = parse(SignInWithCodeBodySchema, request.body);
    // Claimed first, in one statement: of two requests with the same code only one wins.
    const userId = claimSignInCode(ctx.db, body.code);
    const user = userId ? userById(ctx.db, userId) : undefined;
    if (!user || user.disabled_at !== null) {
      codeFailures.record('all');
      throw new HttpError(401, 'invalid_code', 'That code does not work. A code works once, for 10 minutes: get a new one where you are signed in.');
    }
    codeLimiter.forgive(request.ip);
    signIn(ctx, request, reply, user);
    return { user: toUser(user, externalProvider(ctx.db, user.id)) };
  });

  /** Join with an invite: creates the account and the membership in one step. */
  app.post('/api/auth/signup', async (request, reply) => {
    const body = parse(SignUpBodySchema, request.body);
    // Per invite link and address: friends joining one club never block another club's joins.
    if (!signUpLimiter.attempt(`${request.ip}|${body.inviteCode}`)) throw tooMany();
    const invite = inviteByCode(ctx.db, body.inviteCode);
    if (!invite) throw new HttpError(404, 'invite_invalid', 'This invite link is no longer valid. Ask for a new one.');
    // A club at its plan's member limit takes nobody new (D208), before an account is made for it.
    assertRoomToJoin(ctx, invite.club_id);
    const passwordHash = await hashPassword(body.password);
    const user = ctx.db.tx(() => {
      if (userByEmail(ctx.db, body.email)) {
        throw new HttpError(409, 'email_taken', 'There is already an account with that email. Sign in to join.', { email: 'Already registered' });
      }
      const u = createLocalUser(ctx.db, { displayName: body.displayName, email: body.email, passwordHash });
      addMember(ctx.db, invite.club_id, u.id);
      countInviteUse(ctx.db, invite.code);
      return u;
    });
    signIn(ctx, request, reply, user);
    ctx.hub.publish(invite.club_id, () => ({ type: 'club:changed', clubId: invite.club_id }));
    return reply.code(201).send({ user: toUser(user), clubId: invite.club_id });
  });

  app.post('/api/auth/signout', async (request, reply) => {
    if (request.sessionToken) endSession(ctx.db, request.sessionToken);
    ctx.hub.revalidate();
    clearSessionCookie(ctx, request, reply);
    // Wipe cached books and data from this device (v1 cached auth-gated media publicly).
    reply.header('Clear-Site-Data', '"cache", "storage"');
    return reply.code(204).send();
  });

  app.post('/api/auth/signout-everywhere', async (request, reply) => {
    const user = requireUser(request);
    endUserSessions(ctx.db, user.id);
    revokeSignInCodes(ctx.db, user.id);
    ctx.hub.disconnectUser(user.id);
    clearSessionCookie(ctx, request, reply);
    reply.header('Clear-Site-Data', '"cache", "storage"');
    return reply.code(204).send();
  });

  app.get('/api/me', async (request) => {
    const user = requireUser(request);
    return { user: toUser(user, externalProvider(ctx.db, user.id)), clubs: clubsForUser(ctx.db, user.id) };
  });

  app.patch('/api/me', async (request) => {
    const user = requireUser(request);
    const body = parse(UpdateMeBodySchema, request.body);
    // Only the upstream grant's own name is kept in sync from elsewhere (D116); a native Apple or
    // Google sign-in hands over a name only once, on the very first sign-in (D178), so there is
    // nothing ongoing for an edit here to fight with.
    if (user.upstream_subject && body.displayName !== undefined) throw badRequest('Your name comes from your main account.');
    if (body.displayName !== undefined) updateDisplayName(ctx.db, user.id, body.displayName);
    const updated = userById(ctx.db, user.id)!;
    return { user: toUser(updated, externalProvider(ctx.db, updated.id)) };
  });

  app.post('/api/me/password', async (request, reply) => {
    const user = requireUser(request);
    if (!passwordLimiter.attempt(user.id)) throw tooMany();
    const body = parse(ChangePasswordBodySchema, request.body);
    if (!user.password_hash || !(await verifyPassword(body.currentPassword, user.password_hash))) {
      throw new HttpError(400, 'invalid_credentials', 'Your current password is not right.', { currentPassword: 'Incorrect' });
    }
    const passwordHash = await hashPassword(body.newPassword);
    ctx.db.tx(() => {
      setPasswordHash(ctx.db, user.id, passwordHash);
      endUserSessions(ctx.db, user.id, request.sessionToken ?? undefined);
      // A reset link made before the change (perhaps still in a chat) no longer opens the account,
      // nor does a sign-in code.
      revokeResetLinks(ctx.db, user.id);
      revokeSignInCodes(ctx.db, user.id);
    });
    ctx.hub.revalidate();
    return reply.code(204).send();
  });

  /** Redeem an owner-issued reset link. */
  app.post('/api/auth/reset', async (request) => {
    if (!resetLimiter.attempt(request.ip)) throw tooMany();
    const body = parse(ResetPasswordBodySchema, request.body);
    // Claim the link first, in one statement: of two requests with the same link only one wins.
    const row = claimResetLink(ctx.db, body.token);
    if (!row) throw unauthorized('This reset link has expired. Ask your club owner for a new one.');
    // An owner's link opens the account only while they still run every club it is in (the
    // person may have joined another club since the link was made). The admin's links always do.
    if (row.created_by !== row.user_id && clubsForUser(ctx.db, row.user_id).some((c) => membership(ctx.db, c.id, row.created_by)?.role !== 'owner')) {
      throw forbidden('This reset link can no longer be used. Ask your club owner for a new one.');
    }
    const passwordHash = await hashPassword(body.newPassword);
    ctx.db.tx(() => {
      setPasswordHash(ctx.db, row.user_id, passwordHash);
      endUserSessions(ctx.db, row.user_id);
      revokeResetLinks(ctx.db, row.user_id);
      revokeSignInCodes(ctx.db, row.user_id);
    });
    ctx.hub.disconnectUser(row.user_id);
    const user = userById(ctx.db, row.user_id)!;
    return { user: toUser(user), email: user.email };
  });
}
