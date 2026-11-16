import type { ClubDetail } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Client, type TestApp, closeApp, fileOf, joinClub, makeEpub, makeTestApp, setupOwner, uploadBook } from '../../test/helpers';
import { FakeEmbeddingsProvider } from './embeddings/fake';
import { runTool, type ToolContext } from './tools';

async function userId(c: Client): Promise<string> {
  const me = await c.json<{ user: { id: string } }>(c.get('/api/me'), 200);
  return me.user.id;
}

const ch1 = '<p>' + 'alpha '.repeat(200) + '.</p>';
const ch2 = '<p>' + 'gamma '.repeat(200) + '.</p>';

describe('Cal tool handlers', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let clubId: string;
  let bookId: string;
  let tc: ToolContext;

  beforeEach(async () => {
    t = await makeTestApp({ CAL_EMBEDDING_PROVIDER: 'fake' });
    const setup = await setupOwner(t);
    owner = setup.owner;
    club = setup.club;
    clubId = club.id;
    const file = fileOf('book.epub', makeEpub([ch1, ch2], { title: 'Alice Clone', author: 'Test' }), 'main', 'application/epub+zip');
    const result = await uploadBook(owner, clubId, 'epub', [file], { title: 'Alice Clone', author: 'Test' });
    bookId = result.bookId;
    await t.settle();
    tc = { ctx: t.ctx, embeddings: new FakeEmbeddingsProvider(), clubId, userId: await userId(owner), wholeSeries: false, books: null, shelf: true, offeredChunkIds: new Set() };
  });
  afterEach(() => closeApp(t));

  it('search_library returns nothing (and no error) before the asker has read anything', async () => {
    const result = await runTool(tc, 'search_library', { query: 'alpha' });
    expect(result.text).toMatch(/no results/i);
    expect(tc.offeredChunkIds.size).toBe(0);
  });

  it('search_library offers chunk ids once the asker has read that far, and get_passage can fetch their neighbours', async () => {
    const edition = t.ctx.db.get<{ id: string }>('SELECT id FROM editions WHERE book_id = ?', [bookId])!.id;
    await owner.post(`/api/books/${bookId}/progress/read-up-to`, { editionId: edition, locator: { kind: 'epub', section: 1, offset: 9999 } });

    await runTool(tc, 'search_library', { query: 'alpha' });
    expect(tc.offeredChunkIds.size).toBeGreaterThan(0);
    const [chunkId] = [...tc.offeredChunkIds];

    const passage = await runTool(tc, 'get_passage', { chunkId });
    expect(passage.text).not.toMatch(/not available/i);
  });

  it('get_passage refuses a chunk id of another club’s book, even guessed correctly', async () => {
    // A second club's book's chunk id must not be fetchable through this club's tool context.
    // (Setup only runs once per server instance, so a second club comes from the same owner's
    // own account, not a second setupOwner call — see test/helpers.ts's own outsider() pattern.)
    const secondClub = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: `Other club ${Math.random()}` }), 201);
    const otherMember = await joinClub(t, secondClub, 'Other');
    const file = fileOf('book2.epub', makeEpub([ch2], { title: 'Someone Else’s Book', author: 'Test' }), 'main', 'application/epub+zip');
    const result = await uploadBook(otherMember, secondClub.id, 'epub', [file], { title: 'Someone Else’s Book', author: 'Test' });
    await t.settle();
    const row = t.ctx.db.get<{ id: string }>('SELECT id FROM cal_chunks WHERE book_id = ?', [result.bookId])!;

    const passage = await runTool(tc, 'get_passage', { chunkId: row.id });
    expect(passage.text).toBe('That chunk is not available.');
  });

  it('get_passage refuses a passage of the club’s own book the asker has not read, and leaves out neighbours past their place', async () => {
    const edition = t.ctx.db.get<{ id: string }>('SELECT id FROM editions WHERE book_id = ?', [bookId])!.id;
    const chunks = t.ctx.db.all<{ id: string; text: string }>('SELECT id, text FROM cal_chunks WHERE edition_id = ? ORDER BY seq', [edition]);
    const lastOfOne = chunks.filter((c) => c.text.includes('alpha')).at(-1)!;
    const firstOfTwo = chunks.find((c) => c.text.includes('gamma'))!;
    const refused = 'That passage is not available to you yet.';
    // Nothing read yet: an id of this club's own book, guessed right, is the gate's to refuse.
    expect((await runTool(tc, 'get_passage', { chunkId: lastOfOne.id })).text).toBe(refused);
    // The first chapter read: its passage comes, with its neighbours before it but none from the chapter after.
    await owner.post(`/api/books/${bookId}/progress/read-up-to`, { editionId: edition, locator: { kind: 'epub', section: 0, offset: 9999 } });
    const around = await runTool(tc, 'get_passage', { chunkId: lastOfOne.id, before: 5, after: 5 });
    expect(around.text).toContain(`chunk ${lastOfOne.id}`);
    expect(around.text).not.toContain('gamma');
    expect(tc.offeredChunkIds.has(firstOfTwo.id)).toBe(false);
    expect((await runTool(tc, 'get_passage', { chunkId: firstOfTwo.id })).text).toBe(refused);
  });

  it("whats_my_place reports chapter/percent, never a friend's note text", async () => {
    expect((await runTool(tc, 'whats_my_place', {})).text).toBe('Nobody in this club has started any of its books yet.');
    // A friend has read the first chapter and left a note there.
    const ana = await joinClub(t, club, 'Ana');
    const edition = t.ctx.db.get<{ id: string }>('SELECT id FROM editions WHERE book_id = ?', [bookId])!.id;
    const locator = { kind: 'epub', section: 0, offset: 9999 } as const;
    await ana.json(ana.post(`/api/books/${bookId}/progress/read-up-to`, { editionId: edition, locator }), 200);
    await ana.json(ana.post(`/api/books/${bookId}/comments`, { editionId: edition, locator: { kind: 'epub', section: 0, offset: 10 }, text: 'Ana’s secret note <script>' }), 201);
    const result = await runTool(tc, 'whats_my_place', {});
    expect(result.text).toMatch(/^Alice Clone:\n {2}Ana: \S/u);
    expect(result.text).not.toContain('secret');
    expect(result.text).not.toContain('<script');
  });
});
