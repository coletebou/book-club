import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
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
      reply: { url: `${t.baseUrl}/api/agents/v1/clubs/${club.id}/messages`, parentId: ask.id },
    });
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

  it('says it is typing, to everyone in the club', async () => {
    expect((await asAgent('POST', `/api/agents/v1/clubs/${club.id}/typing`, { bookId: alice.id })).statusCode).toBe(204);
    const typing = await anaSocket.next('chat:typing', (m) => m.userId === luxId);
    expect(typing).toMatchObject({ clubId: club.id, bookId: alice.id, displayName: 'Lux' });
  });

  it('passes a message’s pictures as addresses signed for it and fetched with its token, nothing else', async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3a6' } }).png().toBuffer();
    const picture = (await upload(ana, club.id, png)).json<{ id: string }>();
    const ask = await post(ana, { text: '@lux this one', attachmentIds: [picture.id] });
    await t.settle();
    const event = eventOf(deliveries().at(-1)!);
    expect(event.message.id).toBe(ask.id);
    expect(event.message.images).toHaveLength(1);
    const address = new URL(event.message.images[0]!.url);
    expect(address.pathname).toBe(`/api/agents/v1/media/${picture.id}`);
    const path = `${address.pathname}${address.search}`;
    const ok = await asAgent('GET', path);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect((await sharp(ok.bytes).metadata()).width).toBe(64);
    expect((await asAgent('GET', path, undefined, '')).statusCode).toBe(401);
    // Signed for Lux: no use to another agent, nor once changed, nor once past its hour.
    expect((await asAgent('GET', path, undefined, SCOUT_TOKEN)).statusCode).toBe(404);
    expect((await asAgent('GET', path.replace(/signature=./u, 'signature=A'))).statusCode).toBe(404);
    const past = Date.now() - 1000;
    expect((await asAgent('GET', `${address.pathname}?expires=${past}&signature=${t.ctx.agents.mediaSignature('lux', picture.id, past)}`)).statusCode).toBe(404);
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

describe('agents of other services, end to end with the stand-in (tools/fake-agent)', () => {
  it('a message naming it is answered in the thread by the agent itself, through its own API', async () => {
    const fake = await startFakeAgent({ port: 0, secret: SECRET, token: TOKEN, name: 'Lux' });
    const t = await makeTestApp({ CHAT_AGENTS: JSON.stringify([{ handle: 'lux', name: 'Lux', webhookUrl: `http://127.0.0.1:${fake.port}/hook`, webhookSecret: SECRET, token: TOKEN, clubs: '*' }]) });
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
    refuses([one({ webhookUrl: 'https://user:pass@agent.example.org/hook' })], /without credentials/);
    refuses([one({ webhookUrl: 'ftp://agent.example.org/hook' })], /http\(s\)/);
    refuses([one({ avatar: 'three words here' })], /an avatar is/);
    refuses([one({ avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })], /an avatar is/);
    refuses([one({ clubs: [] })], /too small|at least 1/i);
    refuses([one({ secret: 'typo' })], /unrecognized/i);
  });

  it('cleans control characters and direction overrides out of what an agent writes', () => {
    expect(cleanAgentText('\u202eabc\u202c d\u2066e\u2069\u0000\u0007\r\nf\tg ')).toBe('abc de\nf\tg');
  });
});
