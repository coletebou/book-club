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

/** Create or refresh a user from an upstream identity (name and email follow upstream). */
export function upsertUpstreamUser(db: Db, input: { subject: string; displayName: string; email: string | null }): UserRow {
  const existing = userByUpstream(db, input.subject);
  if (existing) {
    if (existing.display_name !== input.displayName || existing.email !== input.email) {
      // Keep the email only if no other account owns it.
      const owner = input.email ? userByEmail(db, input.email) : undefined;
      const email = owner && owner.id !== existing.id ? existing.email : input.email;
      db.exec('UPDATE users SET display_name = ?, email = ? WHERE id = ?', [input.displayName, email, existing.id]);
    }
    return userById(db, existing.id)!;
  }
  const id = newId();
  const emailTaken = input.email ? userByEmail(db, input.email) : undefined;
  db.exec('INSERT INTO users (id, display_name, email, upstream_subject, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.displayName,
    emailTaken ? null : input.email,
    input.subject,
    Date.now(),
  ]);
  return userById(db, id)!;
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
