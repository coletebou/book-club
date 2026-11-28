import { type BookDetail, type ChatThread, type ClubDetail, type ClubSearchResponse, type SessionInfo } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertChatMessage } from '../src/repos/chat';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, outsider, readEpubTo, setupOwner, uploadBook } from './helpers';

describe('club search (D251)', () => {
  let app: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let book: BookDetail;
  const route = () => `/api/clubs/${club.id}/search`;
  const search = (client: Client, query: string) => client.json<ClubSearchResponse>(client.post(route(), { query }), 200);

  beforeAll(async () => {
    app = await makeTestApp();
    ({ owner, club } = await setupOwner(app));
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await app.settle();
    book = await bookDetail(owner, bookId);
  });
  afterAll(async () => { await closeApp(app); });

  it('finds books by title and author for members, with no matches from another club', async () => {
    const reader = await joinClub(app, club, 'Book search reader');
    const expected = { kind: 'book', id: book.id, title: 'Alice', detail: 'Lewis Carroll', href: `/books/${book.id}` };
    expect(await search(reader, '  ALICE  ')).toEqual({ results: [expected] });
    expect(await search(reader, 'carroll')).toEqual({ results: [expected] });
    const outsiderClient = await outsider(app, owner, 'Another Reader');
    expect((await outsiderClient.post(route(), { query: 'Alice' })).statusCode).toBe(404);
    expect((await app.client().post(route(), { query: 'Alice' })).statusCode).toBe(401);
    const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Separate collection' }), 201);
    expect(await owner.json(owner.post(`/api/clubs/${other.id}/search`, { query: 'Alice' }), 200)).toEqual({ results: [] });
    const response = await reader.post(route(), { query: 'Alice' });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect((await reader.post(route(), { query: 'x'.repeat(121) })).statusCode).toBe(400);
  });

  it('finds visible chat and notes before a block and omits them afterward', async () => {
    const reader = await joinClub(app, club, 'Safety search reader');
    const author = await joinClub(app, club, 'Safety search author');
    const { user } = await author.json<SessionInfo>(author.get('/api/session'), 200);
    await readEpubTo(reader, book, 1);
    const word = 'safety-visibility';
    await author.json(author.post(`/api/clubs/${club.id}/chat`, { text: `Blocked chat ${word}` }), 201);
    await author.json(author.post(`/api/books/${book.id}/comments`, {
      editionId: book.editions[0]!.id, locator: { kind: 'epub', section: 2, offset: 42 }, text: `Blocked note ${word}`,
    }), 201);
    await owner.json(owner.post(`/api/clubs/${club.id}/chat`, { text: `Available chat ${word}` }), 201);
    const before = (await search(reader, word)).results;
    expect(before.map((entry) => entry.title).sort()).toEqual([`Available chat ${word}`, `Blocked chat ${word}`, `Blocked note ${word}`]);
    expect((await reader.put(`/api/clubs/${club.id}/blocks/${user!.id}`, {})).statusCode).toBe(200);
    expect((await search(reader, word)).results.map((entry) => entry.title)).toEqual([`Available chat ${word}`]);
  });

  it('returns neither a chapter heading nor a count until the reader has read it', async () => {
    const reader = await joinClub(app, club, 'Chapter search reader');
    expect(await search(reader, 'croquet')).toEqual({ results: [] });
    const editionId = book.editions[0]!.id;
    const location = { kind: 'epub', section: 8, offset: 120 };
    await reader.json(reader.put(`/api/books/${book.id}/progress`, { editionId, locator: location, readSpans: [], at: Date.now() }), 200);
    expect(await search(reader, 'croquet')).toEqual({ results: [] });

    await readEpubTo(reader, book, 1);
    const result = await search(reader, 'croquet');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ kind: 'chapter', detail: 'Alice', title: expect.stringMatching(/croquet/i), href: expect.stringContaining(`/books/${book.id}/read?edition=${editionId}&at=`) });
  });

  it('keeps matching note text and its quoted words behind the writer horizon', async () => {
    const reader = await joinClub(app, club, 'Note search reader');
    await readEpubTo(owner, book, 1);
    const editionId = book.editions[0]!.id;
    const { id } = await owner.json<{ id: string }>(owner.post(`/api/books/${book.id}/comments`, {
      editionId,
      locator: { kind: 'epub', section: 2, offset: 40 },
      text: 'The viridian phantom survives.',
      quote: 'A clockwork revelation',
    }), 201);
    expect(await search(reader, 'viridian')).toEqual({ results: [] });
    await readEpubTo(reader, book, 0.45);
    expect(await search(reader, 'viridian')).toEqual({ results: [] });
    expect(await search(reader, 'clockwork')).toEqual({ results: [] });

    await readEpubTo(reader, book, 1);
    expect((await search(reader, 'viridian')).results).toEqual([expect.objectContaining({ kind: 'note', id, title: 'The viridian phantom survives.', href: expect.stringContaining(`&comment=${id}`) })]);
    expect((await search(reader, 'clockwork')).results).toEqual([expect.objectContaining({ kind: 'note', id, title: 'A clockwork revelation' })]);
  });

  it('returns only open chat text and hidden matches never displace a visible result', async () => {
    const reader = await joinClub(app, club, 'Chat search reader');
    const chat = `/api/clubs/${club.id}/chat`;
    await owner.json(owner.post(chat, { bookId: book.id, text: 'The unread emerald ending', spoilerUpToT: 0.75 }), 201);
    expect(await search(reader, 'emerald')).toEqual({ results: [] });
    const { id } = await owner.json<{ id: string }>(owner.post(chat, { text: 'An invitation to the club' }), 201);
    for (let i = 0; i < 8; i++) {
      await owner.json(owner.post(chat, { bookId: book.id, text: `Invitation spoiler ${i}`, spoilerUpToT: 0.75 }), 201);
    }
    expect(await search(reader, 'invitation')).toEqual({ results: [{ kind: 'chat', id, title: 'An invitation to the club', detail: 'Cole', href: `/clubs/${club.id}/chat?message=${id}` }] });

    await readEpubTo(reader, book, 1);
    expect((await search(reader, 'emerald')).results).toEqual([expect.objectContaining({ kind: 'chat', title: 'The unread emerald ending' })]);
  });

  it('opens a search hit older than the newest 200 replies and keeps its match in the excerpt', async () => {
    const reader = await joinClub(app, club, 'Older reply search reader');
    const chat = `/api/clubs/${club.id}/chat`;
    const root = await owner.json<{ id: string; author: { userId: string } }>(owner.post(chat, { text: 'A long discussion' }), 201);
    const hit = await owner.json<{ id: string }>(owner.post(chat, { parentId: root.id, text: `${'İ'.repeat(180)} a snowy plan` }), 201);
    app.ctx.db.tx(() => {
      app.ctx.db.exec('UPDATE chat_messages SET created_at = 1 WHERE id = ?', [hit.id]);
      for (let i = 0; i < 200; i++) {
        insertChatMessage(app.ctx.db, { clubId: club.id, bookId: null, userId: root.author.userId, text: `Later reply ${i}`, parentId: root.id, threadId: root.id, clientId: null, spoilerT: null, spoilerEditionId: null });
      }
    });
    expect((await search(reader, 'snowy plan')).results).toEqual([expect.objectContaining({ kind: 'chat', id: hit.id, title: expect.stringContaining('a snowy plan') })]);
    const recent = await reader.json<ChatThread>(reader.get(`/api/chat/${root.id}/thread`), 200);
    expect(recent.replies.some((reply) => reply.id === hit.id)).toBe(false);
    const focused = await reader.json<ChatThread>(reader.get(`/api/chat/${hit.id}/thread`), 200);
    expect(focused.replies).toHaveLength(200);
    expect(focused.replies[0]).toMatchObject({ id: hit.id, hidden: false });
    expect(focused.hasMore).toBe(true);
  });

  it('bounds chat search to recent rows and treats percent and underscore literally', async () => {
    const recentClub = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Recent chat search' }), 201);
    const chat = `/api/clubs/${recentClub.id}/chat`;
    const older = await owner.json<{ id: string; author: { userId: string } }>(owner.post(chat, { text: 'An old 100%_ message' }), 201);
    app.ctx.db.tx(() => {
      app.ctx.db.exec('UPDATE chat_messages SET created_at = 1 WHERE id = ?', [older.id]);
      for (let i = 0; i < 1_000; i++) {
        insertChatMessage(app.ctx.db, { clubId: recentClub.id, userId: older.author.userId, bookId: null, text: `10000 filler ${i}`, parentId: null, threadId: null, clientId: null, spoilerT: null, spoilerEditionId: null });
      }
    });
    const open = await owner.json<{ id: string }>(owner.post(chat, { text: 'A new 100%_ message' }), 201);
    const deleted = await owner.json<{ id: string }>(owner.post(chat, { text: 'A deleted 100%_ message' }), 201);
    expect((await owner.delete(`/api/chat/${deleted.id}`)).statusCode).toBe(204);
    await owner.json(owner.post(`/api/clubs/${club.id}/chat`, { text: 'A 100%_ message in another club' }), 201);

    const result = await owner.json<ClubSearchResponse>(owner.post(`/api/clubs/${recentClub.id}/search`, { query: '100%_' }), 200);
    expect(result.results).toEqual([expect.objectContaining({ kind: 'chat', id: open.id, title: 'A new 100%_ message' })]);
  });

  it('limits searches per member and per club', async () => {
    const limitedClub = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Search rate limits' }), 201);
    const path = `/api/clubs/${limitedClub.id}/search`;
    const first = await joinClub(app, limitedClub, 'First search member');
    const query = { query: 'something' };
    for (let i = 0; i < 20; i++) expect((await first.post(path, query)).statusCode).toBe(200);
    expect((await first.post(path, query)).statusCode).toBe(429);
    for (const name of ['Second search member', 'Third search member', 'Fourth search member']) {
      const member = await joinClub(app, limitedClub, name);
      for (let i = 0; i < 20; i++) expect((await member.post(path, query)).statusCode).toBe(200);
    }
    expect((await owner.post(path, query)).statusCode).toBe(429);
    expect((await owner.post(route(), query)).statusCode).toBe(200);
  });
});
