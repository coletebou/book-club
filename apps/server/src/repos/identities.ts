import { type Db } from '../db/db';
import { type UserRow } from './users';

/** A provider this server can verify a native identity from (D178). */
export type Provider = 'apple' | 'google';

/** The user already linked to this (provider, subject), if any. */
export function identityByProviderSubject(db: Db, provider: Provider, subject: string): UserRow | undefined {
  return db.get<UserRow>(
    `SELECT users.* FROM users
       JOIN external_identities ON external_identities.user_id = users.id
      WHERE external_identities.provider = ? AND external_identities.subject = ?`,
    [provider, subject],
  );
}

/** Link a provider identity to an account: first sign-in with it, ever. */
export function linkIdentity(db: Db, input: { provider: Provider; subject: string; userId: string; email: string | null }): void {
  db.exec('INSERT INTO external_identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)', [
    input.provider,
    input.subject,
    input.userId,
    input.email,
    Date.now(),
  ]);
}

/** Whether this account has any external identity linked (Apple, Google, or both): no local password UI applies. */
export function hasExternalIdentity(db: Db, userId: string): boolean {
  return db.get<{ one: number }>('SELECT 1 AS one FROM external_identities WHERE user_id = ? LIMIT 1', [userId]) !== undefined;
}

/** The provider an account is best described by for display (`User.source`, D178): the first one linked, if any. */
export function externalProvider(db: Db, userId: string): Provider | undefined {
  return db.get<{ provider: Provider }>('SELECT provider FROM external_identities WHERE user_id = ? ORDER BY created_at LIMIT 1', [userId])?.provider;
}
