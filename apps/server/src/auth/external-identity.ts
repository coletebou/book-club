import { type Db } from '../db/db';
import { identityByProviderSubject, linkIdentity, type Provider } from '../repos/identities';
import { endUserSessions } from '../repos/sessions';
import { clearPasswordHash, createIdentityUser, type UserRow, userByEmail } from '../repos/users';

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

export interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Who signs in for a native Apple or Google identity (D178), checked in this order:
 *
 *  1. Signed in before with this exact (provider, subject): that account, unconditionally.
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
 *     owner-issued reset link.
 *  3. Neither: a new account, exactly as the upstream grant makes one (D116) — no password,
 *     free to start a club like any other account (D176's caps apply the same as everywhere else).
 */
export function resolveExternalUser(db: Db, log: Logger, identity: ExternalIdentity): LinkOutcome {
  return db.tx(() => {
    const linked = identityByProviderSubject(db, identity.provider, identity.subject);
    if (linked) return { user: linked, revokedOtherSessions: false };
    if (identity.emailVerified && identity.email) {
      const existing = userByEmail(db, identity.email);
      if (existing) {
        const revoke = existing.password_hash !== null;
        if (revoke) {
          clearPasswordHash(db, existing.id);
          endUserSessions(db, existing.id);
          log.warn(
            { provider: identity.provider, userId: existing.id },
            'a verified email linked a native sign-in to a local password account: its password was cleared and its other sessions revoked',
          );
        }
        linkIdentity(db, { provider: identity.provider, subject: identity.subject, userId: existing.id, email: identity.email });
        // `existing` was read before the clear above: reflect it here rather than re-querying, so
        // the response this request signs in with (toUser's source) already says so, not "local"
        // for one more round trip.
        return { user: revoke ? { ...existing, password_hash: null } : existing, revokedOtherSessions: revoke };
      }
    }
    // Reaching here with emailVerified true guarantees no account owns that email yet (userByEmail
    // above would have returned it and ended this call already), so this insert cannot collide
    // with the column's UNIQUE constraint.
    const user = createIdentityUser(db, { displayName: identity.displayName, email: identity.emailVerified ? identity.email : null });
    linkIdentity(db, { provider: identity.provider, subject: identity.subject, userId: user.id, email: identity.email });
    return { user, revokedOtherSessions: false };
  });
}
