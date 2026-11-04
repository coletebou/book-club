import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage } from 'node:http';

/** The header the trusted proxy sends its key in (TRUST_PROXY_KEY). */
export const PROXY_KEY_HEADER = 'x-bookclub-proxy-key';

/** What a proxy may say about the client: Fastify reads the first three, the tus server the host and port too. */
const FORWARDED = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'forwarded'];

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Drops a request's forwarded headers unless it carries the proxy's key, before Fastify, its
 * logger or the tus server read them; the key itself goes no further. On a host with other users,
 * Docker relays every local connection to the app's port (or its container's address) from the
 * same gateway address the proxy comes from, so the address alone cannot tell the proxy from
 * another user naming whichever client they like (docs/DEPLOY.md).
 */
export function proxyKeyGuard(key: string): (request: IncomingMessage) => void {
  const expected = digest(key);
  return (request) => {
    const given = request.headers[PROXY_KEY_HEADER];
    const vouched = typeof given === 'string' && timingSafeEqual(digest(given), expected);
    delete request.headers[PROXY_KEY_HEADER];
    if (!vouched) for (const name of FORWARDED) delete request.headers[name];
  };
}
