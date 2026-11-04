import { type Db } from '../db/db';
import { newToken, sha256Hex } from '../lib/crypto';

/** How long a password reset link works. */
export const RESET_LINK_MS = 24 * 3600_000;

/**
 * A one-time password reset link for a user. Only the newest one works: making it retires every
 * earlier unused link for the same person (one sent to the wrong chat stops working).
 */
export function issueResetLink(db: Db, userId: string, createdBy: string, now = Date.now()): { token: string; expiresAt: number } {
  const token = newToken();
  const expiresAt = now + RESET_LINK_MS;
  db.tx(() => {
    revokeResetLinks(db, userId, now);
    db.exec('INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [sha256Hex(token), userId, createdBy, now, expiresAt]);
  });
  return { token, expiresAt };
}

/** Retire a user's unused links: after a password change or a reset, none of them may be used. */
export function revokeResetLinks(db: Db, userId: string, now = Date.now()): void {
  db.exec('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [now, userId]);
}

/**
 * Use a link, in one statement: of two requests with the same link only one wins. Returns whose
 * link it was and who made it, or nothing when it is unknown, used or expired.
 */
export function claimResetLink(db: Db, token: string, now = Date.now()): { user_id: string; created_by: string } | undefined {
  const hash = sha256Hex(token);
  const claimed = db.exec('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?', [now, hash, now]).changes === 1;
  return claimed ? db.get<{ user_id: string; created_by: string }>('SELECT user_id, created_by FROM password_resets WHERE token_hash = ?', [hash]) : undefined;
}
