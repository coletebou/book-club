import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export class SafeFetchError extends Error {
  override name = 'SafeFetchError';
}

/** Longest a URL's body may be, fetching for Cal's shelf (D163): a generous article or paper, not a video. */
export const MAX_FETCH_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 0) /* 192.0.0.0/24, IETF protocol assignments */ ||
    (a === 198 && (b === 18 || b === 19)) /* 198.18.0.0/15, benchmarking */ ||
    a === 100 /* 100.64.0.0/10, carrier-grade NAT (shared address space, also used inside private networks) */ ||
    a >= 224 /* multicast and reserved */
  );
}

/**
 * Whether an IP address is private, loopback, link-local, unique-local or otherwise not a public
 * Internet address (SSRF defence, D163): a URL a member pastes must not let the server read its
 * own metadata endpoints, another container's port, or anything else on this host's networks.
 * An IPv4 address written as IPv6 (`::ffff:10.0.0.1`, NAT64's `64:ff9b::a00:1`) is judged as the
 * IPv4 address it is.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateV4(mapped[1]);
    if (/^(?:::ffff:|64:ff9b::)[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) {
      // The same, in hex: ::ffff:a00:1 is 10.0.0.1.
      const [hi = '0', lo = '0'] = lower.replace(/^(?:::ffff:|64:ff9b::)/, '').split(':');
      const h = Number.parseInt(hi, 16);
      const l = Number.parseInt(lo, 16);
      return isPrivateV4(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`);
    }
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fec0:') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('ff') /* multicast */ ||
      lower.startsWith('::ffff:') /* any other mapped form: refuse rather than guess */
    );
  }
  return true; // not a literal IP address at all: treated as unsafe until resolved
}

/**
 * The `lookup` every connection this module makes goes through: the name is resolved once, here,
 * at connect time, every address it resolves to must be public, and the socket connects to the
 * very address that was checked. Checking a name and then letting the HTTP client resolve it again
 * would leave a gap a hostile DNS server can use (DNS rebinding: public on the check, private on
 * the connect).
 */
export const checkedLookup: LookupFunction = (hostname, options, callback) => {
  if (/^(localhost|.*\.local|.*\.localhost)$/i.test(hostname)) {
    callback(new SafeFetchError('That address cannot be fetched.'), '', 0);
    return;
  }
  dnsLookup(hostname, { all: true, verbatim: true }, (err, records: LookupAddress[]) => {
    if (err) return callback(err, '', 0);
    if (records.length === 0 || records.some((r) => isPrivateAddress(r.address))) {
      return callback(new SafeFetchError('That address cannot be fetched.'), '', 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, records);
    const first = records[0]!;
    callback(null, first.address, first.family);
  });
};

export interface SafeFetchResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly finalUrl: string;
}

function request(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // A literal IP never reaches `lookup`, so it is checked here instead.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && isPrivateAddress(literal)) {
      reject(new SafeFetchError('That address cannot be fetched.'));
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { lookup: checkedLookup, signal, headers: { 'user-agent': 'BookClubCal/1.0', accept: '*/*' } }, resolve);
    req.on('error', reject);
  });
}

/** A response's body, refused as soon as it passes the cap (not after it has all arrived). */
function readCapped(res: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FETCH_BYTES) {
        res.destroy();
        reject(new SafeFetchError('That page is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    res.on('error', reject);
  });
}

/**
 * Fetch a member-supplied URL for Cal's shelf: only http(s); every connection, the first and each
 * redirect's, made through {@link checkedLookup}, so it can only reach a public address; a byte
 * cap enforced while the body streams; and one timeout over the whole fetch, redirects included. A
 * malicious or compromised site cannot use this as a path to the server's own network. Treat every
 * returned byte as untrusted data (it is rendered as plain text later, never executed or served as
 * HTML, see shelf.ts).
 */
export async function safeFetch(rawUrl: string): Promise<SafeFetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('That is not a valid URL.');
  }
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    for (let redirects = 0; ; redirects++) {
      if (!/^https?:$/.test(url.protocol)) throw new SafeFetchError('Only http(s) URLs are allowed.');
      const res = await request(url, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) throw new SafeFetchError('Too many redirects.');
        url = new URL(location, url);
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        throw new SafeFetchError(`The page answered with ${status}.`);
      }
      if (Number(res.headers['content-length'] ?? '0') > MAX_FETCH_BYTES) {
        res.destroy();
        throw new SafeFetchError('That page is too large.');
      }
      const bytes = await readCapped(res);
      const contentType = res.headers['content-type'] ?? 'text/plain';
      return { bytes, contentType, finalUrl: url.toString() };
    }
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    if (signal.aborted) throw new SafeFetchError('That page took too long to answer.');
    throw new SafeFetchError('That page could not be fetched.');
  }
}
