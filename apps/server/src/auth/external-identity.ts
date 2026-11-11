import { type Db } from '../db/db';
import { revokeSignInCodes } from '../repos/codes';
import { identityByProviderSubject, linkIdentity, type Provider } from '../repos/identities';
import { revokeResetLinks } from '../repos/resets';
import { endUserSessions } from '../repos/sessions';
import {
  type UserRow,
  type VerifiedEmailMatch,
  accountForVerifiedEmail,
  clearPasswordHash,
  createIdentityUser,
  createUpstreamUser,
  followMerge,
  refreshFromUpstream,
  setUpstreamSubject,
  userByEmail,
  userById,
  userByUpstream,
} from '../repos/users';
import { type UpstreamIdentity } from './upstream';

export interface ExternalIdentity {
  readonly provider: Provider;
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string;
}

export interface LinkOutcome {
  readonly user: UserRow;
  /** True when linking this identity revoked another session of the same account (see below). */
  readonly revokedOtherSessions: boolean;
}

/**
 * Whether the account a sign-in resolved to may be signed in to. Not a disabled one, which every
 * merged account is (D228), and never an agent's row (D204), whatever its `disabled_at` says: the
 * one check each sign-in route makes on what `resolveExternalUser` or `upsertUpstreamUser` found.
 */
export function takesSignIn(user: UserRow): boolean {
  return user.disabled_at === null && user.agent === null && user.merged_into === null;
}

export interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const NO_MATCH: VerifiedEmailMatch = { kind: 'none' };

/**
 * The provider's proof wins outright (D178, and D228 for the upstream): an account whose address a
 * provider has just proved belongs to whoever signed in, not to whoever typed a password against
 * that address first (Book Club never verifies an address itself, D14). So a password still on the
 * account is cleared, and with it everything that password's holder could come back with: every
 * session, every unused reset link and every unused sign-in code. Says whether there was one; the
 * caller then closes the account's live sockets too (`hub.revalidate`, `hub.disconnectUser`).
 * Logged without the token, the password or any other secret.
 */
function takeOverFromPassword(db: Db, log: Logger, user: UserRow, provider: Provider | 'upstream'): boolean {
  if (user.password_hash === null) return false;
  clearPasswordHash(db, user.id);
  endUserSessions(db, user.id);
  revokeResetLinks(db, user.id);
  revokeSignInCodes(db, user.id);
  log.warn(
    { provider, userId: user.id },
    `a verified email linked ${provider === 'upstream' ? 'an upstream' : 'a native'} sign-in to a local password account: its password was cleared and its other sessions revoked`,
  );
  return true;
}

/** An address that led to an account no sign-in may have: nothing is linked, and the caller refuses it (`takesSignIn`). */
function refused(log: Logger, provider: Provider | 'upstream', user: UserRow): LinkOutcome {
  log.warn({ provider, userId: user.id }, 'a verified email matched an account that takes no sign-in (disabled, or an agent’s): nothing was linked');
  return { user, revokedOtherSessions: false };
}

/**
 * Who signs in for a native Apple or Google identity (D178), checked in this order:
 *
 *  1. Signed in before with this exact (provider, subject): that account, unconditionally (led on
 *     to the account it was merged into, if it was, D228).
 *  2. A verified email the provider vouches for matches an existing account's: that account.
 *     Book Club never verifies an email itself (D14, local sign-up takes whatever address is
 *     typed), so an account's email on file is not provably theirs until a provider that does
 *     verify email ownership (Apple always; Google when `email_verified`) proves it — and the
 *     provider's proof wins outright: if the matched account is local and still has a password
 *     of its own, linking clears that password (PR #25 review: left in place, whoever typed a
 *     password against this email first kept durable access to the real owner's account after
 *     they linked) and revokes its other sessions, logging why (never the token, the password, or
 *     any secret). The caller closes that account's live realtime sockets too when
 *     `revokedOtherSessions` comes back true (routes/auth.ts, the same `hub.revalidate`/
 *     `hub.disconnectUser` pair password change and sign-out-everywhere use) — a takeover a
 *     revoked HTTP session can still watch over an open WebSocket is not actually stopped.
 *     The owner signs back in with the provider from here on, or gets a password again through an
 *     owner-issued reset link. Never by a private-relay address, never to a disabled account or an
 *     agent's row, and through `merged_into` to the account a merged one went into
 *     (`accountForVerifiedEmail`, D228).
 *  3. Neither: a new account, exactly as the upstream grant makes one (D116) — no password,
 *     free to start a club like any other account (D176's caps apply the same as everywhere else).
 */
export function resolveExternalUser(db: Db, log: Logger, identity: ExternalIdentity): LinkOutcome {
  return db.tx(() => {
    const linked = identityByProviderSubject(db, identity.provider, identity.subject);
    // A trail with no end leaves the merged row itself, which `takesSignIn` refuses.
    if (linked) return { user: followMerge(db, linked) ?? linked, revokedOtherSessions: false };
    const match = identity.emailVerified && identity.email ? accountForVerifiedEmail(db, identity.email) : NO_MATCH;
    if (match.kind === 'refuse') return refused(log, identity.provider, match.user);
    if (match.kind === 'link') {
      const existing = match.user;
      const revoke = takeOverFromPassword(db, log, existing, identity.provider);
      linkIdentity(db, { provider: identity.provider, subject: identity.subject, userId: existing.id, email: identity.email });
      // `existing` was read before the clear above: reflect it here rather than re-querying, so
      // the response this request signs in with (toUser's source) already says so, not "local"
      // for one more round trip.
      return { user: revoke ? { ...existing, password_hash: null } : existing, revokedOtherSessions: revoke };
    }
    // No account to join. The address is kept only if verified and free: one that was not matched
    // above can still be on an account (a private-relay address is never matched, D228), and the
    // column is UNIQUE.
    const email = identity.emailVerified && identity.email && !userByEmail(db, identity.email) ? identity.email : null;
    const user = createIdentityUser(db, { displayName: identity.displayName, email });
    linkIdentity(db, { provider: identity.provider, subject: identity.subject, userId: user.id, email: identity.email });
    return { user, revokedOtherSessions: false };
  });
}

/**
 * Who signs in for an upstream identity (D116, D228), from "Continue with <name>" or the
 * upstream's password typed into this app's own form (D173). The same three steps as
 * `resolveExternalUser` above, and the same rules at each:
 *
 *  1. This upstream subject is known here: that account, its name and address following the
 *     upstream's. An account merged into another leads on to that one, which keeps its own name
 *     and address.
 *  2. A new subject whose address belongs to an account here with no upstream identity yet: that
 *     account is joined to the subject instead of a second, email-less account being made beside
 *     it (D228, superseding D116's "never a local account's address"). `identity.email` is there
 *     only when the upstream said it had verified it (`identityOf`, auth/upstream.ts, the one
 *     place that decides), which is what makes it proof. A local password on the matched account
 *     is cleared and its sessions, reset links and sign-in codes revoked, exactly as for Apple and
 *     Google; the caller closes its live sockets when `revokedOtherSessions` comes back true.
 *     An account that already has a different upstream subject is never joined to a second one:
 *     two upstream accounts are two people until an operator merges them
 *     (`bookclub merge-accounts`), so that sign-in gets an account of its own with no address, as
 *     before, and the clash is logged.
 *  3. Neither: a new account, with the address only if it is free.
 */
export function upsertUpstreamUser(db: Db, log: Logger, identity: UpstreamIdentity): LinkOutcome {
  return db.tx(() => {
    const known = userByUpstream(db, identity.subject);
    if (known) {
      if (known.merged_into !== null) return { user: followMerge(db, known) ?? known, revokedOtherSessions: false };
      return { user: refreshFromUpstream(db, known, identity), revokedOtherSessions: false };
    }
    const match = identity.email ? accountForVerifiedEmail(db, identity.email) : NO_MATCH;
    if (match.kind === 'refuse') return refused(log, 'upstream', match.user);
    if (match.kind === 'link') {
      if (match.user.upstream_subject === null) {
        const revoke = takeOverFromPassword(db, log, match.user, 'upstream');
        setUpstreamSubject(db, match.user.id, identity.subject);
        return { user: refreshFromUpstream(db, userById(db, match.user.id)!, identity), revokedOtherSessions: revoke };
      }
      log.warn(
        { provider: 'upstream', userId: match.user.id },
        'an upstream sign-in’s verified email belongs to an account that already has another upstream identity: not linked, it gets an account of its own',
      );
    }
    const email = identity.email && !userByEmail(db, identity.email) ? identity.email : null;
    return { user: createUpstreamUser(db, { subject: identity.subject, displayName: identity.displayName, email }), revokedOtherSessions: false };
  });
}
