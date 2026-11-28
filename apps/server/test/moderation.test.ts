import type { BookSummary, ChatHistory, ChatMessageView, CommentView, ContentReports, NotificationList, SessionInfo } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { ALICE_EPUB, bookDetail, fileFrom, joinClub, makeTestApp, openSocket, outsider, readEpubTo, setupOwner, uploadBook } from './helpers';

describe('member safety', () => {
  it('accepts reports only for visible content and exposes the reports only to the club owner', async () => {
    const t = await makeTestApp();
    try {
      const { owner, club } = await setupOwner(t);
      const ana = await joinClub(t, club, 'Ana');
      const ben = await joinClub(t, club, 'Ben');
      const foreign = await outsider(t, owner, 'Eve');
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await t.settle();
      const book = await bookDetail(owner, bookId);
      await readEpubTo(ana, book, 0.2);
      await readEpubTo(owner, book, 0.2);
      const editionId = book.editions[0]!.id;
      const chatPath = `/api/clubs/${club.id}/chat`;
      const reportsPath = `/api/clubs/${club.id}/reports`;
      const chat = await ben.json<ChatMessageView>(ben.post(chatPath, { text: 'Visible chat words' }), 201);
      const fenced = await ben.json<ChatMessageView>(ben.post(chatPath, { text: 'Fenced chat words', bookId, spoilerUpToT: 0.9 }), 201);
      const notes = `/api/books/${bookId}/comments`;
      const note = await ben.json<CommentView>(ben.post(notes, { editionId, locator: { kind: 'epub', section: 0, offset: 0 }, text: 'Visible note words' }), 201);
      const reaction = await ben.json<CommentView>(ben.post(notes, { editionId, locator: { kind: 'epub', section: 0, offset: 0 }, reaction: '❤️' }), 201);
      const reply = await ben.json<CommentView>(ben.post(`/api/comments/${note.id}/replies`, { text: 'A visible reply', aboutHere: true }), 201);
      const body = { kind: 'chat', targetId: chat.id, reason: 'harassment', details: 'Please review.' };

      const socket = await openSocket(t, owner);
      try {
        expect((await ana.post(reportsPath, body)).statusCode).toBe(204);
        const { notification } = await socket.next('notification:new', (event) => event.notification.kind === 'report');
        expect(notification).toMatchObject({ kind: 'report', clubId: club.id, text: null, actorName: 'Book Club' });
        expect(JSON.stringify(notification)).not.toMatch(/Ana|Ben|Please review/);
      } finally {
        await socket.close();
      }
      expect((await ana.post(reportsPath, body)).statusCode).toBe(204);
      for (const [kind, targetId] of [['comment', note.id], ['reaction', reaction.id]]) {
        expect((await ana.post(reportsPath, { kind, targetId, reason: 'spam' })).statusCode).toBe(204);
      }
      expect((await ana.post(reportsPath, { ...body, kind: 'comment', targetId: reply.id })).statusCode).toBe(204);
      expect((await ben.post(reportsPath, body)).statusCode).toBe(404);
      expect((await foreign.post(reportsPath, body)).statusCode).toBe(404);
      expect((await ana.post(reportsPath, { ...body, targetId: fenced.id })).statusCode).toBe(404);
      expect((await ana.post(reportsPath, { ...body, kind: 'reaction', targetId: note.id })).statusCode).toBe(404);
      expect((await ana.get(reportsPath)).statusCode).toBe(403);
      expect((await foreign.get(reportsPath)).statusCode).toBe(404);
      const ownerMessage = await owner.json<ChatMessageView>(owner.post(chatPath, { text: 'Owner message' }), 201);
      expect((await ana.post(reportsPath, { kind: 'chat', targetId: ownerMessage.id, reason: 'other' })).statusCode).toBe(204);
      await readEpubTo(ana, book, 0.95);
      expect((await ana.post(reportsPath, { ...body, targetId: fenced.id })).statusCode).toBe(204);
      const list = await owner.json<ContentReports>(owner.get(reportsPath), 200);
      expect(list.reports).toHaveLength(6);
      expect(list.reports).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'chat', targetId: chat.id, authorName: 'Ben', reporterName: 'Ana', details: 'Please review.' }),
        expect.objectContaining({ kind: 'comment', targetId: note.id, reason: 'spam' }),
        expect.objectContaining({ kind: 'reaction', targetId: reaction.id, reason: 'spam' }),
        expect.objectContaining({ kind: 'comment', targetId: reply.id, parentId: note.id }),
        expect.objectContaining({ targetId: ownerMessage.id, reporterName: null }),
      ]));
      expect(JSON.stringify(list)).not.toMatch(/chat words|note words/);
      const notifications = await owner.json<NotificationList>(owner.get('/api/notifications'), 200);
      expect(notifications.items.filter(({ kind }) => kind === 'report')).toHaveLength(6);
      const memberNotifications = await ana.json<NotificationList>(ana.get('/api/notifications'), 200);
      expect(memberNotifications.items.some(({ kind }) => kind === 'report')).toBe(false);

      const target = (id: string) => `${reportsPath}/${list.reports.find((report) => report.targetId === id)!.id}/target`;
      const { user } = await ben.json<SessionInfo>(ben.get('/api/session'), 200);
      expect((await owner.put(`/api/clubs/${club.id}/blocks/${user!.id}`, {})).statusCode).toBe(200);
      expect((await owner.get(`/api/chat/${chat.id}/thread`)).statusCode).toBe(404);
      expect((await ana.get(target(chat.id))).statusCode).toBe(403);
      expect((await foreign.get(target(chat.id))).statusCode).toBe(404);
      expect(await owner.json(owner.get(target(chat.id)), 200)).toMatchObject({ text: 'Visible chat words' });
      expect(await owner.json(owner.get(target(note.id)), 200)).toMatchObject({ text: 'Visible note words' });
      expect(await owner.json(owner.get(target(reaction.id)), 200)).toMatchObject({ reaction: '❤️', text: null });
      expect((await owner.get(target(fenced.id))).statusCode).toBe(404);
      await readEpubTo(owner, book, 0.95);
      expect(await owner.json(owner.get(target(fenced.id)), 200)).toMatchObject({ text: 'Fenced chat words' });
    } finally {
      await t.close();
    }
  });

  it('hides blocked authors in channel history, quoted replies and counts only for the blocker, then restores them on unblock', async () => {
    const t = await makeTestApp();
    try {
      const { owner, club } = await setupOwner(t);
      const ana = await joinClub(t, club, 'Ana');
      const ben = await joinClub(t, club, 'Ben');
      const { user } = await ben.json<SessionInfo>(ben.get('/api/session'), 200);
      const chatPath = `/api/clubs/${club.id}/chat`;
      const mine = await ana.json<ChatMessageView>(ana.post(chatPath, { text: 'Ana root' }), 201);
      const root = await ben.json<ChatMessageView>(ben.post(chatPath, { text: 'Ben root' }), 201);
      const reply = await ben.json<ChatMessageView>(ben.post(chatPath, { text: 'Ben reply', parentId: mine.id }), 201);
      const quote = await owner.json<ChatMessageView>(owner.post(chatPath, { text: 'Owner reply', parentId: reply.id }), 201);
      expect((await ben.put(`/api/chat/${mine.id}/reactions`, { emoji: '👍' })).statusCode).toBe(200);
      const before = await ana.json<ChatHistory>(ana.get(chatPath), 200);
      expect(before.messages.map((m) => m.id)).toEqual(expect.arrayContaining([root.id, reply.id, quote.id]));

      expect((await ana.put(`/api/clubs/${club.id}/blocks/${user!.id}`, {})).statusCode).toBe(200);
      const hidden = await ana.json<ChatHistory>(ana.get(chatPath), 200);
      expect(hidden.messages.map((m) => m.id).sort()).toEqual([mine.id, quote.id].sort());
      expect(hidden.messages.find((m) => m.id === mine.id)?.reactions).toEqual([]);
      expect(hidden.messages.find((m) => m.id === mine.id)?.replyCount).toBe(1);
      expect(hidden.messages.find((m) => m.id === quote.id)?.replyTo).toBeNull();
      expect((await ana.get(`/api/chat/${root.id}/thread`)).statusCode).toBe(404);
      expect((await ana.put(`/api/chat/${root.id}/reactions`, { emoji: '👍' })).statusCode).toBe(404);
      const ownerHistory = await owner.json<ChatHistory>(owner.get(chatPath), 200);
      expect(ownerHistory.messages.find((m) => m.id === root.id)).toBeDefined();

      const socket = await openSocket(t, ana);
      try {
        expect((await socket.next('hello')).blockedUserIds).toEqual([user!.id]);
        socket.send({ type: 'subscribe', clubId: club.id });
        await socket.next('presence');
        const rejected = await ben.json<ChatMessageView>(ben.post(chatPath, { text: '@ana should not get this' }), 201);
        const accepted = await owner.json<ChatMessageView>(owner.post(chatPath, { text: 'A new visible message' }), 201);
        await socket.next('chat:new', (event) => event.message.id === accepted.id);
        expect(socket.messages.some((event) => event.type === 'chat:new' && event.message.id === rejected.id)).toBe(false);
        expect(socket.messages.some((event) => event.type === 'notification:new')).toBe(false);
        const notifications = await ana.json<{ items: unknown[] }>(ana.get('/api/notifications'), 200);
        expect(notifications.items).toEqual([]);
      } finally {
        await socket.close();
      }

      expect((await ana.delete(`/api/settings/blocks/${user!.id}`)).statusCode).toBe(200);
      const restored = await ana.json<ChatHistory>(ana.get(chatPath), 200);
      expect(restored.messages.find((m) => m.id === root.id)).toBeDefined();
    } finally {
      await t.close();
    }
  });

  it('leaves blocked passage reactions out of both note history and progress reveals', async () => {
    const t = await makeTestApp();
    try {
      const { owner, club } = await setupOwner(t);
      const ana = await joinClub(t, club, 'Ana');
      const ben = await joinClub(t, club, 'Ben');
      const { user } = await ben.json<SessionInfo>(ben.get('/api/session'), 200);
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await t.settle();
      const book = await bookDetail(owner, bookId);
      const editionId = book.editions[0]!.id;
      const locator = (offset: number) => ({ kind: 'epub', section: 0, offset });
      const commentsPath = `/api/books/${bookId}/comments`;
      const reaction = await ben.json<CommentView>(ben.post(commentsPath, { editionId, locator: locator(1), reaction: '❤️' }), 201);
      const visible = await owner.json<CommentView>(owner.post(commentsPath, { editionId, locator: locator(2), reaction: '😂' }), 201);
      const libraryCount = async () => {
        const books = await ana.json<BookSummary[]>(ana.get(`/api/clubs/${club.id}/books`), 200);
        return books.find(({ id }) => id === bookId)?.commentCount;
      };
      expect((await bookDetail(ana, bookId)).commentCount).toBe(2);
      expect(await libraryCount()).toBe(2);
      expect(await ana.json<CommentView[]>(ana.get(commentsPath), 200)).toEqual(expect.arrayContaining([expect.objectContaining({ id: reaction.id, hidden: true })]));
      expect((await ana.put(`/api/clubs/${club.id}/blocks/${user!.id}`, {})).statusCode).toBe(200);
      const progress = await ana.json<{ revealed: CommentView[] }>(ana.put(`/api/books/${bookId}/progress`, {
        editionId, locator: locator(5), readSpans: [{ from: locator(0), to: locator(5) }], at: Date.now(),
      }), 200);
      expect(progress.revealed.map((comment) => comment.id)).toEqual([visible.id]);
      expect((await ana.json<CommentView[]>(ana.get(commentsPath), 200)).map((comment) => comment.id)).toEqual([visible.id]);
      expect((await bookDetail(ana, bookId)).commentCount).toBe(1);
      expect(await libraryCount()).toBe(1);
      expect((await owner.json<CommentView[]>(owner.get(commentsPath), 200)).map((comment) => comment.id)).toContain(reaction.id);
    } finally {
      await t.close();
    }
  });
});
