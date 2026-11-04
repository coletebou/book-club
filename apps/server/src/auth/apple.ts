import { createHash, timingSafeEqual } from 'node:crypto';
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import { type Config } from '../config';

/*
 * Native "Sign in with Apple" (D178): `expo-apple-authentication` gets the identity token
 * in-process on the device — there is no server-started round trip to begin, unlike the upstream
 * grant (D116), which exists only because the upstream is a whole other site. All this server
 * has to check is what Apple signed: the token's signature (against Apple's own published keys,
 * fetched and cached), who it was minted for (`aud`, an allow-list of this app's own client ids),
 * that it has not expired, and that the nonce the app generated before asking for the credential
 * is the one Apple's signature covers.
 *
 * The nonce check follows Apple's own native convention (and every other client's, Firebase's
 * among them): before calling `AppleAuthentication.signInAsync`, the app hashes a random raw value
 * with SHA-256 (hex) and hands Apple that hash as the request's nonce; the identity token's own
 * `nonce` claim then carries that same hash back, unchanged. The raw value travels to this server
 * in the request body (`AppleSignInBodySchema`), and this file redoes the hash to compare.
 */

const ISSUER = 'https://appleid.apple.com';
const JWKS_URL = new URL(`${ISSUER}/auth/keys`);

let jwks: JWTVerifyGetKey | null = null;

function keySet(): JWTVerifyGetKey {
  // jose's own `cooldownDuration` is what keeps this from asking Apple on every sign-in; one
  // remote key set for the process's lifetime is enough for a server this size (D1).
  jwks ??= createRemoteJWKSet(JWKS_URL, { cooldownDuration: 5 * 60_000 });
  return jwks;
}

/** Tests only: stand in a local key set (a throwaway key, no network) instead of Apple's real one. */
export function setAppleKeySet(value: JWTVerifyGetKey | null): void {
  jwks = value;
}

export interface AppleIdentity {
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
}

export type AppleVerifyResult = { readonly identity: AppleIdentity } | { readonly refused: string };

/** sha256(raw), hex: what Apple's native API puts in the request nonce, and so in the token's `nonce` claim. */
function hashNonce(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** The token's `nonce` claim against the raw value the app sent, compared in constant time. */
function sameNonce(given: unknown, raw: string): boolean {
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(hashNonce(raw), 'hex'));
}

/**
 * Verify a native identity token against Apple's JWKS: its signature, issuer, audience (one of
 * `config.audiences`) and expiry (jose checks `exp` itself), then the nonce by hand (above).
 */
export async function verifyAppleIdentityToken(config: NonNullable<Config['apple']>, identityToken: string, rawNonce: string): Promise<AppleVerifyResult> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(identityToken, keySet(), { issuer: ISSUER, audience: [...config.audiences] }));
  } catch (err) {
    return { refused: err instanceof Error ? err.name : 'the identity token did not verify' };
  }
  if (!sameNonce(payload.nonce, rawNonce)) return { refused: 'the nonce does not match' };
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return { refused: 'no subject in the identity token' };
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  const email = emailVerified && typeof payload.email === 'string' ? payload.email : null;
  return { identity: { subject: payload.sub, email, emailVerified } };
}
