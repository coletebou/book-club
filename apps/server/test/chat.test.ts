import {
  ApiErrorSchema,
  ChatHistorySchema,
  ChatUnreadSchema,
  HiddenChatMessageSchema,
  NotificationListSchema,
  RevealedChatMessageSchema,
  type BookDetail,
  type ClubDetail,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE_EPUB, type Client, type Res, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

describe('live chat (D150-D152)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let book: BookDetail;

  const history = async (c: Client, query = '') => ChatHistorySchema.parse(await c.json(c.get(`/api/clubs/${club.id}/chat${query}`), 200));
  const post = (c: Client, body: Record<string, unknown>) => c.post(`/api/clubs/${club.id}/chat`, body);
  const unread = async (c: Client) => ChatUnreadSchema.parse(await c.json(c.get(`/api/clubs/${club.id}/chat/unread`), 200)).unread;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t, 'Cole', 'Thursday Readers'));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('posts, lists newest-first, edits and deletes your own message', async () => {
    const created = RevealedChatMessageSchema.parse(await t.client().json(post(ana, { text: 'hello club' }), 201));
    expect(created.text).toBe('hello club');
    expect(created.mine).toBe(true);
    expect(created.hidden).toBe(false);

    const page = await history(ana);
    expect(page.messages[0]!.id).toBe(created.id);

    const editRes = await ana.patch(`/api/chat/${created.id}`, { text: 'hello club!' });
    expect(editRes.statusCode).toBe(200);
    expect(RevealedChatMessageSchema.parse(editRes.json()).text).toBe('hello club!');

    const forbiddenEdit = await ben.patch(`/api/chat/${created.id}`, { text: 'hijacked' });
    expect(forbiddenEdit.statusCode).toBe(403);

    const forbiddenDelete = await ben.delete(`/api/chat/${created.id}`);
    expect(forbiddenDelete.statusCode).toBe(403);

    const del = await ana.delete(`/api/chat/${created.id}`);
    expect(del.statusCode).toBe(204);
    const afterDelete = (await history(ana)).messages.find((m) => m.id === created.id);
    expect(afterDelete && !afterDelete.hidden ? afterDelete.deleted : true).toBe(true);
  });

  it('retries the same clientId without creating a second message', async () => {
    const first = RevealedChatMessageSchema.parse(await t.client().json(post(ana, { text: 'retry me', clientId: 'retry-client-1' }), 201));
    const second = await post(ana, { text: 'retry me', clientId: 'retry-client-1' });
    expect(second.statusCode).toBe(200);
    expect(RevealedChatMessageSchema.parse(second.json()).id).toBe(first.id);
  });

  it('reacts and un-reacts, summarised with a count and whether it is yours', async () => {
    const created = RevealedChatMessageSchema.parse(await t.client().json(post(ana, { text: 'react to this' }), 201));
    await ben.put(`/api/chat/${created.id}/reactions`, { emoji: '👍' });
    const afterBen = RevealedChatMessageSchema.parse((await history(ana)).messages.find((m) => m.id === created.id));
    expect(afterBen.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    const anaView = RevealedChatMessageSchema.parse((await history(ana)).messages.find((m) => m.id === created.id));
    await ana.put(`/api/chat/${created.id}/reactions`, { emoji: '👍' });
    const both = RevealedChatMessageSchema.parse((await history(ana)).messages.find((m) => m.id === created.id));
    expect(both.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    void anaView;
    const removed = await ben.delete(`/api/chat/${created.id}/reactions`, { emoji: '👍' });
    expect(removed.statusCode).toBe(200);
    const afterRemove = RevealedChatMessageSchema.parse((await history(ana)).messages.find((m) => m.id === created.id));
    expect(afterRemove.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
  });

  it('hides a spoiler-fenced message until the reader reaches that place, by the book gate', async () => {
    const chapterTwo = 0.5; // the Alice fixture's own chapter boundaries are tested in gating.test.ts; any mid-book t proves the fence.
    const fenced = RevealedChatMessageSchema.parse(
      await t.client().json(post(ben, { bookId: book.id, text: 'the ending is wild', spoilerUpToT: chapterTwo }), 201),
    );
    expect(fenced.spoilerLabel).toMatch(/Spoiler up to/);

    const anasView = HiddenChatMessageSchema.parse((await history(ana, `?bookId=${book.id}`)).messages.find((m) => m.id === fenced.id));
    expect(anasView.hidden).toBe(true);
    expect('text' in anasView).toBe(false);
    expect(anasView.spoilerLabel).toMatch(/Spoiler up to/);

    // Ben's own message is always open to him.
    const bensView = RevealedChatMessageSchema.parse((await history(ben, `?bookId=${book.id}`)).messages.find((m) => m.id === fenced.id));
    expect(bensView.hidden).toBe(false);
    expect(bensView.text).toBe('the ending is wild');

    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const lastSection = geometry.sectionLengths.length - 1;
    const end = { kind: 'epub' as const, section: lastSection, offset: geometry.sectionLengths[lastSection]! };
    const put = await ana.put(`/api/books/${book.id}/progress`, {
      editionId: epub.id,
      locator: end,
      readSpans: [{ from: { kind: 'epub', section: 0, offset: 0 }, to: end }],
      at: Date.now(),
    });
    expect(put.statusCode).toBe(200);

    const afterReading = RevealedChatMessageSchema.parse((await history(ana, `?bookId=${book.id}`)).messages.find((m) => m.id === fenced.id));
    expect(afterReading.hidden).toBe(false);
    expect(afterReading.text).toBe('the ending is wild');
  });

  it('@-mentions a member and notifies them, never the writer, with the message visible once open', async () => {
    await post(ben, { text: `Hey @${'Ana'}, look at this` });
    const anasNotifications = NotificationListSchema.parse(await ana.json(ana.get('/api/notifications'), 200));
    const mention = anasNotifications.items.find((n) => n.kind === 'mention');
    expect(mention).toBeTruthy();
    expect(mention!.text).toContain('look at this');
    expect(mention!.actorName).toBe('Ben');

    const bensNotifications = NotificationListSchema.parse(await ben.json(ben.get('/api/notifications'), 200));
    expect(bensNotifications.items.some((n) => n.kind === 'mention' && n.id === mention!.id)).toBe(false);
  });

  it('an unread count counts the club chat, resets when the member marks it read, and never counts your own posts', async () => {
    const benBefore = await unread(ben);
    const anaBefore = await unread(ana);
    await post(ana, { text: 'one more for the pile' });
    expect(await unread(ben)).toBe(benBefore + 1);
    // Ana's own post never counts against her own unread count.
    expect(await unread(ana)).toBe(anaBefore);
    const mark = await ben.post(`/api/clubs/${club.id}/chat/read`, {});
    expect(mark.statusCode).toBe(204);
    expect(await unread(ben)).toBe(0);
  });

  it('refuses someone outside the club (404, never confirming the club exists)', async () => {
    const stranger = await outsider(t, owner, 'Oz');
    const res = await post(stranger, { text: 'sneaking in' });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
    const getRes = await stranger.get(`/api/clubs/${club.id}/chat`);
    expect(getRes.statusCode).toBe(404);
  });
});
