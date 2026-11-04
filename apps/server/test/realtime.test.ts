import { locatorToT, type BookDetail, type ClubDetail, type Edition, type Locator } from '@bookclub/shared';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ALICE_EPUB,
  type Client,
  type Socket,
  type TestApp,
  bookDetail,
  fileFrom,
  joinClub,
  makeTestApp,
  openSocket,
  outsider,
  setupOwner,
  uploadBook,
  waitUntil,
  closeApp,
} from './helpers';

const epubAt = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('realtime', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let ids: { owner: string; ana: string; ben: string };
  let book: BookDetail;
  let epub: Edition;
  const open: Socket[] = [];

  const idOf = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/me'), 200)).user.id;
  const tOf = (locator: Locator) => locatorToT({ geometry: epub.geometry!, sync: epub.sync! }, locator);
  /** A socket for `c`, subscribed to the club, with its presence snapshot received. */
  const subscribed = async (c: Client) => {
    const socket = await openSocket(t, c);
    open.push(socket);
    socket.send({ type: 'subscribe', clubId: club.id });
    await socket.next('presence');
    return socket;
  };
  /** Subscribe `c` and wait until `watcher` has heard that they came online. */
  const joined = async (watcher: Socket, c: Client, userId: string) => {
    const socket = await subscribed(c);
    await watcher.next('presence:update', (m) => m.entry.userId === userId && m.entry.online);
    return socket;
  };
  const reading = (socket: Socket, locator: Locator, editionId = epub.id) =>
    socket.send({ type: 'reading', bookId: book.id, editionId, locator, label: 'whatever the client says' });

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    ids = { owner: await idOf(owner), ana: await idOf(ana), ben: await idOf(ben) };
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions[0]!;
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    // Let the server see the closes before the next test counts who is online.
    await waitUntil(() => t.ctx.hub.size === 0, 2000, 'sockets to close');
  });

  afterAll(async () => {
    await closeApp(t);
  });

  describe('connecting', () => {
    it('closes an anonymous socket with 4001', async () => {
      const socket = await openSocket(t, null);
      expect(await socket.closed).toEqual({ code: 4001, reason: 'sign in' });
      expect(socket.messages).toEqual([]);
    });

    it('closes a socket with a stale session cookie with 4001', async () => {
      const socket = await openSocket(t, null, { cookie: 'bc_session=this-session-token-does-not-exist-anywhere' });
      expect((await socket.closed).code).toBe(4001);
    });

    it('closes a socket opened from a foreign origin with 4003, signed in or not', async () => {
      const socket = await openSocket(t, owner, { origin: 'https://evil.example' });
      expect(await socket.closed).toEqual({ code: 4003, reason: 'origin not allowed' });
      expect(socket.messages).toEqual([]);
      expect((await openSocket(t, null, { origin: 'https://evil.example' }).then((s) => s.closed)).code).toBe(4003);
    });

    it('accepts a socket without an Origin header (not a page) and says hello', async () => {
      const socket = await openSocket(t, owner, { origin: null });
      open.push(socket);
      expect((await socket.next('hello')).userId).toBe(ids.owner);
    });
  });

  describe('messages', () => {
    it('answers pings', async () => {
      const socket = await openSocket(t, ana);
      open.push(socket);
      socket.send({ type: 'ping' });
      await socket.next('pong');
    });

    it('refuses malformed messages without closing', async () => {
      const socket = await openSocket(t, ana);
      open.push(socket);
      for (const bad of ['not json', '{"type":"subscribe","clubId":"!"}', '{"type":"dance"}', '[]']) {
        socket.send(bad);
        expect((await socket.next('error')).message).toBe('Invalid message.');
      }
      socket.send({ type: 'ping' });
      await socket.next('pong');
    });

    it('refuses a subscription to a club you are not in', async () => {
      const ozzy = await outsider(t, owner, 'Ozzy');
      const socket = await openSocket(t, ozzy);
      open.push(socket);
      socket.send({ type: 'subscribe', clubId: club.id });
      expect((await socket.next('error')).message).toBe('Club not found.');
      expect(await socket.quiet('presence')).toBe(true);
    });

    it('sends a presence snapshot of every member on subscribing', async () => {
      const socket = await openSocket(t, owner);
      open.push(socket);
      socket.send({ type: 'subscribe', clubId: club.id });
      const snapshot = await socket.next('presence');
      expect(snapshot.clubId).toBe(club.id);
      const members = (await owner.json<ClubDetail>(owner.get(`/api/clubs/${club.id}`), 200)).members;
      expect(snapshot.members.map((m) => m.userId)).toEqual(members.map((m) => m.userId));
      expect(snapshot.members.find((m) => m.userId === ids.owner)).toMatchObject({ displayName: 'Cole', online: true, reading: null });
      expect(snapshot.members.find((m) => m.userId === ids.ana)).toMatchObject({ displayName: 'Ana', online: false, reading: null });
    });
  });

  describe('presence', () => {
    it('announces a member coming online', async () => {
      const watcher = await subscribed(owner);
      await subscribed(ana);
      expect((await watcher.next('presence:update', (m) => m.entry.userId === ids.ana)).entry).toMatchObject({ online: true, reading: null });
    });

    it('shares where a member is reading within a second, on the shared timeline', async () => {
      const watcher = await subscribed(owner);
      const reader = await subscribed(ana);
      const sent = Date.now();
      reading(reader, epubAt(5, 100));
      const update = await watcher.next('presence:update', (m) => m.entry.userId === ids.ana && m.entry.reading !== null, 1000);
      expect(Date.now() - sent).toBeLessThan(1000);
      expect(update.entry.reading).toMatchObject({ bookId: book.id, editionId: epub.id, kind: 'epub', label: 'Chapter 4 · 22%' });
      expect(update.entry.reading!.t).toBeCloseTo(tOf(epubAt(5, 100)), 12);
      expect(t.ctx.hub.readingStateOf(ids.ana)).toMatchObject({ bookId: book.id, t: update.entry.reading!.t });
      expect(t.ctx.hub.snapshot(club.id).find((m) => m.userId === ids.ana)!.reading).toMatchObject({ bookId: book.id });
      // The reader hears about themselves too, like every subscriber.
      await reader.next('presence:update', (m) => m.entry.userId === ids.ana && m.entry.reading !== null);
    });

    it('ignores positions in the wrong format and refuses books it cannot see', async () => {
      const watcher = await subscribed(owner);
      const reader = await subscribed(ana);
      reading(reader, { kind: 'pdf', page: 3, y: 0 });
      expect(await watcher.quiet('presence:update', (m) => m.entry.userId === ids.ana && m.entry.reading !== null)).toBe(true);
      await pause(120);
      reader.send({ type: 'reading', bookId: book.id, editionId: 'notAnEdition1', locator: epubAt(1, 0), label: '' });
      expect((await reader.next('error')).message).toBe('Book not found.');
    });

    it('going idle clears the reading state but keeps the member online', async () => {
      const watcher = await subscribed(owner);
      const reader = await joined(watcher, ana, ids.ana);
      reading(reader, epubAt(6, 0));
      await watcher.next('presence:update', (m) => m.entry.userId === ids.ana && m.entry.reading !== null);
      reader.send({ type: 'idle' });
      const update = await watcher.next('presence:update', (m) => m.entry.userId === ids.ana && m.entry.reading === null);
      expect(update.entry.online).toBe(true);
      expect(t.ctx.hub.readingStateOf(ids.ana)).toBeNull();
    });

    it('disconnecting marks the member offline once their last tab closes', async () => {
      const watcher = await subscribed(owner);
      const phone = await joined(watcher, ana, ids.ana);
      const laptop = await subscribed(ana);
      await phone.close();
      expect((await watcher.next('presence:update', (m) => m.entry.userId === ids.ana && m.entry.online)).entry.online).toBe(true);
      await laptop.close();
      const offline = await watcher.next('presence:update', (m) => m.entry.userId === ids.ana && !m.entry.online);
      expect(offline.entry).toMatchObject({ online: false, reading: null });
    });

    it('unsubscribing stops the club’s events', async () => {
      const staying = await subscribed(ana);
      const leaving = await subscribed(ben);
      leaving.send({ type: 'unsubscribe', clubId: club.id });
      await pause(50);
      await owner.json(owner.patch(`/api/clubs/${club.id}`, { description: 'Now with live updates' }), 200);
      await staying.next('club:changed');
      expect(await leaving.quiet('club:changed')).toBe(true);
    });
  });

  describe('live updates', () => {
    it('pushes a new comment to every member, gated per recipient', async () => {
      // Ana has read chapter VI; Cole has not.
      await ana.json(ana.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: epubAt(7, 0), readSpans: [{ from: epubAt(7, 0), to: epubAt(7, 2000) }], at: Date.now() }), 200);
      const cole = await subscribed(owner);
      const anas = await subscribed(ana);
      const bens = await subscribed(ben);
      const res = await ben.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(7, 100), quote: 'Who are you?', text: 'The caterpillar is so rude', reaction: '😡' });
      expect(res.statusCode).toBe(201);

      const forAna = await anas.next('comment:new');
      expect(forAna.comment).toMatchObject({ hidden: false, text: 'The caterpillar is so rude', quote: 'Who are you?', reaction: '😡' });
      const forBen = await bens.next('comment:new');
      expect(forBen.comment).toMatchObject({ hidden: false, text: 'The caterpillar is so rude' });
      const forCole = await cole.next('comment:new');
      expect(forCole).toMatchObject({ clubId: club.id, bookId: book.id });
      expect(forCole.comment).toMatchObject({ hidden: true, hasText: true, reaction: '😡', authorName: 'Ben' });
      expect(JSON.stringify(forCole)).not.toContain('caterpillar');
      expect(JSON.stringify(forCole)).not.toContain('Who are you');
    });

    it('pushes saved progress to the club', async () => {
      const cole = await subscribed(owner);
      const at = Date.now();
      await ana.json(ana.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: epubAt(9, 10), readSpans: [{ from: epubAt(9, 0), to: epubAt(9, 10) }], at }), 200);
      const push = await cole.next('progress', (m) => m.progress.userId === ids.ana);
      expect(push).toMatchObject({ clubId: club.id, bookId: book.id });
      expect(push.progress).toMatchObject({ displayName: 'Ana', kind: 'epub', finished: false });
      expect(push.progress.t).toBeCloseTo(tOf(epubAt(9, 10)), 12);
      expect(push.progress.label).toMatch(/^Chapter 8 · \d+%$/);
      // A late report that changes neither the position nor the furthest point is not broadcast.
      await ana.json(ana.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: epubAt(2, 0), readSpans: [{ from: epubAt(9, 0), to: epubAt(9, 5) }], at: at - 60_000 }), 200);
      expect(await cole.quiet('progress', (m) => m.progress.userId === ids.ana)).toBe(true);
    });

    it('pushes deletions, book changes and club changes', async () => {
      const cole = await subscribed(owner);
      const note = await ana.json<{ id: string }>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(3, 3), reaction: '❤️' }), 201);
      await cole.next('comment:new');
      expect((await ana.delete(`/api/comments/${note.id}`)).statusCode).toBe(204);
      expect(await cole.next('comment:deleted')).toMatchObject({ clubId: club.id, bookId: book.id, commentId: note.id });
      await owner.json(owner.patch(`/api/books/${book.id}`, { author: 'Lewis Carroll (C. L. Dodgson)' }), 200);
      expect(await cole.next('book:changed')).toEqual({ type: 'book:changed', clubId: club.id, bookId: book.id });
      await owner.json(owner.patch(`/api/clubs/${club.id}`, { name: 'Thursday Readers (live)' }), 200);
      expect(await cole.next('club:changed')).toEqual({ type: 'club:changed', clubId: club.id });
      await joinClub(t, club, 'Newcomer');
      await cole.next('club:changed');
    });

    it('sign-out everywhere closes the member’s sockets', async () => {
      const dee = await joinClub(t, club, 'Dee');
      const socket = await subscribed(dee);
      expect((await dee.post('/api/auth/signout-everywhere')).statusCode).toBe(204);
      expect(await socket.closed).toEqual({ code: 4001, reason: 'signed out' });
    });
  });
});

describe('realtime heartbeat', () => {
  it('drops a socket that stops answering pings, announces it offline and keeps live ones', async () => {
    const t = await makeTestApp();
    try {
      const { owner, club } = await setupOwner(t);
      const ana = await joinClub(t, club, 'Ana');
      const anaId = (await ana.json<{ user: { id: string } }>(ana.get('/api/me'), 200)).user.id;
      const live = await openSocket(t, owner);
      const silent = await openSocket(t, ana, { autoPong: false });
      for (const s of [live, silent]) {
        s.send({ type: 'subscribe', clubId: club.id });
        await s.next('presence');
      }
      expect(t.ctx.hub.size).toBe(2);
      t.ctx.hub.start(60);
      expect((await silent.closed).code).toBe(1006);
      expect((await live.next('presence:update', (m) => m.entry.userId === anaId && !m.entry.online, 3000)).entry.online).toBe(false);
      await pause(250);
      expect(live.ws.readyState).toBe(WebSocket.OPEN);
      expect(t.ctx.hub.debug()).toEqual({ conns: 1 });
      await live.close();
    } finally {
      await closeApp(t);
    }
  });
});
