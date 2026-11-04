import { type Db } from '../db/db';

export interface PushTokenRow {
  token: string;
  user_id: string;
  platform: string;
  created_at: number;
  last_seen_at: number;
}

/**
 * Register (or re-register) a device for push (D134). One row per device: a phone signed in as
 * someone else takes its token with it, rather than paging the person who left it behind.
 */
export function registerPushToken(db: Db, userId: string, token: string, platform = 'ios', now = Date.now()): void {
  db.exec(
    `INSERT INTO push_tokens (token, user_id, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, last_seen_at = excluded.last_seen_at`,
    [token, userId, platform, now, now],
  );
}

/**
 * Forget a device: APNs saying the token no longer works (no `userId`: whoever it was), or the
 * app itself asking to unregister (scoped to `userId`, so one user cannot drop another's device).
 */
export function removePushToken(db: Db, token: string, userId?: string): void {
  if (userId) db.exec('DELETE FROM push_tokens WHERE token = ? AND user_id = ?', [token, userId]);
  else db.exec('DELETE FROM push_tokens WHERE token = ?', [token]);
}

/** Every device a user has registered, newest first. */
export function pushTokensFor(db: Db, userId: string): PushTokenRow[] {
  return db.all<PushTokenRow>('SELECT * FROM push_tokens WHERE user_id = ? ORDER BY last_seen_at DESC', [userId]);
}
