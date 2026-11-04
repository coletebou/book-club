import { type BookDetail, type ClubDetail, type CommentView, type Edition, type Locator, NotificationListSchema } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, openSocket, setupOwner, uploadBook } from './helpers';

const epubAt = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });

/**
 * D145: catching up a whole chapter's worth of a friend's notes in one sweep makes one "reached"
 * notification, not one per note, and does not toast (push) once per note either.
 */
describe('reached notifications batch per friend per chapter (D145)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let book: BookDetail;
  let epub: Edition;

  const read = (c: Client, from: Locator, to: Locator) =>
    c.json(c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);
  const notifications = async (c: Client) => NotificationListSchema.parse(await c.json(c.get('/api/notifications'), 200));

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions[0]!;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('one sweep opening three of a friend’s notes in one chapter makes one notification, pushed once', async () => {
    // Three notes, all in the same chapter (section 4), all ahead of Ben.
    const notes: CommentView[] = [];
    for (const offset of [10, 200, 500]) {
      notes.push(await ana.json<CommentView>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(4, offset), text: `Note at ${offset}` }), 201));
    }
    // Ana hears her own friend's reach over the socket (she wrote the notes).
    const anaSocket = await openSocket(t, ana);
    try {
      // One progress report spanning all three notes at once (a catch-up after being offline).
      await read(ben, epubAt(4, 0), epubAt(4, 600));
      await anaSocket.next('notification:new', (m) => m.notification.kind === 'reached' && m.notification.actorName === 'Ben');
      // Nothing more arrives for this batch: give the server a moment it would use to send a
      // second push, were there one.
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      await anaSocket.close();
    }
    // One push for the batch, not three.
    const pushes = anaSocket.messages.filter((m) => m.type === 'notification:new' && m.notification.kind === 'reached' && m.notification.actorName === 'Ben');
    expect(pushes).toHaveLength(1);
    const ananotifs = (await notifications(ana)).items.filter((n) => n.kind === 'reached' && n.actorName === 'Ben');
    expect(ananotifs).toHaveLength(1);
    expect(ananotifs[0]!.count).toBe(3);
    // The batched notification points at (one of) the notes it bundles.
    expect(notes.map((n) => n.id)).toContain(ananotifs[0]!.commentId);
  });

  it('reading the bell frees the chapter for a fresh notification afterwards', async () => {
    const before = (await notifications(ana)).items.find((n) => n.kind === 'reached' && n.actorName === 'Ben')!;
    await ana.post('/api/notifications/read', { ids: [before.id] });
    // A fourth note in the same chapter, reached after the bell was read: its own, fresh row.
    const fourth = await ana.json<CommentView>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(4, 700), text: 'One more' }), 201);
    await read(ben, epubAt(4, 600), epubAt(4, 800));
    const after = (await notifications(ana)).items.filter((n) => n.kind === 'reached' && n.actorName === 'Ben');
    expect(after).toHaveLength(2);
    const fresh = after.find((n) => n.id !== before.id)!;
    expect(fresh.count).toBe(1);
    expect(fresh.commentId).toBe(fourth.id);
  });

  it('notes reached in different chapters are never batched together', async () => {
    const chapter5 = await ana.json<CommentView>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(5, 10), text: 'Next chapter' }), 201);
    await read(ben, epubAt(5, 0), epubAt(5, 100));
    const reached = (await notifications(ana)).items.filter((n) => n.kind === 'reached' && n.actorName === 'Ben' && n.commentId === chapter5.id);
    expect(reached).toHaveLength(1);
    expect(reached[0]!.count).toBe(1);
  });
});
