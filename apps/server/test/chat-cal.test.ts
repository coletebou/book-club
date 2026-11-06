import type Anthropic from '@anthropic-ai/sdk';
import { type BookDetail, ChatAgentListSchema, type ChatMessageView, ChatThreadSchema, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ChatModel } from '../src/cal/anthropic';
import { DeterministicFakeChatModel } from '../src/cal/fake-model';
import { CAL_NOTICES } from '../src/cal/in-chat';
import { ALICE_EPUB, type Client, type Socket, type TestApp, bookDetail, closeApp, fileFrom, fileOf, joinClub, makeEpub, makeTestApp, openSocket, outsider, setupOwner, uploadBook } from './helpers';

type Params = Parameters<ChatModel['stream']>[0];
type Final = Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>;
const usage = { input_tokens: 5, output_tokens: 5 } as Anthropic.Usage;
const textOnly = (text: string): Final => ({ content: [{ type: 'text', text, citations: null }] as unknown as Anthropic.ContentBlock[], stop_reason: 'end_turn', usage });

/** Says `text` on every turn, and keeps what it was given. */
class Scripted implements ChatModel {
  readonly calls: Params[] = [];
  constructor(private readonly text: string) {}
  stream(params: Params) {
    this.calls.push(params);
    const final = textOnly(this.text);
    return { on: () => {}, finalMessage: () => Promise.resolve(final) };
  }
}

/** The deterministic fake (real search, real gate), keeping what each turn was given. */
class Recording extends DeterministicFakeChatModel {
  readonly calls: Params[] = [];
  override stream(params: Params) {
    this.calls.push(params);
    return super.stream(params);
  }
}

/** Holds its answer until released, so a test can act while Cal works. */
class Held implements ChatModel {
  release: () => void = () => {};
  private begun: () => void = () => {};
  readonly started = new Promise<void>((resolve) => (this.begun = resolve));
  stream() {
    this.begun();
    const gate = new Promise<void>((resolve) => (this.release = resolve));
    return { on: () => {}, finalMessage: async () => (await gate, textOnly('A late answer.')) };
  }
}

const failing: ChatModel = {
  stream: () => ({ on: () => {}, finalMessage: () => Promise.reject(new Error('model unavailable')) }),
};

/** The text of every message a model call was given, joined, for asserting on what Cal saw. */
const seen = (params: Params) => params.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

/**
 * Cal in the club's chat (D204), over the real server with the deterministic fake model (real
 * hybrid search and real spoiler gate; only the model's own reasoning faked): @cal is answered in
 * the thread, as Cal, from what the asker has read, fenced at their place; General draws on no
 * book; anything stopping a turn is told to the asker alone; agents never ask agents.
 */
describe('Cal in chat (D204)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let alice: BookDetail;
  let zebraId: string;
  let calId: string;
  let ids: Record<string, string>;
  let anaSocket: Socket;
  let benSocket: Socket;

  const post = async (c: Client, body: Record<string, unknown>, status = 201) => c.json<ChatMessageView>(c.post(`/api/clubs/${club.id}/chat`, body), status);
  const thread = async (c: Client, id: string) => ChatThreadSchema.parse(await c.json(c.get(`/api/chat/${id}/thread`), 200));
  const calMessages = () => t.ctx.db.all<{ id: string; parent_id: string; text: string; spoiler_t: number | null; spoiler_user_id: string | null }>('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at, id', [calId]);
  const calAnswersTo = (id: string) => calMessages().filter((m) => m.parent_id === id);

  /** Read `fraction` of an EPUB book as `c` (from its start), through the app's own progress route. */
  async function readTo(c: Client, book: BookDetail, fraction: number) {
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const total = geometry.sectionLengths.reduce((a, b) => a + b, 0);
    let left = Math.floor(total * fraction);
    let section = 0;
    while (section < geometry.sectionLengths.length - 1 && left > geometry.sectionLengths[section]!) left -= geometry.sectionLengths[section++]!;
    const to = { kind: 'epub' as const, section, offset: Math.min(left, geometry.sectionLengths[section]!) };
    const res = await c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: to, readSpans: [{ from: { kind: 'epub', section: 0, offset: 0 }, to }], at: Date.now() });
    expect(res.statusCode).toBe(200);
  }

  beforeAll(async () => {
    t = await makeTestApp({ CAL_TEST_FAKE_MODEL: 'true', CAL_EMBEDDING_PROVIDER: 'fake', CAL_RATE_LIMIT_PER_MINUTE: '1000' });
    // Cal's users row is made at start, and is no account: setting the instance up still works.
    const session = await t.client().json<{ setupRequired: boolean }>(t.client().get('/api/session'), 200);
    expect(session.setupRequired).toBe(true);
    ({ owner, club } = await setupOwner(t, 'Cole', 'Thursday Readers'));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben Carter');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    const zebra = await uploadBook(owner, club.id, 'epub', [fileOf('zebra.epub', makeEpub(['<p>' + 'The quagga grazed beside the zebra. '.repeat(60) + '</p>'], { title: 'Zebra Book', author: 'Test' }), 'main', 'application/epub+zip')], {
      title: 'Zebra Book',
      author: 'Test',
    });
    zebraId = zebra.bookId;
    await t.settle();
    alice = await bookDetail(owner, bookId);
    const me = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/session'), 200)).user.id;
    ids = { cole: await me(owner), ana: await me(ana), ben: await me(ben) };
    calId = t.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE agent = 'cal'")!.id;
    await readTo(ana, alice, 0.3);
    await readTo(ben, alice, 0.6);
    await readTo(ana, await bookDetail(owner, zebraId), 1);
    anaSocket = await openSocket(t, ana);
    benSocket = await openSocket(t, ben);
    for (const s of [anaSocket, benSocket]) s.send({ type: 'subscribe', clubId: club.id });
    await anaSocket.next('presence');
    await benSocket.next('presence');
  });

  afterAll(async () => {
    await anaSocket.close();
    await benSocket.close();
    await closeApp(t);
  });

  it('keeps Cal’s row from ever being an account: no email, no password, disabled, never counted', () => {
    const row = t.ctx.db.get<{ display_name: string; email: string | null; password_hash: string | null; disabled_at: number | null }>('SELECT * FROM users WHERE id = ?', [calId])!;
    expect(row).toMatchObject({ display_name: 'Cal', email: null, password_hash: null });
    expect(row.disabled_at).not.toBeNull();
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?", [calId])!.n).toBe(0);
  });

  it('offers Cal to the club’s members, saying what he does, and to no one else', async () => {
    const list = ChatAgentListSchema.parse(await ana.json(ana.get(`/api/clubs/${club.id}/chat/agents`), 200));
    expect(list.agents).toEqual([{ handle: 'cal', displayName: 'Cal', kind: 'cal', about: expect.stringContaining('from what you have read') as string }]);
    const ozzy = await outsider(t, owner);
    expect((await ozzy.get(`/api/clubs/${club.id}/chat/agents`)).statusCode).toBe(404);
  });

  it('answers @cal in the thread, as Cal, from what the asker has read, fenced at their place, with "Cal is typing" while he works', async () => {
    const ask = await post(ana, { text: '@cal What does the White Rabbit say?', bookId: alice.id });
    expect(ask.hidden).toBe(false);
    if (ask.hidden) return;
    // The server read @cal as Cal (D201's one parser, with the club's agents in its directory).
    expect(ask.mentions).toEqual([{ start: 0, end: 4, userId: null, agent: 'cal' }]);
    const typing = await benSocket.next('chat:typing', (m) => m.userId === calId && m.until > Date.now());
    expect(typing).toMatchObject({ clubId: club.id, bookId: alice.id, displayName: 'Cal' });
    await t.settle();

    const [answer] = calAnswersTo(ask.id);
    expect(answer).toBeDefined();
    // Fenced a hair before the furthest place Ana has read, and opening for her as her own words do.
    expect(answer!.spoiler_t).toBeGreaterThan(0.2);
    expect(answer!.spoiler_t).toBeLessThan(0.4);
    expect(answer!.spoiler_user_id).toBe(ids.ana);

    const forAna = (await thread(ana, ask.id)).replies.find((m) => m.id === answer!.id)!;
    expect(forAna).toMatchObject({ hidden: false, parentId: ask.id, threadId: ask.id, bookId: alice.id, mine: false, author: { userId: calId, displayName: 'Cal', agent: 'cal' } });
    if (forAna.hidden) return;
    // The fake's own words (its preamble kept, as in his panel), then the passage it cited, as a footnote.
    expect(forAna.text).toMatch(/^Let me check the shelf\.\nHere is what the shelf says\. \[1\]\n\n\[1\] Alice/);
    expect(forAna.spoilerLabel).toMatch(/^Spoiler up to /);
    // Ben has read further: it is open to him. Cole has read nothing: only where it opens.
    expect((await thread(ben, ask.id)).replies.find((m) => m.id === answer!.id)!.hidden).toBe(false);
    const forCole = (await thread(owner, ask.id)).replies.find((m) => m.id === answer!.id)!;
    expect(forCole).toMatchObject({ hidden: true, spoilerLabel: expect.stringMatching(/^Spoiler up to /) as string });
    // Every screen heard it as it is for them, and his typing ended with it.
    expect((await benSocket.next('chat:new', (m) => m.message.id === answer!.id)).message.hidden).toBe(false);
    await benSocket.next('chat:typing', (m) => m.userId === calId && m.until === 0);
  });

  it('draws only on the channel’s own book: another book Ana has read never reaches him', async () => {
    const model = new Recording();
    t.ctx.agents.calModel = () => model;
    try {
      const ask = await post(ana, { text: '@cal tell me about the quagga', bookId: alice.id });
      await t.settle();
      expect(calAnswersTo(ask.id)).toHaveLength(1);
      expect(model.calls.length).toBeGreaterThan(1);
      // The search he ran: the zebra book's words are not in what it gave him, though Ana has read them all.
      expect(model.calls.map(seen).join('\n')).not.toContain('quagga grazed');
      expect(calAnswersTo(ask.id)[0]!.text).not.toContain('Zebra Book');
      // The same question in that book's own channel does find it.
      const there = await post(ana, { text: '@cal tell me about the quagga', bookId: zebraId });
      await t.settle();
      expect(calAnswersTo(there.id)[0]!.text).toContain('[1] Zebra Book');
    } finally {
      t.ctx.agents.calModel = null;
    }
  });

  it('in General draws on no book at all, fences nothing, and is told to keep every story to itself', async () => {
    const model = new Recording();
    t.ctx.agents.calModel = () => model;
    try {
      const ask = await post(ana, { text: '@cal What does the White Rabbit say?' });
      await t.settle();
      const [answer] = calAnswersTo(ask.id);
      expect(answer).toMatchObject({ spoiler_t: null, spoiler_user_id: null });
      expect(answer!.text).toBe("Let me check the shelf.\nI couldn't find anything about that in what you've read so far.");
      const system = model.calls[0]!.system.map((b) => b.text).join('\n');
      expect(system).toContain("General channel");
      expect(system).toContain('say nothing of what happens in any of the club');
      // Open to everyone at once, Cole who has read nothing too.
      expect((await thread(owner, ask.id)).replies.find((m) => m.id === answer!.id)!.hidden).toBe(false);
    } finally {
      t.ctx.agents.calModel = null;
    }
  });

  it('is given the thread as the asker may read it: a reply fenced past her place stays out, and his own answers are his turns', async () => {
    const model = new Scripted('Noted.');
    t.ctx.agents.calModel = () => model;
    try {
      const root = await post(owner, { text: 'Thoughts on the opening chapters?', bookId: alice.id });
      await post(ben, { text: 'The trial at the very end is wild', parentId: root.id, spoilerUpToT: 0.95 });
      await post(ana, { text: '@cal what do you make of the pool of tears?', parentId: root.id });
      await t.settle();
      const first = model.calls[0]!;
      const given = seen(first);
      expect(given).toContain('Cole: Thoughts on the opening chapters?');
      expect(given).toContain('Ana: @cal what do you make of the pool of tears?');
      expect(given).not.toContain('trial');
      expect(first.system.map((b) => b.text).join('\n')).toMatch(/channel for "Alice"\. Ana's place in it: they have read to /);
      // A follow-up in the thread: his answer before it is his own turn.
      await post(ana, { text: '@cal and the caucus race?', parentId: root.id });
      await t.settle();
      expect(model.calls[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(model.calls[1]!.messages[1]!.content).toBe('Noted.');
    } finally {
      t.ctx.agents.calModel = null;
    }
  });

  it('never answers himself, and a reply to his answer asks him again unless it names someone else', async () => {
    const model = new Scripted('@cal, did someone say @cal? Ask @Ben Carter too.');
    t.ctx.agents.calModel = () => model;
    try {
      const ask = await post(ana, { text: '@cal hello there' });
      await t.settle();
      const answers = calAnswersTo(ask.id);
      // One answer, though it @-mentions Cal twice: agents never ask agents.
      expect(answers).toHaveLength(1);
      expect(model.calls).toHaveLength(1);
      // It named Ben, so Ben's bell has it, as from Cal.
      const bell = await ben.json<{ items: { kind: string; chatMessageId?: string | null }[] }>(ben.get('/api/notifications'), 200);
      expect(bell.items.some((n) => n.kind === 'mention' && n.chatMessageId === answers[0]!.id)).toBe(true);

      await post(ana, { text: 'And what else?', parentId: answers[0]!.id });
      await t.settle();
      expect(model.calls).toHaveLength(2);
      await post(ana, { text: '@Ben Carter look at this', parentId: answers[0]!.id });
      await t.settle();
      expect(model.calls).toHaveLength(2);
    } finally {
      t.ctx.agents.calModel = null;
    }
  });

  it('says why to the asker alone when he will not answer: the spend cap, his rate limit, a failure', async () => {
    t.ctx.db.exec("INSERT INTO cal_cost_log (id, club_id, user_id, kind, provider, model, input_units, output_units, cost_usd, created_at) VALUES ('cap-test', ?, NULL, 'chat', 'test', 'test', 0, 0, 1000, ?)", [club.id, Date.now()]);
    try {
      const capped = await post(ana, { text: '@cal one more question' });
      expect(await anaSocket.next('chat:notice', (m) => m.messageId === capped.id)).toMatchObject({ clubId: club.id, agent: 'cal', text: CAL_NOTICES.club });
      await t.settle();
      expect(calAnswersTo(capped.id)).toHaveLength(0);
    } finally {
      t.ctx.db.exec("DELETE FROM cal_cost_log WHERE id = 'cap-test'");
    }

    const limiter = t.ctx.agents.limiter('cal', 1000);
    for (let i = 0; i < 1000; i++) limiter.record(ids.ana!);
    try {
      const limited = await post(ana, { text: '@cal and another' });
      expect((await anaSocket.next('chat:notice', (m) => m.messageId === limited.id)).text).toBe(CAL_NOTICES.rate);
      await t.settle();
      expect(calAnswersTo(limited.id)).toHaveLength(0);
    } finally {
      limiter.reset(ids.ana!);
    }

    t.ctx.agents.calModel = () => failing;
    try {
      const failed = await post(ana, { text: '@cal are you there?' });
      await t.settle();
      expect((await anaSocket.next('chat:notice', (m) => m.messageId === failed.id)).text).toBe(CAL_NOTICES.failed);
      expect(calAnswersTo(failed.id)).toHaveLength(0);
      await anaSocket.next('chat:typing', (m) => m.userId === calId && m.until === 0);
    } finally {
      t.ctx.agents.calModel = null;
    }
    // None of it reached anyone else.
    expect(await benSocket.quiet('chat:notice')).toBe(true);
  });

  it('posts nothing for a question deleted while he works', async () => {
    const model = new Held();
    t.ctx.agents.calModel = () => model;
    try {
      const ask = await post(ana, { text: '@cal take your time' });
      await model.started;
      expect((await ana.delete(`/api/chat/${ask.id}`)).statusCode).toBe(204);
      model.release();
      await t.settle();
      expect(calAnswersTo(ask.id)).toHaveLength(0);
    } finally {
      t.ctx.agents.calModel = null;
    }
  });

  it('is asked only by a message being sent: an edit that adds @cal asks no one', async () => {
    const model = new Scripted('Here.');
    t.ctx.agents.calModel = () => model;
    try {
      const plain = await post(ana, { text: 'no one asked' });
      expect((await ana.patch(`/api/chat/${plain.id}`, { text: '@cal now?' })).statusCode).toBe(200);
      await t.settle();
      expect(model.calls).toHaveLength(0);
      expect(calAnswersTo(plain.id)).toHaveLength(0);
    } finally {
      t.ctx.agents.calModel = null;
    }
  });
});

describe('Cal in chat, on a server without him (D204)', () => {
  it('offers no agents, reads @cal as plain text, and answers nothing', async () => {
    const t = await makeTestApp();
    try {
      const { owner, club } = await setupOwner(t);
      expect(ChatAgentListSchema.parse(await owner.json(owner.get(`/api/clubs/${club.id}/chat/agents`), 200)).agents).toEqual([]);
      const ask = await owner.json<ChatMessageView>(owner.post(`/api/clubs/${club.id}/chat`, { text: '@cal hello?' }), 201);
      expect(!ask.hidden && ask.mentions).toEqual([]);
      await t.settle();
      expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE agent IS NOT NULL')!.n).toBe(0);
      expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_messages')!.n).toBe(1);
    } finally {
      await closeApp(t);
    }
  });
});
