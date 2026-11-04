import { randomInt } from 'node:crypto';
import { SIGN_IN_CODE_DIGITS } from '@bookclub/shared';
import { type Db } from '../db/db';
import { sha256Hex } from '../lib/crypto';

/** How long a sign-in code works. */
export const SIGN_IN_CODE_MS = 10 * 60_000;

/** How long a used or expired code's row is kept before it is cleared away. */
const KEEP_MS = 24 * 3600_000;

const hashOf = (code: string) => sha256Hex(`sign-in-code:${code}`);

/**
 * A new one-time sign-in code for a user (D87): eight digits, working once, for ten minutes. Making
 * one retires the person's earlier unused codes, and never gives out a code someone else holds.
 */
export function issueSignInCode(db: Db, userId: string, now = Date.now()): { code: string; expiresAt: number } {
  const expiresAt = now + SIGN_IN_CODE_MS;
  return db.tx(() => {
    db.exec('DELETE FROM sign_in_codes WHERE expires_at < ?', [now - KEEP_MS]);
    revokeSignInCodes(db, userId, now);
    for (;;) {
      const code = String(randomInt(0, 10 ** SIGN_IN_CODE_DIGITS)).padStart(SIGN_IN_CODE_DIGITS, '0');
      const hash = hashOf(code);
      const held = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sign_in_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?', [hash, now])!.n > 0;
      if (held) continue;
      db.exec('INSERT OR REPLACE INTO sign_in_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [hash, userId, now, expiresAt]);
      return { code, expiresAt };
    }
  });
}

/** Retire a user's unused codes: after a new code, a new password or signing out everywhere. */
export function revokeSignInCodes(db: Db, userId: string, now = Date.now()): void {
  db.exec('UPDATE sign_in_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [now, userId]);
}

/**
 * Use a code, in one statement: of two requests with the same code only one wins. Returns whose
 * code it was, or nothing when it is unknown, used or expired.
 */
export function claimSignInCode(db: Db, code: string, now = Date.now()): string | undefined {
  const hash = hashOf(code);
  const claimed = db.exec('UPDATE sign_in_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?', [now, hash, now]).changes === 1;
  return claimed ? db.get<{ user_id: string }>('SELECT user_id FROM sign_in_codes WHERE code_hash = ?', [hash])?.user_id : undefined;
}
