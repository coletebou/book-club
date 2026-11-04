import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Random URL-safe id (96 bits → 16 characters). */
export function newId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

/** Random URL-safe secret token (256 bits by default). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/*
 * Password hashing: scrypt with parameters stored alongside the hash so they can be raised later.
 * Format: scrypt$N$r$p$salt$hash (base64url).
 */
let DEFAULT_PARAMS = { N: 2 ** 17, r: 8, p: 1, keylen: 64 };

/** Lower the scrypt cost for new hashes (tests only; existing hashes keep their stored cost). */
export function setScryptCost(log2N: number): void {
  DEFAULT_PARAMS = { ...DEFAULT_PARAMS, N: 2 ** log2N };
}

function scryptAsync(password: string, salt: Buffer, params: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string, params: typeof DEFAULT_PARAMS = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltText, hashText] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashText, 'base64url');
  const params = { N: Number(n), r: Number(r), p: Number(p), keylen: expected.length };
  if (!Number.isSafeInteger(params.N) || params.N < 2 || params.keylen < 16) return false;
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, Buffer.from(saltText, 'base64url'), params);
  } catch {
    // Parameters scrypt refuses (N not a power of two, out of range): not a hash we wrote.
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash with the default cost that never matches, used to keep sign-in timing uniform. */
export const DUMMY_PASSWORD_HASH =
  'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
