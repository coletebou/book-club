/**
 * A stand-in for an agent of another service in the club's chat (D205), for the demo stack and its
 * E2E suite: what a real agent (Lux) wires up on its side, and nothing more. One file, no
 * dependencies: its signature check uses only `node:crypto`, an implementation of its own (not
 * @bookclub/chat-core's), so the suite proves the two ends agree on the protocol rather than that
 * one function agrees with itself.
 *
 *   POST /hook          a delivery from Book Club: its signature checked over the raw body and its
 *                       timestamp within five minutes, else 401. A good one is answered 204 at
 *                       once; then it says it is typing and answers in the thread through Book
 *                       Club's agent API ("Lux here. I read: …"). A message holding "[fail]" is
 *                       answered 500 instead, every time (so Book Club's retries and its notice to
 *                       the asker can be seen).
 *   GET  /deliveries    what it was sent, newest last (at most 50): for the suite to check
 *   GET  /healthz       ok
 *
 * Demo only: never run this anywhere but a developer's own machine or CI.
 *
 *   AGENT_WEBHOOK_SECRET=… AGENT_TOKEN=… node tools/fake-agent/server.mjs
 *
 * It answers at the address each delivery names (`reply.url`), as a real agent does; BOOKCLUB_API
 * puts another origin in front of that address's path, for a stack where the app's public address
 * is not the one this reaches it at (the demo stack's containers: http://app:8080).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const TOLERANCE_S = 300;
const KEPT = 50;

const sha256 = (text) => createHash('sha256').update(text).digest();

/** Whether a delivery was signed with `secret` over this very body, within five minutes of `now` (ms). */
export function genuine(secret, body, timestamp, signature, now = Date.now()) {
  if (!/^\d{1,12}$/.test(timestamp ?? '')) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
  const expected = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  return String(signature ?? '')
    .split(',')
    .map((part) => part.trim())
    .some((part) => timingSafeEqual(sha256(part), sha256(expected)));
}

export function startFakeAgent({ host = '127.0.0.1', port = 8083, secret, token, api, name = 'Lux', log = () => {} } = {}) {
  if (!secret || !token) throw new Error('AGENT_WEBHOOK_SECRET and AGENT_TOKEN are needed');
  const deliveries = [];
  const call = (address, body) =>
    fetch(api ? new URL(new URL(address).pathname, api) : address, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Answer as a real agent would: say it is typing, take a moment, answer in the thread. */
  async function answer(event) {
    // Where the delivery says to answer (its club's typing beside it).
    const typing = event.reply.url.replace(/\/messages$/, '/typing');
    await call(typing, { bookId: event.channel.kind === 'book' ? event.channel.bookId : null }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    const res = await call(event.reply.url, {
      text: `${name} here. I read: “${event.message.text}” (${event.thread.length} earlier in the conversation).`,
      parentId: event.reply.parentId,
      clientId: event.id,
    });
    if (!res.ok) log(`answer refused: ${res.status} ${await res.text()}`);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-agent');
    if (req.method === 'GET' && url.pathname === '/healthz') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    if (req.method === 'GET' && url.pathname === '/deliveries') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(deliveries));
    if (req.method !== 'POST' || url.pathname !== '/hook') return void res.writeHead(404).end();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const verified = genuine(secret, body, req.headers['x-agent-timestamp'], req.headers['x-agent-signature']);
      let event = null;
      try {
        event = verified ? JSON.parse(body) : null;
      } catch {
        event = null;
      }
      deliveries.push({ at: Date.now(), verified, delivery: req.headers['x-agent-delivery'] ?? null, event: req.headers['x-agent-event'] ?? null, body: event });
      if (deliveries.length > KEPT) deliveries.shift();
      if (!verified || !event) return void res.writeHead(401).end();
      if (String(event.message?.text ?? '').includes('[fail]')) return void res.writeHead(500).end();
      res.writeHead(204).end();
      void answer(event).catch((err) => log(`answer failed: ${err}`));
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, deliveries, port: server.address().port })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { port } = await startFakeAgent({
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 8083),
    secret: process.env.AGENT_WEBHOOK_SECRET,
    token: process.env.AGENT_TOKEN,
    api: process.env.BOOKCLUB_API || undefined,
    name: process.env.AGENT_NAME ?? 'Lux',
    log: (line) => console.log(line),
  });
  console.log(`fake agent on ${port}`);
}
