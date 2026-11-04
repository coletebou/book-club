import {
  type BookDetail,
  type ClubDetail,
  type CommentView,
  CommentViewSchema,
  type Edition,
  HiddenCommentSchema,
  type Locator,
  NotificationListSchema,
  type ProgressUpdateResult,
  type Publication,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HORIZON_PAGE } from '../src/services/gating';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, openSocket, outsider, setupOwner, uploadBook } from './helpers';

const epubAt = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });

describe('replies and notifications', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let cleo: Client;
  let book: BookDetail;
  let epub: Edition;
  const ids: Record<string, string> = {};

  const read = (c: Client, from: Locator, to: Locator) =>
    c.json(c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);
  const list = async (c: Client) => (await c.json<unknown[]>(c.get(`/api/books/${book.id}/comments`), 200)).map((v) => CommentViewSchema.parse(v));
  const replyTo = (c: Client, commentId: string, body: Record<string, unknown>) => c.post(`/api/comments/${commentId}/replies`, body);
  const notifications = async (c: Client) => NotificationListSchema.parse(await c.json(c.get('/api/notifications'), 200));

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    cleo = await joinClub(t, club, 'Cleo');
    for (const [name, c] of Object.entries({ ana, ben, cleo })) ids[name] = (await c.json<{ user: { id: string } }>(c.get('/api/me'), 200)).user.id;
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions[0]!;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  let note: CommentView;

  it('a friend who has read the passage answers a note; the reply sits at the note’s place', async () => {
    // Ana writes where she is reading (the app records her reading there first).
    await read(ana, epubAt(5, 0), epubAt(5, 400));
    note = await ana.json<CommentView>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(5, 100), text: 'The Rabbit sends in a little Bill!' }), 201);
    await read(ben, epubAt(5, 0), epubAt(5, 400));
    const reply = CommentViewSchema.parse(await ben.json(replyTo(ben, note.id, { text: 'Poor Bill', clientId: 'reply-ben-1' }), 201));
    expect(reply).toMatchObject({ parentId: note.id, hidden: false, text: 'Poor Bill', t: note.t, locator: note.locator });
    // A retry with the same client id is the same reply.
    expect((await ben.json<CommentView>(replyTo(ben, note.id, { text: 'Poor Bill', clientId: 'reply-ben-1' }), 200)).id).toBe(reply.id);
    const all = await list(ana);
    expect(all.filter((c) => c.parentId === note.id)).toHaveLength(1);
    // The note's author, who has read the passage, reads the answers to it.
    expect(all.find((c) => c.parentId === note.id)).toMatchObject({ hidden: false, text: 'Poor Bill' });
    // Replies follow their note in the list; the book counts notes, not replies.
    expect(all.findIndex((c) => c.id === note.id)).toBeLessThan(all.findIndex((c) => c.parentId === note.id));
    const summary = await owner.json<{ commentCount: number }[]>(owner.get(`/api/clubs/${club.id}/books`), 200);
    expect(summary[0]!.commentCount).toBe(1);
  });

  it('nobody answers a note they cannot read yet; answering a reply answers its note', async () => {
    const res = await replyTo(cleo, note.id, { text: 'What happens here?' });
    expect(res.statusCode).toBe(403);
    await read(cleo, epubAt(5, 0), epubAt(5, 400));
    const benReply = (await list(ben)).find((c) => c.parentId === note.id)!;
    const nested = CommentViewSchema.parse(await cleo.json(replyTo(cleo, benReply.id, { text: 'Me too', reaction: '😢' }), 201));
    expect(nested.parentId).toBe(note.id);
    expect((await replyTo(cleo, note.id, { text: '   ' })).statusCode).toBe(400);
    const stranger = await outsider(t, owner, 'Stu');
    expect((await replyTo(stranger, note.id, { text: 'hi' })).statusCode).toBe(404);
    expect((await replyTo(t.client(), note.id, { text: 'hi' })).statusCode).toBe(401);
  });

  it('a reply is read when its note is: a member who has not got there sees only markers', async () => {
    const dora = await joinClub(t, club, 'Dora');
    const res = await dora.get(`/api/books/${book.id}/comments`);
    expect(res.body).not.toContain('Poor Bill');
    expect(res.body).not.toContain('Me too');
    const views = (res.json<unknown[]>()).map((v) => CommentViewSchema.parse(v));
    const replies = views.filter((c) => c.parentId === note.id);
    expect(replies).toHaveLength(2);
    expect(replies.every((c) => c.hidden)).toBe(true);
  });

  it('tells the note’s author and the others in the conversation, live, but never the one who wrote', async () => {
    const anaSocket = await openSocket(t, ana);
    const benSocket = await openSocket(t, ben);
    try {
      await read(owner, epubAt(5, 0), epubAt(5, 400));
      await owner.json(replyTo(owner, note.id, { text: 'Lovely chapter' }), 201);
      const toAna = await anaSocket.next('notification:new', (m) => m.notification.kind === 'reply' && m.notification.text === 'Lovely chapter');
      expect(toAna.notification).toMatchObject({ bookId: book.id, noteId: note.id, actorName: 'Cole', bookTitle: 'Alice' });
      expect(toAna.notification.where).toContain('Chapter 4');
      await benSocket.next('notification:new', (m) => m.notification.text === 'Lovely chapter');
      const mine = await notifications(owner);
      expect(mine.items.some((n) => n.kind === 'reply' && n.text === 'Lovely chapter')).toBe(false);
    } finally {
      await anaSocket.close();
      await benSocket.close();
    }
    const anas = await notifications(ana);
    // Ben's, Cleo's and Cole's replies.
    expect(anas.items.filter((n) => n.kind === 'reply').map((n) => n.actorName).sort()).toEqual(['Ben', 'Cleo', 'Cole']);
  });

  it('tells a note’s author when a friend gets to it, once per friend', async () => {
    const before = (await notifications(ana)).items.filter((n) => n.kind === 'reached');
    // Ben, Cleo and Cole have read the passage already (above): each was a "reached".
    expect(before.map((n) => n.actorName).sort()).toEqual(['Ben', 'Cleo', 'Cole']);
    for (const n of before) expect(n.text).toBeNull();
    // Reading it again tells nobody anything.
    await read(ben, epubAt(5, 0), epubAt(5, 400));
    expect((await notifications(ana)).items.filter((n) => n.kind === 'reached')).toHaveLength(3);
    // Nobody hears about their own note.
    await read(ana, epubAt(5, 0), epubAt(5, 400));
    expect((await notifications(ana)).items.filter((n) => n.kind === 'reached' && n.actorName === 'Ana')).toHaveLength(0);
  });

  it('a note placed ahead of its author’s reading (through the API) collects no answers’ words for them', async () => {
    const dora = await joinClub(t, club, 'Dora2');
    const planted = await dora.json<CommentView>(dora.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(8, 40), text: 'What happens here?' }), 201);
    await read(ben, epubAt(8, 0), epubAt(8, 400));
    await ben.json(replyTo(ben, planted.id, { text: 'The Queen is furious' }), 201);
    // Dora has not read there: the answer is a marker for her, in the book and in her notifications.
    const res = await dora.get(`/api/books/${book.id}/comments`);
    expect(res.body).not.toContain('furious');
    expect((res.json<unknown[]>()).map((v) => CommentViewSchema.parse(v)).find((c) => c.parentId === planted.id)).toMatchObject({ hidden: true });
    const told = (await notifications(dora)).items.find((n) => n.kind === 'reply' && n.noteId === planted.id)!;
    expect(told).toMatchObject({ actorName: 'Ben', text: null });
    // Once she reads the passage, it opens, there and in her notifications.
    await read(dora, epubAt(8, 0), epubAt(8, 400));
    expect((await list(dora)).find((c) => c.parentId === planted.id)).toMatchObject({ hidden: false, text: 'The Queen is furious' });
    expect((await notifications(dora)).items.find((n) => n.kind === 'reply' && n.noteId === planted.id)!.text).toBe('The Queen is furious');
  });

  it('marks notifications read, some or all, and only your own', async () => {
    const first = await notifications(ana);
    expect(first.unread).toBe(first.items.length);
    expect((await ana.post('/api/notifications/read', { ids: [first.items[0]!.id] })).statusCode).toBe(204);
    expect((await notifications(ana)).unread).toBe(first.items.length - 1);
    // Ben cannot mark Ana's.
    await ben.post('/api/notifications/read', { ids: [first.items[1]!.id] });
    expect((await notifications(ana)).unread).toBe(first.items.length - 1);
    expect((await ana.post('/api/notifications/read', {})).statusCode).toBe(204);
    expect((await notifications(ana)).unread).toBe(0);
    expect((await t.client().get('/api/notifications')).statusCode).toBe(401);
  });

  it('a deleted note with replies stays for them without its words; with its last reply gone it goes', async () => {
    expect((await ana.delete(`/api/comments/${note.id}`)).statusCode).toBe(204);
    const kept = (await list(ben)).find((c) => c.id === note.id)!;
    expect(kept).toMatchObject({ deleted: true, hidden: false, text: null, quote: null, reaction: null });
    expect((await list(ben)).filter((c) => c.parentId === note.id)).toHaveLength(3);
    // No one can answer it now.
    expect((await replyTo(ben, note.id, { text: 'Still here?' })).statusCode).toBe(404);
    for (const c of await list(owner)) if (c.parentId === note.id) await owner.delete(`/api/comments/${c.id}`);
    expect((await list(ben)).some((c) => c.id === note.id)).toBe(false);
    // Its notifications go with it.
    expect((await notifications(ana)).items.filter((n) => n.noteId === note.id)).toEqual([]);
  });

  it('notifications from a club you left are not shown', async () => {
    const other = await ana.json<CommentView>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(6, 50), text: 'Advice from a Caterpillar' }), 201);
    await read(cleo, epubAt(6, 0), epubAt(6, 300));
    expect((await notifications(ana)).items.some((n) => n.commentId === other.id)).toBe(true);
    expect((await ana.delete(`/api/clubs/${club.id}/members/${ids.ana}`)).statusCode).toBe(204);
    expect((await notifications(ana)).items).toEqual([]);
  });
});

describe('answers and notes from further on (D69)', () => {
  let t: TestApp;
  let club: ClubDetail;
  let ana: Client;
  let cleo: Client;
  let cole: Client;
  let book: BookDetail;
  let epub: Edition;
  let lengths: number[];
  let ch1: number;
  let ch2: number;
  let ch9: number;
  let readers = 0;
  const MOCK_TURTLE = 'In chapter 9 the Mock Turtle tells his story';
  const HELD_KEYS = ['authorName', 'bookId', 'color', 'createdAt', 'editionId', 'hasText', 'hidden', 'horizon', 'id', 'kind', 'locator', 'media', 'parentId', 'reaction', 't', 'userId'];

  const read = async (c: Client, from: Locator, to: Locator) =>
    c.json<ProgressUpdateResult>(c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);
  const write = async (c: Client, body: Record<string, unknown>) => CommentViewSchema.parse(await c.json(c.post(`/api/books/${book.id}/comments`, { editionId: epub.id, ...body }), 201));
  const replyTo = (c: Client, commentId: string, text: string) => c.post(`/api/comments/${commentId}/replies`, { text });
  const list = async (c: Client) => (await c.json<unknown[]>(c.get(`/api/books/${book.id}/comments`), 200)).map((v) => CommentViewSchema.parse(v));
  const viewOf = async (c: Client, id: string) => (await list(c)).find((v) => v.id === id)!;
  const notifications = async (c: Client) => NotificationListSchema.parse(await c.json(c.get('/api/notifications'), 200));
  /** The end of a section, and a place `back` characters before it. */
  const endOf = (section: number, back = 0): Locator => epubAt(section, lengths[section]! - back);
  /** A new member who has read the book from chapter I's start to `to`. */
  const readerUpTo = async (to: Locator) => {
    const c = await joinClub(t, club, `Reader ${++readers}`);
    await read(c, epubAt(ch1, 0), to);
    return c;
  };

  beforeAll(async () => {
    t = await makeTestApp();
    let owner: Client;
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    cleo = await joinClub(t, club, 'Cleo');
    cole = await joinClub(t, club, 'Cole2');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions[0]!;
    lengths = epub.geometry!.kind === 'epub' ? epub.geometry!.sectionLengths : [];
    const pub = await owner.json<Publication>(owner.get(epub.publicationUrl!), 200);
    const section = (n: string) => pub.toc.find((e) => e.title.startsWith(`CHAPTER ${n}.`))!.section;
    [ch1, ch2, ch9] = [section('I'), section('II'), section('IX')];
  });

  afterAll(async () => {
    await closeApp(t);
  });

  let note: CommentView;
  let answer: CommentView;

  it('a friend far ahead answers an early note: whoever has read only that far gets a marker that says where she wrote from, live too', async () => {
    // Ana writes in chapter I, where she is reading; Cole has read on into chapter II.
    await read(ana, epubAt(ch1, 0), epubAt(ch1, 900));
    note = await write(ana, { locator: epubAt(ch1, 200), text: 'Down, down, down' });
    await read(cole, epubAt(ch1, 0), epubAt(ch2, 500));
    // Cleo has read to the end of chapter IX, and answers it from there.
    await read(cleo, epubAt(ch1, 0), endOf(ch9));
    const anaSocket = await openSocket(t, ana);
    const coleSocket = await openSocket(t, cole);
    try {
      coleSocket.send({ type: 'subscribe', clubId: club.id });
      await coleSocket.next('presence');
      answer = CommentViewSchema.parse(await cleo.json(replyTo(cleo, note.id, MOCK_TURTLE), 201));
      // Her own words, at the note's place.
      expect(answer).toMatchObject({ hidden: false, text: MOCK_TURTLE, parentId: note.id, t: note.t });
      // Pushed to Cole without its words, and Ana is told without them.
      const pushed = await coleSocket.next('comment:new', (m) => m.comment.id === answer.id);
      expect(pushed.comment).toMatchObject({ hidden: true, hasText: true, horizon: 'Chapter 9', parentId: note.id });
      expect(JSON.stringify(pushed)).not.toContain('Mock Turtle');
      const told = await anaSocket.next('notification:new', (m) => m.notification.kind === 'reply' && m.notification.commentId === answer.id);
      expect(told.notification).toMatchObject({ actorName: 'Cleo', text: null, horizon: 'Chapter 9' });
      expect(told.notification.where).toContain('Chapter 1');
      expect(JSON.stringify(told)).not.toContain('Mock Turtle');
    } finally {
      await anaSocket.close();
      await coleSocket.close();
    }
    // In the book: Ana's note in full, Cleo's answer a marker that says where she had read to.
    const res = await cole.get(`/api/books/${book.id}/comments`);
    expect(res.body).not.toContain('Mock Turtle');
    const views = res.json<Record<string, unknown>[]>();
    expect(CommentViewSchema.parse(views.find((v) => v.id === note.id))).toMatchObject({ hidden: false, text: 'Down, down, down' });
    const held = views.find((v) => v.id === answer.id)!;
    expect(Object.keys(held).sort()).toEqual(HELD_KEYS);
    expect(HiddenCommentSchema.parse(held)).toMatchObject({ hidden: true, hasText: true, horizon: 'Chapter 9', authorName: 'Cleo' });
    // The note's author reads the answers to it by her reading, like anyone: there is no exception.
    expect(await viewOf(ana, answer.id)).toMatchObject({ hidden: true, horizon: 'Chapter 9' });
    expect((await notifications(ana)).items.find((n) => n.commentId === answer.id)).toMatchObject({ kind: 'reply', text: null, horizon: 'Chapter 9' });
    // Someone who has not read the note's place gets the plain marker: it is ahead of them.
    const dora = await joinClub(t, club, 'Dora');
    const ahead = await viewOf(dora, answer.id);
    expect(ahead).toMatchObject({ hidden: true });
    expect(ahead).not.toHaveProperty('horizon');
    // Its writer reads it, and is told where friends must have read to first.
    expect(await viewOf(cleo, answer.id)).toMatchObject({ hidden: false, text: MOCK_TURTLE, horizon: 'Chapter 9' });
  });

  it('opens with its words when your reading gets where hers had, less the page she had on screen', async () => {
    // Just short of it: still a marker.
    expect((await read(cole, epubAt(ch2, 500), endOf(ch9, HORIZON_PAGE.epub + 100))).revealed.some((c) => c.id === answer.id)).toBe(false);
    expect(await viewOf(cole, answer.id)).toMatchObject({ hidden: true, horizon: 'Chapter 9' });
    // There: the progress update brings it, words and all, and the book has it from now on.
    const outcome = await read(cole, endOf(ch9, HORIZON_PAGE.epub + 100), endOf(ch9, HORIZON_PAGE.epub - 100));
    expect(outcome.revealed.find((c) => c.id === answer.id)).toMatchObject({ hidden: false, text: MOCK_TURTLE });
    expect(await viewOf(cole, answer.id)).toMatchObject({ hidden: false, text: MOCK_TURTLE });
    // Ana's notification has the words once she has read that far too.
    await read(ana, epubAt(ch1, 900), endOf(ch9));
    expect((await notifications(ana)).items.find((n) => n.commentId === answer.id)).toMatchObject({ text: MOCK_TURTLE, horizon: null });
  });

  it('an answer written where its writer is reading is read when its note is, as before', async () => {
    const ben = await readerUpTo(epubAt(ch1, 900));
    const nearby = CommentViewSchema.parse(await ben.json(replyTo(ben, note.id, 'The marmalade jar!'), 201));
    // Someone who has read only the page with the note reads it.
    const phone = await joinClub(t, club, 'Phone reader');
    await read(phone, epubAt(ch1, 0), epubAt(ch1, 300));
    expect(await viewOf(phone, nearby.id)).toMatchObject({ hidden: false, text: 'The marmalade jar!' });
    // Cleo's, from chapter IX, still waits for them.
    expect(await viewOf(phone, answer.id)).toMatchObject({ hidden: true, horizon: 'Chapter 9' });
  });

  it('an answer its writer, far ahead, says is only about the passage opens with its note', async () => {
    const plain = CommentViewSchema.parse(await cleo.json(cleo.post(`/api/comments/${note.id}/replies`, { text: 'The Dodo is Carroll himself', aboutHere: true }), 201));
    expect(plain).not.toHaveProperty('horizon');
    const phone = await joinClub(t, club, 'Phone reader 2');
    await read(phone, epubAt(ch1, 0), epubAt(ch1, 300));
    expect(await viewOf(phone, plain.id)).toMatchObject({ hidden: false, text: 'The Dodo is Carroll himself' });
    // Without it, her answers from chapter IX still wait.
    expect(await viewOf(phone, answer.id)).toMatchObject({ hidden: true, horizon: 'Chapter 9' });
  });

  it('a note held by where its writer had read to cannot be answered yet; once it opens, it can', async () => {
    const lookBack = await write(cleo, { locator: epubAt(ch1, 5000), text: 'The Queen will remember this' });
    const eve = await readerUpTo(epubAt(ch2, 0));
    expect(await viewOf(eve, lookBack.id)).toMatchObject({ hidden: true, horizon: 'Chapter 9' });
    expect((await replyTo(eve, lookBack.id, 'What does she mean?')).statusCode).toBe(403);
    await read(eve, epubAt(ch2, 0), endOf(ch9));
    expect((await replyTo(eve, lookBack.id, 'Now I see')).statusCode).toBe(201);
  });

  it('a deleted note keeps its place for its answers, held by nothing: they wait for their own writers', async () => {
    const lookBack = await write(cleo, { locator: epubAt(ch1, 6000), text: 'Remember the tarts' });
    const far = await readerUpTo(endOf(ch9 + 1));
    const theirs = CommentViewSchema.parse(await far.json(replyTo(far, lookBack.id, 'The Knave of Hearts!'), 201));
    expect((await cleo.delete(`/api/comments/${lookBack.id}`)).statusCode).toBe(204);
    const near = await readerUpTo(epubAt(ch2, 0));
    expect(await viewOf(near, lookBack.id)).toMatchObject({ deleted: true, hidden: false, text: null });
    expect(await viewOf(near, theirs.id)).toMatchObject({ hidden: true, horizon: 'Chapter 10' });
  });
});
