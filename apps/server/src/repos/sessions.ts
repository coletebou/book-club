import { type Db } from '../db/db';
import { newToken, sha256Hex } from '../lib/crypto';
import { type UserRow } from './users';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string;
}

/** Live sessions kept per person (phones, browsers, the installed app); one more drops the least used. */
export const MAX_SESSIONS_PER_USER = 50;

/** Create a session; returns the raw token for the cookie (only its hash is stored). */
export function createSession(db: Db, userId: string, days: number, userAgent = ''): { token: string; expiresAt: number } {
  const token = newToken();
  const now = Date.now();
  const expiresAt = now + days * DAY;
  db.tx(() => {
    db.exec('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [
      sha256Hex(token),
      userId,
      now,
      now,
      expiresAt,
      userAgent.slice(0, 300),
    ]);
    db.exec(
      'DELETE FROM sessions WHERE user_id = ? AND id_hash NOT IN (SELECT id_hash FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC, created_at DESC LIMIT ?)',
      [userId, userId, MAX_SESSIONS_PER_USER],
    );
  });
  return { token, expiresAt };
}

export interface ResolvedSession {
  readonly user: UserRow;
  readonly session: SessionRow;
  /** Set when the expiry slid forward and the cookie should be re-issued. */
  readonly renewedUntil: number | null;
}

/**
 * Look a session token up. Expired sessions are deleted; sessions of disabled users are refused.
 * Activity slides the expiry forward, at most once an hour.
 */
export function resolveSession(db: Db, token: string, days: number): ResolvedSession | null {
  if (token.length < 20 || token.length > 200) return null;
  const hash = sha256Hex(token);
  const session = db.get<SessionRow>('SELECT * FROM sessions WHERE id_hash = ?', [hash]);
  if (!session) return null;
  const now = Date.now();
  if (session.expires_at <= now) {
    db.exec('DELETE FROM sessions WHERE id_hash = ?', [hash]);
    return null;
  }
  const user = db.get<UserRow>('SELECT * FROM users WHERE id = ?', [session.user_id]);
  if (!user || user.disabled_at !== null) return null;
  let renewedUntil: number | null = null;
  if (now - session.last_seen_at > HOUR) {
    renewedUntil = now + days * DAY;
    db.exec('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', [now, renewedUntil, hash]);
  }
  return { user, session, renewedUntil };
}

/**
 * End sessions: they sign nobody in again. (Until D116 they were also remembered in
 * `ended_sessions`, so that a request already on its way was not signed in again from the
 * upstream's cookie; nothing signs anyone in from a cookie of the upstream's now.)
 */
function endWhere(db: Db, where: string, params: string[]): number {
  return db.exec(`DELETE FROM sessions WHERE ${where}`, params).changes;
}

export function endSession(db: Db, token: string): void {
  endWhere(db, 'id_hash = ?', [sha256Hex(token)]);
}

export function endUserSessions(db: Db, userId: string, exceptToken?: string): number {
  return exceptToken ? endWhere(db, 'user_id = ? AND id_hash != ?', [userId, sha256Hex(exceptToken)]) : endWhere(db, 'user_id = ?', [userId]);
}

export function purgeExpiredSessions(db: Db): number {
  const now = Date.now();
  // What is left there from before D116 goes as its cookies would have expired.
  db.exec('DELETE FROM ended_sessions WHERE expires_at <= ?', [now]);
  return db.exec('DELETE FROM sessions WHERE expires_at <= ?', [now]).changes;
}
