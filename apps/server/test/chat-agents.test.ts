import { type IncomingHttpHeaders, type Server, createServer, request as httpRequest } from 'node:http';
import { inspect } from 'node:util';
import { type AgentEventV1, AGENT_HEADERS, verifyAgentWebhook } from '@bookclub/chat-core';
import { type BookDetail, ChatAgentListSchema, type ChatMessageView, ChatThreadSchema, type ClubDetail } from '@bookclub/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { genuine, startFakeAgent } from '../../../tools/fake-agent/server.mjs';
import { loadConfig } from '../src/config';
import { cleanAgentText } from '../src/routes/agents';
import { AGENT_NOTICES } from '../src/services/agent-webhooks';
import { ALICE_EPUB, type Client, type Res, type Socket, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, openSocket, setupOwner, uploadBook, waitUntil } from './helpers';

const SECRET = 'test-webhook-secret-0123456789abcdef-lux';
const TOKEN = 'test-agent-token-0123456789abcdef0123-lux';
const SCOUT_TOKEN = 'test-agent-token-0123456789abcdef-scout';

interface Received {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A webhook receiver on a port of its own: keeps every request, answers as `mode` says. */
async function receiver() {
  const received: Received[] = [];
  const mode: { status: number; location?: string } = { status: 204 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (mode.location) res.setHeader('location', mode.location);
      res.writeHead(mode.status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, received, mode, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const agentsEnv = (hook: string, extra: Record<string, unknown>[] = []) => ({
  CHAT_AGENTS: JSON.stringify([
    // Limits high enough for this suite's many messages; the limits' own test fills them.
    { handle: 'lux', name: 'Lux', about: 'Takes requests for features and changes to Book Club.', avatar: '🦊', webhookUrl: `${hook}/hook`, webhookSecret: SECRET, token: TOKEN, clubs: '*', perMemberPerMinute: 50, perMinute: 500 },
    { handle: 'scout', name: 'Scout', webhookUrl: `${hook}/scout`, webhookSecret: `${SECRET}-scout`, token: SCOUT_TOKEN, clubs: ['not-a-club-here'] },
    ...extra,
  ]),
});

/** One file as multipart/form-data (as chat-images.test.ts sends a picture). */
function upload(c: Client, clubId: string, bytes: Uint8Array): Promise<Res> {
  const boundary = `----agent-test-${Math.random().toString(36).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`;
  return c.request({
    method: 'POST',
    url: `/api/clubs/${clubId}/chat/attachments`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: new Uint8Array(Buffer.concat([Buffer.from(head), Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)])),
  });
}

/** Put a member's reading of a book's EPUB at `fraction` of it (read from its start). */
async function readTo(c: Client, book: BookDetail, fraction: number) {
  const epub = book.editions.find((e) => e.kind === 'epub')!;
  const geometry = epub.geometry!;
  if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
  const total = geometry.sectionLengths.reduce((a, b) => a + b, 0);
  let left = Math.floor(total * fraction);
  let section = 0;
  while (section < geometry.sectionLengths.length - 1 && left > geometry.sectionLengths[section]!) left -= geometry.sectionLengths[section++]!;
  const to = { kind: 'epub' as const, section, offset: Math.min(left, geometry.sectionLengths[section]!) };
  expect((await c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: to, readSpans: [{ from: { kind: 'epub', section: 0, offset: 0 }, to }], at: Date.now() })).statusCode).toBe(200);
}

/**
 * Wait until the clock has moved on: a chat message's place in its channel is its millisecond, then
 * its (random) id, so a message sent in the same millisecond as another may come before it or after.
 */
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A POST over node:http, which (unlike fetch) sends whatever Host header it is given, as any script can. */
function rawPost(baseUrl: string, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: unknown }> {
  const url = new URL(path, baseUrl);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as unknown) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Agents of other services in the club's chat (D205), over the real server and a webhook receiver
 * of its own: a message naming one is delivered signed, with the conversation as its writer may
 * read it; the agent answers through its own API with its own token, in the clubs it is in, fenced
 * as the conversation is for the person it answers; what goes wrong is told to that person alone.
 */
describe('agents of other services in chat (D205)', () => {
  let hook: Awaited<ReturnType<typeof receiver>>;
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let alice: BookDetail;
  let ids: Record<string, string>;
  let luxId: string;
  let anaSocket: Socket;

  const post = async (c: Client, body: Record<string, unknown>, status = 201) => c.json<ChatMessageView>(c.post(`/api/clubs/${club.id}/chat`, body), status);
  const thread = async (c: Client, id: string) => ChatThreadSchema.parse(await c.json(c.get(`/api/chat/${id}/thread`), 200));
  /** A request to the agent API as an agent (no session, no Origin: a server calling another). */
  const asAgent = (method: string, url: string, payload?: unknown, token = TOKEN) =>
    t.client().request({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload === undefined ? {} : { payload }) });
  const deliveries = (path = '/hook') => hook.received.filter((r) => r.path === path);
  const eventOf = (r: Received) => JSON.parse(r.body) as AgentEventV1;

  beforeAll(async () => {
    hook = await receiver();
    t = await makeTestApp(agentsEnv(hook.url));
    t.ctx.agents.retryDelaysMs = [5, 5];
    ({ owner, club } = await setupOwner(t, 'Cole', 'Thursday Readers'));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben Carter');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    alice = await bookDetail(owner, bookId);
    const me = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/session'), 200)).user.id;
    ids = { cole: await me(owner), ana: await me(ana), ben: await me(ben) };
    luxId = t.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE agent = 'lux'")!.id;
    anaSocket = await openSocket(t, ana);
    anaSocket.send({ type: 'subscribe', clubId: club.id });
    await anaSocket.next('presence');
  });

  afterAll(async () => {
    await anaSocket.close();
    await closeApp(t);
    await hook.close();
  });

  it('is offered where it is in, saying what it does and that a message naming it leaves Book Club, never how it is reached', async () => {
    const res = await ana.get(`/api/clubs/${club.id}/chat/agents`);
    const { agents } = ChatAgentListSchema.parse(res.json());
    expect(agents).toEqual([{ handle: 'lux', displayName: 'Lux', kind: 'webhook', avatar: { kind: 'text', text: '🦊' }, about: expect.stringContaining('outside Book Club') as string }]);
    expect(agents[0]!.about).toMatch(/^Takes requests for features and changes to Book Club\. A message that names Lux is sent to it/);
    // Scout is in no club here; nothing says where either is reached or how it proves itself.
    for (const secret of [SECRET, TOKEN, SCOUT_TOKEN, hook.url]) expect(res.body).not.toContain(secret);
  });

  it('delivers a message naming it, signed, with the conversation as its writer may read it, and where to answer', async () => {
    const root = await post(owner, { text: 'Thoughts on the opening chapters?', bookId: alice.id });
    await post(ben, { text: 'The trial at the very end is wild', parentId: root.id, spoilerUpToT: 0.95 });
    const ask = await post(ana, { text: '@lux could the chat show who reacted?', parentId: root.id });
    expect(!ask.hidden && ask.mentions).toEqual([{ start: 0, end: 4, userId: null, agent: 'lux' }]);
    await t.settle();
    const [delivery] = deliveries().slice(-1);
    expect(delivery).toBeDefined();
    const h = delivery!.headers;
    expect(h['content-type']).toBe('application/json');
    expect(h[AGENT_HEADERS.event]).toBe('chat.mention');
    // Both ends agree: chat-core's check, and the stand-in's own node:crypto one.
    expect(await verifyAgentWebhook({ secret: SECRET, body: delivery!.body, timestamp: h[AGENT_HEADERS.timestamp] as string, signature: h[AGENT_HEADERS.signature] as string })).toBe(true);
    expect(genuine(SECRET, delivery!.body, h[AGENT_HEADERS.timestamp] as string, h[AGENT_HEADERS.signature] as string)).toBe(true);
    const event = eventOf(delivery!);
    expect(event).toMatchObject({
      version: 1,
      type: 'chat.mention',
      id: h[AGENT_HEADERS.delivery],
      agent: { handle: 'lux' },
      club: { id: club.id, name: 'Thursday Readers' },
      channel: { kind: 'book', bookId: alice.id, title: 'Alice' },
      message: { id: ask.id, author: { id: ids.ana, name: 'Ana', agent: null }, text: '@lux could the chat show who reacted?', parentId: root.id, threadId: root.id, pictures: 0, images: [] },
      reply: { path: `/api/agents/v1/clubs/${club.id}/messages`, parentId: ask.id },
    });
    // A path on Book Club's own API, never an address: the agent knows where Book Club is.
    expect(delivery!.body).not.toMatch(/https?:\/\//u);
    // Ben's reply is fenced past where Ana has read: not hers to read, so not the agent's either.
    expect(event.thread.map((m) => m.text)).toEqual(['Thoughts on the opening chapters?']);
    expect(delivery!.body).not.toContain('trial');
  });

  it('answers through its own API: in the thread, shown as itself, its words cleaned', async () => {
    const ask = await post(ana, { text: '@lux hello' });
    const res = await asAgent('POST', `/api/agents/v1/clubs/${club.id}/messages`, { text: '\u202eOn it\u0007 \r\nnow.', parentId: ask.id });
    expect(res.statusCode).toBe(201);
    const { message } = res.json<{ message: { id: string; text: string; threadId: string } }>();
    expect(message).toMatchObject({ text: 'On it \nnow.', threadId: ask.id });
    const seen = (await thread(ben, ask.id)).replies.find((m) => m.id === message.id)!;
    expect(seen).toMatchObject({ hidden: false, author: { userId: luxId, displayName: 'Lux', agent: 'lux' }, parentId: ask.id, spoilerLabel: null });
    // The same clientId twice posts once.
    const again = async () => asAgent('POST', `/api/agents/v1/clubs/${club.id}/messages`, { text: 'Once.', parentId: ask.id, clientId: 'delivery-123' });
    const first = (await again()).json<{ message: { id: string } }>().message.id;
    const second = await again();
    expect(second.statusCode).toBe(200);
    expect(second.json<{ message: { id: string } }>().message.id).toBe(first);
    // What it writes is cleaned, and must be something, within a message's length.
    expect((await asAgent('POST', `/api/agents/v1/clubs/${club.id}/messages`, { text: ' \u202e ' })).statusCode).toBe(400);
    expect((await asAgent('POST', `/api/agents/v1/clubs/${club.id}/messages`, { text: 'x'.repeat(4001) })).statusCode).toBe(400);
    expect((await asAgent('POST', `/api/agents/v1/clubs/${club.id}/messages`, { text: 'hi', unknown: 1 })).statusCode).toBe(400);
  });

  it('fences its answer as the conversation is for the person it answers: open to them, hidden from a friend behind', async () => {
    await readTo(ana, alice, 0.5);
    const place = (await bookDetail(ana, alice.id)).progress.find((p) => p.userId === ids.ana)!.t;
    const ask = await post(ana, { text: '@lux about the tea party scene…', bookId: alice.id, spoilerUpToT: place });
    await t.settle();
    const res = await asAgent('POST', `/api/agents/v1/clubs/${club.id}/messages`, { text: 'Noted, about the tea party.', parentId: ask.id });
    const { message } = res.json<{ message: { id: string } }>();
    const row = t.ctx.db.get<{ spoiler_t: number | null; spoiler_user_id: string | null }>('SELECT spoiler_t, spoiler_user_id FROM chat_messages WHERE id = ?', [message.id])!;
    expect(row).toEqual({ spoiler_t: place, spoiler_user_id: ids.ana });
    expect((await thread(ana, ask.id)).replies.find((m) => m.id === message.id)!.hidden).toBe(false);
    expect((await thread(ben, ask.id)).replies.find((m) => m.id === message.id)!.hidden).toBe(true);
    // Its own message in General, answering no one, is fenced at nothing.
    const own = await asAgent('POST', `/api/agents/v1/clubs/${club.id}/messages`, { text: 'Shipped: reactions show who.' });
    expect(t.ctx.db.get<{ spoiler_t: number | null }>('SELECT spoiler_t FROM chat_messages WHERE id = ?', [own.json<{ message: { id: string } }>().message.id])!.spoiler_t).toBeNull();
  });

  it('refuses a request without its token, with a session instead, or in a club it is not in; edits only its own', async () => {
    const url = `/api/agents/v1/clubs/${club.id}/messages`;
    const none = await asAgent('POST', url, { text: 'hi' }, '');
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect((await asAgent('POST', url, { text: 'hi' }, `${TOKEN}x`)).statusCode).toBe(401);
    // A member's own session is no agent's token.
    expect((await ana.post(url, { text: 'hi' })).statusCode).toBe(401);
    // Scout's token is good, but Scout is not in this club.
    expect((await asAgent('POST', url, { text: 'hi' }, SCOUT_TOKEN)).statusCode).toBe(404);
    expect((await asAgent('POST', `/api/agents/v1/clubs/${club.id}/typing`, {}, SCOUT_TOKEN)).statusCode).toBe(404);
    const mine = await post(ana, { text: 'my own words' });
    expect((await asAgent('PATCH', `/api/agents/v1/messages/${mine.id}`, { text: 'changed' })).statusCode).toBe(404);
    const its = (await asAgent('POST', url, { text: 'first try' })).json<{ message: { id: string } }>().message;
    const edited = await asAgent('PATCH', `/api/agents/v1/messages/${its.id}`, { text: 'second try, @Ana' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<{ message: { text: string; editedAt: string | null } }>().message).toMatchObject({ text: 'second try, @Ana' });
    // Naming Ana in an edit tells her, as any message does.
    const bell = await ana.json<{ items: { kind: string; chatMessageId: string | null }[] }>(ana.get('/api/notifications'), 200);
    expect(bell.items.some((n) => n.kind === 'mention' && n.chatMessageId === its.id)).toBe(true);
    const me = await asAgent('GET', '/api/agents/v1/me');
    expect(me.json()).toEqual({ handle: 'lux', name: 'Lux', clubs: '*' });
  });

  it('says it is typing, to everyone in the club, in the one channel it is at work in', async () => {
    expect((await asAgent('POST', `/api/agents/v1/clubs/${club.id}/typing`, { bookId: alice.id })).statusCode).toBe(204);
    const typing = await anaSocket.next('chat:typing', (m) => m.userId === luxId);
    expect(typing).toMatchObject({ clubId: club.id, bookId: alice.id, displayName: 'Lux', channel: alice.id });
    // In General it is General's alone, never every channel's (a member's typing is club-wide).
    expect((await asAgent('POST', `/api/agents/v1/clubs/${club.id}/typing`, {})).statusCode).toBe(204);
    expect(await anaSocket.next('chat:typing', (m) => m.userId === luxId && m.bookId === null)).toMatchObject({ channel: 'general' });
  });

  it('passes a message’s pictures as addresses signed for it and fetched with its token, nothing else', async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3a6' } }).png().toBuffer();
    const picture = (await upload(ana, club.id, png)).json<{ id: string }>();
    const ask = await post(ana, { text: '@lux this one', attachmentIds: [picture.id] });
    await t.settle();
    const event = eventOf(deliveries().at(-1)!);
    expect(event.message.id).toBe(ask.id);
    expect(event.message.images).toHaveLength(1);
    const { path } = event.message.images[0]!;
    expect(path.startsWith(`/api/agents/v1/media/${picture.id}?expires=`)).toBe(true);
    const ok = await asAgent('GET', path);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect((await sharp(ok.bytes).metadata()).width).toBe(64);
    expect((await asAgent('GET', path, undefined, '')).statusCode).toBe(401);
    // Signed for Lux: no use to another agent, nor once changed, nor once past its hour.
    expect((await asAgent('GET', path, undefined, SCOUT_TOKEN)).statusCode).toBe(404);
    // One character of the signature changed, always to another one.
    const at = path.indexOf('signature=') + 'signature='.length;
    expect((await asAgent('GET', `${path.slice(0, at)}${path[at] === 'A' ? 'B' : 'A'}${path.slice(at + 1)}`)).statusCode).toBe(404);
    const past = Date.now() - 1000;
    expect((await asAgent('GET', `/api/agents/v1/media/${picture.id}?expires=${past}&signature=${t.ctx.agents.mediaSignature('lux', picture.id, past)}`)).statusCode).toBe(404);
  });

  it('tries a failed delivery again, then tells the asker alone; never follows a redirect; a refusal is final', async () => {
    hook.mode.status = 500;
    try {
      const before = deliveries().length;
      const ask = await post(ana, { text: '@lux are you there?' });
      await t.settle();
      const tries = deliveries().slice(before);
      expect(tries).toHaveLength(3);
      expect(new Set(tries.map((r) => r.headers[AGENT_HEADERS.delivery])).size).toBe(1);
      expect((await anaSocket.next('chat:notice', (m) => m.messageId === ask.id)).text).toBe(AGENT_NOTICES.failed('Lux'));

      hook.mode.status = 302;
      hook.mode.location = `${hook.url}/elsewhere`;
      const moved = await post(ana, { text: '@lux over there?' });
      await t.settle();
      expect(hook.received.some((r) => r.path === '/elsewhere')).toBe(false);
      await anaSocket.next('chat:notice', (m) => m.messageId === moved.id);

      hook.mode.status = 400;
      hook.mode.location = undefined;
      const count = deliveries().length;
      const refused = await post(ana, { text: '@lux bad request?' });
      await t.settle();
      expect(deliveries().length - count).toBe(1);
      await anaSocket.next('chat:notice', (m) => m.messageId === refused.id);
    } finally {
      hook.mode.status = 204;
      hook.mode.location = undefined;
    }
  });

  it('stops trying a delivery once its message is deleted, and then says nothing', async () => {
    hook.mode.status = 500;
    t.ctx.agents.retryDelaysMs = [400, 400];
    try {
      const before = deliveries().length;
      const ask = await post(ana, { text: '@lux just the once?' });
      await waitUntil(() => deliveries().length > before, 5000, 'the first attempt');
      expect((await ana.delete(`/api/chat/${ask.id}`)).statusCode).toBe(204);
      await t.settle();
      expect(deliveries().length - before).toBe(1);
      expect(await anaSocket.quiet('chat:notice', (m) => m.messageId === ask.id)).toBe(true);
    } finally {
      hook.mode.status = 204;
      t.ctx.agents.retryDelaysMs = [5, 5];
    }
  });

  it('limits what one person, and everyone together, may send it a minute', async () => {
    const settings = t.ctx.agents.webhookOf(t.ctx.agents.byHandle('lux')!)!;
    const member = t.ctx.agents.limiter('lux:member', settings.perMemberPerMinute);
    for (let i = 0; i < settings.perMemberPerMinute; i++) member.record(ids.ben!);
    try {
      const before = deliveries().length;
      const benSocket = await openSocket(t, ben);
      const ask = await post(ben, { text: '@lux one more' });
      expect((await benSocket.next('chat:notice', (m) => m.messageId === ask.id)).text).toBe(AGENT_NOTICES.rate('Lux'));
      await benSocket.close();
      await t.settle();
      expect(deliveries().length).toBe(before);
    } finally {
      member.reset(ids.ben!);
    }
    const all = t.ctx.agents.limiter('lux:all', settings.perMinute);
    for (let i = 0; i < settings.perMinute; i++) all.record('all');
    try {
      const ask = await post(ana, { text: '@lux and one more' });
      expect((await anaSocket.next('chat:notice', (m) => m.messageId === ask.id)).text).toBe(AGENT_NOTICES.busy('Lux'));
    } finally {
      all.reset('all');
    }
  });

  it('is asked by a message sent naming it, or answering it unless that names someone else; never by an edit, nor by an agent', async () => {
    const before = deliveries().length;
    const own = (await asAgent('POST', `/api/agents/v1/clubs/${club.id}/messages`, { text: 'Ask me, @lux, anything.' })).json<{ message: { id: string } }>().message;
    await t.settle();
    expect(deliveries().length).toBe(before);
    const plain = await post(ana, { text: 'no one asked' });
    await ana.patch(`/api/chat/${plain.id}`, { text: '@lux now?' });
    await t.settle();
    expect(deliveries().length).toBe(before);
    await post(ana, { text: 'Can you also do threads?', parentId: own.id });
    await t.settle();
    expect(deliveries().length).toBe(before + 1);
    await post(ana, { text: '@Ben Carter what do you think?', parentId: own.id });
    await t.settle();
    expect(deliveries().length).toBe(before + 1);
  });
});

/**
 * What an agent writes is fenced by what it was given (D205, migration 025), never by the
 * conversation as it is when its words arrive: an answer by the delivery it answers, at its asker's
 * place; a message of its own in a book's channel by the most that channel ever delivered to it;
 * nothing it was never given may be answered. On an app of its own, so its fences start from none.
 */
describe('what an agent writes is fenced by what it was given (D205)', () => {
  let hook: Awaited<ReturnType<typeof receiver>>;
  let t: TestApp;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let alice: BookDetail;
  let anaId: string;
  let place: number;
  let early: { id: string };
  let answer: { id: string };

  const url = () => `/api/agents/v1/clubs/${club.id}/messages`;
  const post = async (c: Client, body: Record<string, unknown>, status = 201) => c.json<ChatMessageView>(c.post(`/api/clubs/${club.id}/chat`, body), status);
  const asAgent = (method: string, path: string, payload?: unknown) => t.client().request({ method, url: path, headers: { authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });
  const written = async (payload: Record<string, unknown>) => {
    const res = await asAgent('POST', url(), payload);
    expect(res.statusCode).toBe(201);
    return res.json<{ message: { id: string } }>().message;
  };
  const fenceOf = (id: string) => t.ctx.db.get<{ spoiler_t: number | null; spoiler_user_id: string | null }>('SELECT spoiler_t, spoiler_user_id FROM chat_messages WHERE id = ?', [id])!;
  /** Whether `c` is kept from a message: a reply as its thread shows it, a thread's first message as it starts one. */
  const hiddenFrom = async (c: Client, id: string, rootId = id) => {
    const view = ChatThreadSchema.parse(await c.json(c.get(`/api/chat/${rootId}/thread`), 200));
    return (id === rootId ? view.root : view.replies.find((m) => m.id === id))!.hidden;
  };

  beforeAll(async () => {
    hook = await receiver();
    t = await makeTestApp(agentsEnv(hook.url));
    let owner: Client;
    ({ owner, club } = await setupOwner(t, 'Cole', 'Thursday Readers'));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben Carter');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    alice = await bookDetail(owner, bookId);
    anaId = (await ana.json<{ user: { id: string } }>(ana.get('/api/session'), 200)).user.id;
    await readTo(ana, alice, 0.5);
    place = (await bookDetail(ana, alice.id)).progress.find((p) => p.userId === anaId)!.t;
  });

  afterAll(async () => {
    await closeApp(t);
    await hook.close();
  });

  it('fences an answer at the furthest fence its delivery carried: a fenced message before an unfenced question counts, deleted or not', async () => {
    // A message of its own in the channel, before anything fenced was delivered to it there.
    early = await written({ text: 'Hello, Alice readers.', bookId: alice.id });
    expect(fenceOf(early.id)).toEqual({ spoiler_t: null, spoiler_user_id: null });
    const context = await post(ana, { text: 'The Hatter’s riddle has no answer!', bookId: alice.id, spoilerUpToT: place });
    await nextMillisecond();
    // A question that starts a conversation, fenced at nothing: it goes with the channel's last messages.
    const ask = await post(ana, { text: '@lux could chat show a reading-progress badge?', bookId: alice.id });
    expect(!ask.hidden && ask.spoilerLabel).toBeNull();
    await t.settle();
    const event = JSON.parse(hook.received.at(-1)!.body) as AgentEventV1;
    expect(event.message.id).toBe(ask.id);
    expect(event.thread.map((m) => m.text)).toContain('The Hatter’s riddle has no answer!');
    // Deleted before the agent answers: what it was given still counts.
    expect((await ana.delete(`/api/chat/${context.id}`)).statusCode).toBe(204);
    answer = await written({ text: 'Noted: a badge, by the Hatter’s riddle.', parentId: ask.id });
    expect(fenceOf(answer.id)).toEqual({ spoiler_t: place, spoiler_user_id: anaId });
    expect(await hiddenFrom(ana, answer.id, ask.id)).toBe(false);
    expect(await hiddenFrom(ben, answer.id, ask.id)).toBe(true);
  });

  it('fences a message of its own in a book’s channel at the most ever delivered to it there; an edit fences again, never lower', async () => {
    const own = await written({ text: 'Shipped: progress badges.', bookId: alice.id });
    // At no one's place: which delivery it drew on, Book Club cannot tell.
    expect(fenceOf(own.id)).toEqual({ spoiler_t: place, spoiler_user_id: null });
    expect(await hiddenFrom(ben, own.id)).toBe(true);
    // Its message from before anything was fenced, edited now, may draw on what came since.
    expect((await asAgent('PATCH', `/api/agents/v1/messages/${early.id}`, { text: 'Hello again, Alice readers.' })).statusCode).toBe(200);
    expect(fenceOf(early.id)).toEqual({ spoiler_t: place, spoiler_user_id: null });
    expect(await hiddenFrom(ben, early.id)).toBe(true);
    // A fence further on than a fresh one would be is kept so through an edit.
    t.ctx.db.exec('UPDATE chat_messages SET spoiler_t = ? WHERE id = ?', [0.97, answer.id]);
    expect((await asAgent('PATCH', `/api/agents/v1/messages/${answer.id}`, { text: 'Noted: a progress badge.' })).statusCode).toBe(200);
    expect(fenceOf(answer.id)).toEqual({ spoiler_t: 0.97, spoiler_user_id: anaId });
    // General has no fences.
    expect(fenceOf((await written({ text: 'Shipped, for everyone.' })).id).spoiler_t).toBeNull();
  });

  it('answers only a message delivered to it, saying nothing of any other', async () => {
    const plain = await post(ben, { text: 'no agent named here' });
    const notSent = await asAgent('POST', url(), { text: 'Butting in.', parentId: plain.id });
    expect(notSent.statusCode).toBe(404);
    const madeUp = await asAgent('POST', url(), { text: 'Butting in.', parentId: 'no-such-message-id' });
    expect(madeUp.statusCode).toBe(404);
    // The same refusal either way: whether a message exists is not the agent's to learn.
    expect(madeUp.json()).toEqual(notSent.json());
    // Its own messages were never delivered to it either.
    expect((await asAgent('POST', url(), { text: 'Talking to myself.', parentId: early.id })).statusCode).toBe(404);
  });

  it('names no address in a delivery, whatever Host the asker’s request came with', async () => {
    // A member's own script can send any Host, and an Origin to match it (the CSRF check compares the two).
    const forged = await rawPost(t.baseUrl, `/api/clubs/${club.id}/chat`, { host: 'attacker.example', origin: 'http://attacker.example', cookie: ana.cookieHeader }, { text: '@lux over here?' });
    expect(forged.status).toBe(201);
    await t.settle();
    const delivery = hook.received.at(-1)!;
    expect(delivery.body).not.toContain('attacker.example');
    expect(delivery.body).not.toMatch(/https?:\/\//u);
    expect((JSON.parse(delivery.body) as AgentEventV1).reply).toEqual({ path: url(), parentId: (forged.json as { id: string }).id });
  });

});

/**
 * A delivery tried again (D205) is built again: the conversation as it is then, so what was deleted
 * meanwhile is not sent, and what its asker has come to read is; the fence kept with it rises to
 * cover it. On an app of its own, so its first attempt carries nothing fenced.
 */
describe('a delivery tried again (D205)', () => {
  let hook: Awaited<ReturnType<typeof receiver>>;
  let t: TestApp;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let alice: BookDetail;
  let anaId: string;

  const post = async (c: Client, body: Record<string, unknown>) => c.json<ChatMessageView>(c.post(`/api/clubs/${club.id}/chat`, body), 201);
  const recorded = (messageId: string) => t.ctx.db.get<{ fence_t: number | null }>("SELECT fence_t FROM agent_deliveries WHERE agent = 'lux' AND message_id = ?", [messageId])!.fence_t;

  beforeAll(async () => {
    hook = await receiver();
    t = await makeTestApp(agentsEnv(hook.url));
    let owner: Client;
    ({ owner, club } = await setupOwner(t, 'Cole', 'Thursday Readers'));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben Carter');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    alice = await bookDetail(owner, bookId);
    anaId = (await ana.json<{ user: { id: string } }>(ana.get('/api/session'), 200)).user.id;
    await readTo(ana, alice, 0.5);
  });

  afterAll(async () => {
    await closeApp(t);
    await hook.close();
  });

  it('leaves out what was deleted meanwhile, carries what its asker may read by then, and its fence rises to cover it', async () => {
    hook.mode.status = 500;
    t.ctx.agents.retryDelaysMs = [1500, 1500];
    try {
      // Fenced past where Ana has read: not hers to read yet, so not sent the first time.
      await post(ben, { text: 'The croquet game decides it all.', bookId: alice.id, spoilerUpToT: 0.95 });
      const gone = await post(ana, { text: 'Delete me before it goes.', bookId: alice.id });
      await nextMillisecond();
      const ask = await post(ana, { text: '@lux one more idea for the badge', bookId: alice.id });
      await waitUntil(() => hook.received.length > 0, 5000, 'the first attempt');
      expect(recorded(ask.id)).toBeNull();
      hook.mode.status = 204;
      // Before the retry, Ana reads to the end, and deletes a message the first attempt carried.
      await readTo(ana, alice, 1);
      expect((await ana.delete(`/api/chat/${gone.id}`)).statusCode).toBe(204);
      await t.settle();
      const attempts = hook.received;
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts.map((r) => r.headers[AGENT_HEADERS.delivery])).size).toBe(1);
      expect(attempts[0]!.body).toContain('Delete me before it goes.');
      expect(attempts[0]!.body).not.toContain('croquet');
      expect(attempts[1]!.body).not.toContain('Delete me before it goes.');
      expect(attempts[1]!.body).toContain('The croquet game decides it all.');
      expect(recorded(ask.id)).toBe(0.95);
      // So its answer, which may carry Ben's words, is fenced where his message is, and open to Ana.
      const res = await t.client().request({ method: 'POST', url: `/api/agents/v1/clubs/${club.id}/messages`, headers: { authorization: `Bearer ${TOKEN}` }, payload: { text: 'Noted, croquet and all.', parentId: ask.id } });
      expect(res.statusCode).toBe(201);
      const answer = res.json<{ message: { id: string } }>().message;
      expect(t.ctx.db.get('SELECT spoiler_t, spoiler_user_id FROM chat_messages WHERE id = ?', [answer.id])).toEqual({ spoiler_t: 0.95, spoiler_user_id: anaId });
    } finally {
      hook.mode.status = 204;
      t.ctx.agents.retryDelaysMs = [1000, 4000];
    }
  });
});

describe('agents of other services, end to end with the stand-in (tools/fake-agent)', () => {
  it('a message naming it is answered in the thread by the agent itself, through its own API', async () => {
    let api = '';
    const fake = await startFakeAgent({ port: 0, secret: SECRET, token: TOKEN, name: 'Lux', api: () => api });
    const t = await makeTestApp({ CHAT_AGENTS: JSON.stringify([{ handle: 'lux', name: 'Lux', webhookUrl: `http://127.0.0.1:${fake.port}/hook`, webhookSecret: SECRET, token: TOKEN, clubs: '*' }]) });
    api = t.baseUrl;
    try {
      const { owner, club } = await setupOwner(t);
      const ask = await owner.json<ChatMessageView>(owner.post(`/api/clubs/${club.id}/chat`, { text: '@lux could chat show who reacted?' }), 201);
      await t.settle();
      const answer = async () => (await owner.json<{ replies: ChatMessageView[] }>(owner.get(`/api/chat/${ask.id}/thread`), 200)).replies.find((m) => m.author.agent === 'lux');
      await waitUntil(async () => (await answer()) !== undefined, 5000, 'the agent’s answer');
      const reply = (await answer())!;
      expect(!reply.hidden && reply.text).toBe('Lux here. I read: “@lux could chat show who reacted?” (0 earlier in the conversation).');
      expect(fake.deliveries).toHaveLength(1);
      expect(fake.deliveries[0]).toMatchObject({ verified: true, event: 'chat.mention' });
    } finally {
      await closeApp(t);
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });
});

describe('a server that stops, while an agent’s webhook is not answering (D205)', () => {
  it('calls the delivery off at once, rather than wait out its attempts', async () => {
    let arrived = 0;
    // Takes every delivery and never answers it.
    const silent: Server = createServer(() => {
      arrived++;
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as { port: number };
    const t = await makeTestApp({ CHAT_AGENTS: JSON.stringify([{ handle: 'lux', name: 'Lux', webhookUrl: `http://127.0.0.1:${port}/hook`, webhookSecret: SECRET, token: TOKEN, clubs: '*' }]) });
    let open = true;
    try {
      const { owner, club } = await setupOwner(t);
      await owner.json<ChatMessageView>(owner.post(`/api/clubs/${club.id}/chat`, { text: '@lux still there?' }), 201);
      await waitUntil(() => arrived > 0, 5000, 'the delivery under way');
      expect(t.ctx.agents.pending).toBe(1);
      const started = Date.now();
      await closeApp(t);
      open = false;
      // Ten seconds an attempt, three of them, a second and four between: 35 s, were it not called off.
      expect(Date.now() - started).toBeLessThan(3000);
      expect(arrived).toBe(1);
    } finally {
      if (open) await closeApp(t);
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe('CHAT_AGENTS (D205)', () => {
  const one = (overrides: Record<string, unknown> = {}) => ({ handle: 'lux', name: 'Lux', webhookUrl: 'https://agent.example.org/hook', webhookSecret: SECRET, token: TOKEN, clubs: ['c1'], ...overrides });
  const load = (agents: unknown) => loadConfig({ CHAT_AGENTS: typeof agents === 'string' ? agents : JSON.stringify(agents) });

  it('reads none when unset or empty, and a well-formed agent as given', () => {
    expect(loadConfig({}).CHAT_AGENTS).toEqual([]);
    expect(loadConfig({ CHAT_AGENTS: '' }).CHAT_AGENTS).toEqual([]);
    expect(load([one({ avatar: 'data:image/png;base64,iVBORw0KGgo=' })]).CHAT_AGENTS[0]).toMatchObject({ handle: 'lux', clubs: ['c1'], perMemberPerMinute: 4, perMinute: 30 });
  });

  it('refuses what would be wrong, saying what, and never what a secret was', () => {
    const refuses = (agents: unknown, what: RegExp) => {
      let message = '';
      try {
        load(agents);
      } catch (err) {
        message = String(err);
      }
      expect(message).toMatch(what);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(TOKEN);
    };
    refuses('not json', /expected array/i);
    refuses([one({ handle: 'cal' })], /Cal's own handle/);
    refuses([one({ handle: 'Lux' })], /lowercase/);
    // (zod's own report quotes the message, so its quotation marks come escaped.)
    refuses([one(), one({ token: `${TOKEN}-2` })], /names \\?"lux\\?" twice/);
    refuses([one(), one({ handle: 'scout' })], /a token of its own/);
    refuses([one({ token: SECRET })], /must differ/);
    refuses([one({ webhookSecret: 'short' })], /at least 32/);
    // An address with a user and a password in it (built from parts: written whole, a secret scanner takes the placeholder for a credential).
    const withCredentials = Object.assign(new URL('https://agent.example.org/hook'), { username: 'user', password: 'pass' }).href;
    refuses([one({ webhookUrl: withCredentials })], /without credentials/);
    refuses([one({ webhookUrl: 'ftp://agent.example.org/hook' })], /http\(s\)/);
    refuses([one({ avatar: 'three words here' })], /an avatar is/);
    refuses([one({ avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })], /an avatar is/);
    refuses([one({ clubs: [] })], /too small|at least 1/i);
    refuses([one({ secret: 'typo' })], /unrecognized/i);
    // Every token and secret is one agent's alone: one agent's secret as another's token would let
    // the first post as the second; a secret two share would let either sign the other's deliveries.
    refuses([one(), one({ handle: 'scout', token: SECRET, webhookSecret: `${SECRET}-scout` })], /\\?"scout\\?"'s token is another agent's webhookSecret/);
    refuses([one(), one({ handle: 'scout', token: `${TOKEN}-scout`, webhookSecret: SECRET })], /\\?"scout\\?"'s webhookSecret is another agent's webhookSecret/);
    refuses([one(), one({ handle: 'scout', token: `${TOKEN}-scout`, webhookSecret: TOKEN })], /\\?"scout\\?"'s webhookSecret is another agent's token/);
  });

  it('refuses a webhook address that does not parse as a message, never printing the address (it may hold a key)', () => {
    let caught: unknown;
    try {
      load([one({ webhookUrl: 'hooks.example/abc?key=a-key-in-the-address' })]);
    } catch (err) {
      caught = err;
    }
    // As Node prints an error that stops the server: its message, and every property it holds.
    const printed = inspect(caught, { depth: 10 });
    expect(printed).toMatch(/CHAT_AGENTS/);
    expect(printed).toMatch(/webhookUrl is an http\(s\) address/);
    expect(printed).not.toContain('a-key-in-the-address');
  });

  it('cleans control characters and direction overrides out of what an agent writes', () => {
    expect(cleanAgentText('\u202eabc\u202c d\u2066e\u2069\u0000\u0007\r\nf\tg ')).toBe('abc de\nf\tg');
  });
});
