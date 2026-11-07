import {
  ApiErrorSchema,
  type BookDetail,
  ChatHistorySchema,
  type ChatMessageView,
  ChatThreadSchema,
  type ClubDetail,
  HiddenChatMessageSchema,
  NotificationListSchema,
  RevealedChatMessageSchema,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE_EPUB, type Client, type Res, type Socket, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, openSocket, outsider, setupOwner, uploadBook } from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

/**
 * Reply threading (D200) and @-mention spans (D201) over the real server: replies join their
 * parent's thread and channel, quotes are gated exactly as the message they quote, a thread reads
 * on its own from any message in it, deleting keeps a root its replies hang from, and mentions
 * come back as the spans the composer highlights, read by the same parser that notifies.
 */
describe('chat threads and mentions (D200, D201)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let grantS: Client;
  let book: BookDetail;
  let ids: Record<string, string>;

  const post = async (c: Client, body: Record<string, unknown>, status = 201) => c.json<ChatMessageView>(c.post(`/api/clubs/${club.id}/chat`, body), status);
  const history = async (c: Client, query = '') => ChatHistorySchema.parse(await c.json(c.get(`/api/clubs/${club.id}/chat${query}`), 200));
  const find = async (c: Client, id: string, query = '') => (await history(c, query)).messages.find((m) => m.id === id);
  const thread = async (c: Client, id: string) => ChatThreadSchema.parse(await c.json(c.get(`/api/chat/${id}/thread`), 200));

  /** Read the whole Alice EPUB as `c`, so every fence in it opens for them. */
  async function readAll(c: Client) {
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const last = geometry.sectionLengths.length - 1;
    const end = { kind: 'epub' as const, section: last, offset: geometry.sectionLengths[last]! };
    const res = await c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: end, readSpans: [{ from: { kind: 'epub', section: 0, offset: 0 }, to: end }], at: Date.now() });
    expect(res.statusCode).toBe(200);
  }

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t, 'Cole', 'Thursday Readers'));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben Carter');
    grantS = await joinClub(t, club, 'Grant Smith');
    await joinClub(t, club, 'Grant Lee');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
    const me = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/session'), 200)).user.id;
    ids = { ana: await me(ana), ben: await me(ben), grantS: await me(grantS) };
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('a reply joins its parent’s thread, quotes it, and counts on the root', async () => {
    const root = await post(ana, { text: 'Who is the White Rabbit late for?' });
    expect(root).toMatchObject({ parentId: null, threadId: null, replyCount: 0, replyTo: null });
    const first = await post(ben, { text: 'The Duchess, I think', parentId: root.id });
    expect(first).toMatchObject({ parentId: root.id, threadId: root.id });
    expect(first.replyTo).toMatchObject({ id: root.id, hidden: false, deleted: false, text: 'Who is the White Rabbit late for?', author: { displayName: 'Ana' } });
    // A reply to a reply still belongs to the first message's thread.
    const second = await post(ana, { text: 'Of course!', parentId: first.id });
    expect(second).toMatchObject({ parentId: first.id, threadId: root.id });
    expect(second.replyTo?.id).toBe(first.id);
    expect((await find(owner, root.id))?.replyCount).toBe(2);

    const whole = await thread(owner, second.id);
    expect(whole.root.id).toBe(root.id);
    expect(whole.replies.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(whole).toMatchObject({ hasMore: false, channel: 'general' });
  });

  it('cuts a long parent to a short quote', async () => {
    const long = await post(ana, { text: `${'Down the rabbit hole, '.repeat(20)}the end.` });
    const answer = await post(ben, { text: 'tl;dr', parentId: long.id });
    expect(answer.replyTo!.text!.length).toBeLessThanOrEqual(141);
    expect(answer.replyTo!.text!.endsWith('…')).toBe(true);
  });

  it('keeps a reply in the channel of the message it answers', async () => {
    const inBook = await post(ana, { bookId: book.id, text: 'About the croquet game' });
    const answer = await post(ben, { text: 'Flamingos as mallets!', parentId: inBook.id });
    expect(answer.bookId).toBe(book.id);
    expect((await history(ben, `?channel=${book.id}`)).messages.some((m) => m.id === answer.id)).toBe(true);
    expect((await history(ben, '?channel=general')).messages.some((m) => m.id === answer.id)).toBe(false);
    expect((await thread(ben, answer.id)).channel).toBe(book.id);

    const wrong = await ben.post(`/api/clubs/${club.id}/chat`, { text: 'elsewhere', parentId: inBook.id, bookId: null });
    expect(wrong.statusCode).toBe(400);
    expect(errorOf(wrong).message).toMatch(/same channel/);
  });

  it('refuses a reply to a message that is gone or in another club', async () => {
    const doomed = await post(ana, { text: 'soon gone' });
    expect((await ana.delete(`/api/chat/${doomed.id}`)).statusCode).toBe(204);
    expect((await ben.post(`/api/clubs/${club.id}/chat`, { text: 'too late', parentId: doomed.id })).statusCode).toBe(404);

    // Another club (anyone signed in may start one, D176) that Ben is not in.
    const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Other Club' }), 201);
    const oz = await joinClub(t, other, 'Ozzy');
    const theirs = await oz.json<ChatMessageView>(oz.post(`/api/clubs/${other.id}/chat`, { text: 'ours' }), 201);
    expect((await ben.post(`/api/clubs/${club.id}/chat`, { text: 'crossing over', parentId: theirs.id })).statusCode).toBe(404);
    expect((await ben.get(`/api/chat/${theirs.id}/thread`)).statusCode).toBe(404);
    // And the other way: an outsider to this club cannot read one of its threads.
    expect((await oz.get(`/api/chat/${doomed.id}/thread`)).statusCode).toBe(404);
    const stranger = await outsider(t, owner, 'Odo');
    const ours = await post(ana, { text: 'members only' });
    expect((await stranger.get(`/api/chat/${ours.id}/thread`)).statusCode).toBe(404);
  });

  it('gates a quote exactly as the message it quotes, for each viewer, until they read that far', async () => {
    const reader = await joinClub(t, club, 'Rhea');
    await readAll(reader);
    const fenced = await post(reader, { bookId: book.id, text: 'the Queen wants heads off', spoilerUpToT: 0.6 });
    const answer = await post(reader, { text: 'and the King pardons them', parentId: fenced.id });

    // Grant Smith has read nothing: the reply itself is open to him (it has no fence of its own),
    // but its quote of the fenced message shows only where that opens, never its words.
    const seen = RevealedChatMessageSchema.parse(await find(grantS, answer.id, `?channel=${book.id}`));
    expect(seen.text).toBe('and the King pardons them');
    expect(seen.replyTo).toMatchObject({ id: fenced.id, hidden: true, text: null });
    expect(seen.replyTo!.spoilerLabel).toMatch(/Spoiler up to/);
    expect(JSON.stringify(seen)).not.toContain('heads off');

    const asThread = await thread(grantS, answer.id);
    HiddenChatMessageSchema.parse(asThread.root);
    expect(JSON.stringify(asThread)).not.toContain('heads off');
    // Nor may he answer what he cannot read.
    const blind = await grantS.post(`/api/clubs/${club.id}/chat`, { text: 'what?', parentId: fenced.id });
    expect(blind.statusCode).toBe(400);

    await readAll(grantS);
    const opened = RevealedChatMessageSchema.parse(await find(grantS, answer.id, `?channel=${book.id}`));
    expect(opened.replyTo).toMatchObject({ hidden: false, text: 'the Queen wants heads off', spoilerLabel: null });
  });

  it('keeps a deleted root as a placeholder while its replies live, and drops it after the last', async () => {
    const root = await post(ana, { text: 'a root to delete' });
    const only = await post(ben, { text: 'the only reply', parentId: root.id });
    expect((await ana.delete(`/api/chat/${root.id}`)).statusCode).toBe(204);

    const placeholder = RevealedChatMessageSchema.parse(await find(ben, root.id));
    expect(placeholder).toMatchObject({ deleted: true, text: null, mentions: [], replyCount: 1 });
    const quoted = RevealedChatMessageSchema.parse(await find(ben, only.id));
    expect(quoted.replyTo).toMatchObject({ id: root.id, deleted: true, text: null });
    expect((await thread(ben, only.id)).root.id).toBe(root.id);

    expect((await ben.delete(`/api/chat/${only.id}`)).statusCode).toBe(204);
    expect(await find(ben, root.id)).toBeUndefined();
    expect((await ben.get(`/api/chat/${root.id}/thread`)).statusCode).toBe(404);
  });

  it('pushes a reply’s delete with its thread, and a placeholder for a root that still has replies', async () => {
    const socket: Socket = await openSocket(t, owner);
    try {
      socket.send({ type: 'subscribe', clubId: club.id });
      await socket.next('presence');
      const root = await post(ana, { text: 'pushed root' });
      const answer = await post(ben, { text: 'pushed reply', parentId: root.id });
      const pushed = await socket.next('chat:new', (m) => m.message.id === answer.id);
      expect(pushed.message).toMatchObject({ threadId: root.id, replyTo: { id: root.id, text: 'pushed root' } });

      await ana.delete(`/api/chat/${root.id}`);
      const kept = await socket.next('chat:updated', (m) => m.message.id === root.id);
      expect(kept.message).toMatchObject({ hidden: false, deleted: true, replyCount: 1 });

      await ben.delete(`/api/chat/${answer.id}`);
      expect(await socket.next('chat:deleted', (m) => m.messageId === answer.id)).toMatchObject({ threadId: root.id });
      // With nothing left under it, the root's placeholder goes too.
      expect(await socket.next('chat:deleted', (m) => m.messageId === root.id)).toMatchObject({ threadId: null });
    } finally {
      await socket.close();
    }
  });

  it('returns mentions as spans, by the same rules that notify', async () => {
    const text = 'Thanks @Ana and @Grant Smith (not @Grant, who is two people), mail cole@example.org';
    const sent = RevealedChatMessageSchema.parse(await post(ben, { text }));
    expect(sent.mentions.map((m) => [text.slice(m.start, m.end), m.userId])).toEqual([
      ['@Ana', ids.ana],
      ['@Grant Smith', ids.grantS],
    ]);
    expect(sent.mentions.every((m) => m.agent === null)).toBe(true);
    const anaBell = NotificationListSchema.parse(await ana.json(ana.get('/api/notifications'), 200));
    expect(anaBell.items.some((n) => n.kind === 'mention' && n.chatMessageId === sent.id)).toBe(true);
    const grantBell = NotificationListSchema.parse(await grantS.json(grantS.get('/api/notifications'), 200));
    expect(grantBell.items.some((n) => n.kind === 'mention' && n.chatMessageId === sent.id)).toBe(true);
  });

  it('notifies whom an edit newly names, once', async () => {
    const draft = await post(ana, { text: 'Nobody named yet' });
    const bellOf = async (c: Client) => NotificationListSchema.parse(await c.json(c.get('/api/notifications'), 200)).items.filter((n) => n.kind === 'mention' && n.chatMessageId === draft.id);
    expect(await bellOf(ben)).toHaveLength(0);
    const edited = RevealedChatMessageSchema.parse(await ana.json(ana.patch(`/api/chat/${draft.id}`, { text: 'Now naming @Ben' }), 200));
    expect(edited.mentions.map((m) => m.userId)).toEqual([ids.ben]);
    expect(await bellOf(ben)).toHaveLength(1);
    await ana.patch(`/api/chat/${draft.id}`, { text: 'Still naming @Ben, again' });
    expect(await bellOf(ben)).toHaveLength(1);
  });

  it('carries no mentions and no words on a message hidden by its fence', async () => {
    const reader = await joinClub(t, club, 'Sol');
    await readAll(reader);
    const fenced = await post(reader, { bookId: book.id, text: '@Ana the cat vanishes', spoilerUpToT: 0.9 });
    const fresh = await joinClub(t, club, 'Tam');
    const hidden = HiddenChatMessageSchema.parse(await find(fresh, fenced.id, `?channel=${book.id}`));
    expect('mentions' in hidden).toBe(false);
    expect(JSON.stringify(hidden)).not.toContain('vanishes');
  });
});
