import { type Db } from '../db/db';
import { newToken, sha256Hex } from '../lib/crypto';

/** How long an app-code handoff works: the browser session to the WebView redemption is seconds, not minutes. */
export const APP_CODE_MS = 2 * 60_000;

/** How long a used or expired code's row is kept before it is cleared away. */
const KEEP_MS = 24 * 3600_000;

const hashOf = (code: string) => sha256Hex(`app-auth-code:${code}`);

/**
 * A one-time code handing a native Google sign-in from the browser session back into the app's
 * WebView (D178), bound to the PKCE challenge the app generated before it opened that session:
 * redeeming it (below) needs the matching verifier, which never left the app.
 */
export function issueAppCode(db: Db, userId: string, challenge: string, now = Date.now()): { code: string; expiresAt: number } {
  const code = newToken();
  const expiresAt = now + APP_CODE_MS;
  db.tx(() => {
    db.exec('DELETE FROM app_auth_codes WHERE expires_at < ?', [now - KEEP_MS]);
    db.exec('INSERT INTO app_auth_codes (code_hash, user_id, challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [hashOf(code), userId, challenge, now, expiresAt]);
  });
  return { code, expiresAt };
}

/**
 * Redeem a code, in one statement (of two requests with the same code only one wins), and only
 * with the verifier of the challenge it was bound to: an intercepted code (the `bookclub://auth`
 * redirect is a URL, not a secret channel) is useless without it.
 */
export function claimAppCode(db: Db, code: string, challengeOf: (verifier: string) => string, verifier: string, now = Date.now()): string | undefined {
  const hash = hashOf(code);
  const row = db.get<{ user_id: string; challenge: string }>('SELECT user_id, challenge FROM app_auth_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?', [hash, now]);
  if (!row || challengeOf(verifier) !== row.challenge) return undefined;
  const claimed = db.exec('UPDATE app_auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?', [now, hash, now]).changes === 1;
  return claimed ? row.user_id : undefined;
}
