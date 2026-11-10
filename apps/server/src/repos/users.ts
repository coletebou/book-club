import { type User, memberColor } from '@bookclub/shared';
import { type Db } from '../db/db';
import { newId } from '../lib/crypto';

export interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  password_hash: string | null;
  upstream_subject: string | null;
  created_at: number;
  disabled_at: number | null;
  /** An agent's handle (migration 024, D204): its row is the author of what it writes in chat, never an account. */
  agent: string | null;
  /** The account this one was merged into (migration 031, D228); such a row is always disabled too. */
  merged_into: string | null;
}

/**
 * `linkedProvider`: which native provider (D178) this account has linked, when it matters to the
 * caller (the signed-in person's own view) and is known without an extra query; omitted
 * elsewhere, where it would not change the answer below. A password on file always wins: linking
 * Apple or Google to an account by a verified email match now *clears* that account's password
 * (D178; the provider proved the email, not whoever typed a password against it first), so the
 * only way an account is both password-holding and provider-linked is the other order — a
 * passwordless account made by a native sign-in, given a password later through an owner's reset
 * link. Either way, a password on file means `source` stays `local` so Settings keeps offering it
 * (its password section gates on exactly this).
 */
export function toUser(row: UserRow, linkedProvider?: 'apple' | 'google'): User {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    color: memberColor(row.id),
    source: row.password_hash !== null ? 'local' : row.upstream_subject ? 'upstream' : linkedProvider ?? 'local',
  };
}

export function userById(db: Db, id: string): UserRow | undefined {
  return db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

export function userByEmail(db: Db, email: string): UserRow | undefined {
  return db.get<UserRow>('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email]);
}

export function userByUpstream(db: Db, subject: string): UserRow | undefined {
  return db.get<UserRow>('SELECT * FROM users WHERE upstream_subject = ?', [subject]);
}

/** A merge leaves one hop (services/account-merge.ts re-points older trails as it goes); a few more are followed, never a loop. */
const MERGE_HOPS = 5;

/**
 * The account a sign-in that found `user` lands in (D228): `user` itself, or, when that account
 * was merged into another, the account at the end of the trail. Undefined when the trail does not
 * end in an account (a loop, a row that is gone, more hops than merging ever leaves); the caller
 * then signs nobody in.
 */
export function followMerge(db: Db, user: UserRow): UserRow | undefined {
  let current = user;
  const seen = new Set([current.id]);
  for (let hops = 0; current.merged_into !== null; hops++) {
    if (hops >= MERGE_HOPS) return undefined;
    const next = userById(db, current.merged_into);
    if (!next || seen.has(next.id)) return undefined;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/**
 * Apple's "Hide My Email" addresses. One is a per-app alias, not a mailbox a person is known by,
 * so it never joins two accounts by itself (D228): an account on one is found by its identity's
 * subject only.
 */
export function isApplePrivateRelay(email: string): boolean {
  return /@privaterelay\.appleid\.com$/i.test(email.trim());
}

/** What a provider-verified address finds here (D228). */
export type VerifiedEmailMatch =
  /** No account to join: the sign-in makes one of its own. */
  | { readonly kind: 'none' }
  /** The account that address belongs to, after any merge: the identity is linked to it. */
  | { readonly kind: 'link'; readonly user: UserRow }
  /** An account that takes no sign-in (disabled, an agent's row, a merge trail with no end): nothing is linked and nobody is signed in. */
  | { readonly kind: 'refuse'; readonly user: UserRow };

/**
 * The account a sign-in may be joined to because its provider proved an address (D178 for Apple
 * and Google, D228 for the upstream): the one that address is on, led on through `merged_into`.
 * Never by a private-relay address, and never an account that is disabled or an agent's row. Only
 * for an address a provider vouches for; an address somebody merely typed proves nothing.
 */
export function accountForVerifiedEmail(db: Db, email: string): VerifiedEmailMatch {
  if (isApplePrivateRelay(email)) return { kind: 'none' };
  const owner = userByEmail(db, email);
  if (!owner) return { kind: 'none' };
  const target = followMerge(db, owner);
  if (!target) return { kind: 'refuse', user: owner };
  if (target.agent !== null || target.disabled_at !== null) return { kind: 'refuse', user: target };
  return { kind: 'link', user: target };
}

/** How many accounts there are: people, never an agent's row (D204), so Cal alone does not set an instance up. */
export function countUsers(db: Db): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE agent IS NULL')?.n ?? 0);
}

/**
 * The row an agent writes chat messages as (D204, migration 024), made the first time it is
 * needed and kept to the agent's current name. It is no account: no email, no password, no
 * identity to sign in with, and disabled, so no session can resolve to it either.
 */
export function ensureAgentUser(db: Db, input: { handle: string; displayName: string }): UserRow {
  const existing = db.get<UserRow>('SELECT * FROM users WHERE agent = ?', [input.handle]);
  if (existing) {
    if (existing.display_name !== input.displayName || existing.disabled_at === null) {
      db.exec('UPDATE users SET display_name = ?, disabled_at = COALESCE(disabled_at, ?) WHERE id = ?', [input.displayName, Date.now(), existing.id]);
    }
    return userById(db, existing.id)!;
  }
  const id = newId();
  const now = Date.now();
  db.exec('INSERT INTO users (id, display_name, created_at, disabled_at, agent) VALUES (?, ?, ?, ?, ?)', [id, input.displayName, now, now, input.handle]);
  return userById(db, id)!;
}

export function createLocalUser(db: Db, input: { displayName: string; email: string; passwordHash: string }): UserRow {
  const id = newId();
  db.exec('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.displayName,
    input.email,
    input.passwordHash,
    Date.now(),
  ]);
  return userById(db, id)!;
}

/** A first sign-in through the upstream with no account to join (D116): passwordless, known by the upstream's subject. */
export function createUpstreamUser(db: Db, input: { subject: string; displayName: string; email: string | null }): UserRow {
  const id = newId();
  db.exec('INSERT INTO users (id, display_name, email, upstream_subject, created_at) VALUES (?, ?, ?, ?, ?)', [id, input.displayName, input.email, input.subject, Date.now()]);
  return userById(db, id)!;
}

/** Join the upstream's identity to an account that has none (D228). */
export function setUpstreamSubject(db: Db, userId: string, subject: string): void {
  db.exec('UPDATE users SET upstream_subject = ? WHERE id = ? AND upstream_subject IS NULL', [subject, userId]);
}

/**
 * The name and the address follow the upstream (D116). The address only while no other account
 * has it: one that belongs to somebody else here is never taken over, and this account keeps the
 * one it had.
 */
export function refreshFromUpstream(db: Db, user: UserRow, input: { displayName: string; email: string | null }): UserRow {
  if (user.display_name === input.displayName && user.email === input.email) return user;
  const owner = input.email ? userByEmail(db, input.email) : undefined;
  const email = owner && owner.id !== user.id ? user.email : input.email;
  db.exec('UPDATE users SET display_name = ?, email = ? WHERE id = ?', [input.displayName, email, user.id]);
  return userById(db, user.id)!;
}

/**
 * Create an account for a first native sign-in with no match to link to (D178): passwordless, as
 * an upstream-made account is, but with no `upstream_subject` — that column is D116's own, and an
 * account made here may later also link a second provider's identity (`external_identities`),
 * which a single column could not represent.
 */
export function createIdentityUser(db: Db, input: { displayName: string; email: string | null }): UserRow {
  const id = newId();
  db.exec('INSERT INTO users (id, display_name, email, created_at) VALUES (?, ?, ?, ?)', [id, input.displayName, input.email, Date.now()]);
  return userById(db, id)!;
}

export function updateDisplayName(db: Db, userId: string, displayName: string): void {
  db.exec('UPDATE users SET display_name = ? WHERE id = ?', [displayName, userId]);
}

export function setPasswordHash(db: Db, userId: string, hash: string): void {
  db.exec('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
}

/**
 * Clear an account's password (D178): linking a verified Apple/Google email onto an account that
 * still has one of its own takes it away, since the provider — not whoever typed a password
 * against that email first — just proved who owns it (PR #25 review: left in place, the
 * pre-registrar kept durable password access after the real owner linked). The owner signs back
 * in with Apple/Google from here on, or gets a password again through an owner-issued reset link.
 */
export function clearPasswordHash(db: Db, userId: string): void {
  db.exec('UPDATE users SET password_hash = NULL WHERE id = ?', [userId]);
}
