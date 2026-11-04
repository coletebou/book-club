import { generateKeyPairSync } from 'node:crypto';
import http2, { type IncomingHttpHeaders, type Http2Server } from 'node:http2';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type ApnsConfig, createApnsClient } from '../src/push/apns';

/*
 * APNs (D134): a provider JWT signed with the team's `.p8` key, one HTTP/2 POST per device. No
 * real Apple server is reachable from a test box, so these run against a fake one: plaintext
 * HTTP/2 (h2c), replying however the test asks, recording what the client sent it.
 */

interface Seen {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A fake APNs: answers `status` to every request, remembering each one's headers and body. */
function fakeApns(status: number, body = ''): { server: Http2Server; authority: Promise<string>; requests: Seen[] } {
  const requests: Seen[] = [];
  const server = http2.createServer((req, res) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: data });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  const authority = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  return { server, authority, requests };
}

function testKey(): string {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    .privateKey;
}

const PUSH = { title: 'Alice', body: 'Ben replied: “Poor Bill”', path: '/books/b1#note-n1', collapseId: 'notif-1' };

describe('APNs client (D134)', () => {
  let fake: ReturnType<typeof fakeApns>;
  let config: ApnsConfig;

  async function withFake(status: number, body = ''): Promise<void> {
    fake = fakeApns(status, body);
    config = { keyId: 'KEY123', teamId: 'TEAM456', bundleId: 'com.example.bookclub', privateKey: testKey(), production: false, authority: await fake.authority };
  }

  afterEach(async () => {
    await new Promise((resolve) => fake.server.close(resolve));
  });

  it('sends a provider JWT (ES256, team as issuer) and the right topic, push type and collapse id', async () => {
    await withFake(200);
    const client = createApnsClient(config);
    const outcome = await client.send('abc123deviceToken0000000000000000000000000000000000000000000000', PUSH);
    client.close();
    expect(outcome).toBe('sent');
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.headers['apns-topic']).toBe('com.example.bookclub');
    expect(req.headers['apns-push-type']).toBe('alert');
    expect(req.headers['apns-collapse-id']).toBe('notif-1');
    const auth = String(req.headers.authorization);
    expect(auth).toMatch(/^bearer /);
    const [, jwt] = auth.split(' ');
    const [headerB64, claimsB64, sig] = jwt!.split('.');
    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(claimsB64!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEY123' });
    expect(claims).toMatchObject({ iss: 'TEAM456' });
    expect(typeof claims.iat).toBe('number');
    // ES256's raw (r, s) signature is 64 bytes, not DER: a client that forgot "ieee-p1363" would be longer.
    expect(Buffer.from(sig!, 'base64url')).toHaveLength(64);
    const payload = JSON.parse(req.body) as { aps: { alert: { title: string; body: string } }; path: string };
    expect(payload.aps.alert).toEqual({ title: 'Alice', body: 'Ben replied: “Poor Bill”' });
    expect(payload.path).toBe('/books/b1#note-n1');
  });

  it('reuses one provider token across sends instead of signing a fresh one each time', async () => {
    await withFake(200);
    const client = createApnsClient(config);
    await client.send('deviceOne00000000000000000000000000000000000000000000000000000', PUSH);
    await client.send('deviceTwo00000000000000000000000000000000000000000000000000000', PUSH);
    client.close();
    const tokens = fake.requests.map((r) => String(r.headers.authorization));
    expect(tokens[0]).toBe(tokens[1]);
  });

  it('reports a 410 (Unregistered) as "unregistered", so the caller can forget the token', async () => {
    await withFake(410);
    const client = createApnsClient(config);
    const outcome = await client.send('deadtoken000000000000000000000000000000000000000000000000000', PUSH);
    client.close();
    expect(outcome).toBe('unregistered');
  });

  it('reports a 400 BadDeviceToken as "unregistered" too (a malformed or wrong-environment token)', async () => {
    await withFake(400, JSON.stringify({ reason: 'BadDeviceToken' }));
    const client = createApnsClient(config);
    const outcome = await client.send('malformed', PUSH);
    client.close();
    expect(outcome).toBe('unregistered');
  });

  it('reports any other failure (a 500, or a different 400 reason) as "failed", keeping the token', async () => {
    await withFake(500);
    const client = createApnsClient(config);
    expect(await client.send('sometoken00000000000000000000000000000000000000000000000000000', PUSH)).toBe('failed');
    await new Promise((resolve) => fake.server.close(resolve));
    await withFake(400, JSON.stringify({ reason: 'PayloadTooLarge' }));
    const client2 = createApnsClient(config);
    expect(await client2.send('sometoken00000000000000000000000000000000000000000000000000000', PUSH)).toBe('failed');
    client2.close();
  });
});
