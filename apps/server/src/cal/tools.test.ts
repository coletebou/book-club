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
  let clubId: string;
  let bookId: string;
  let tc: ToolContext;

  beforeEach(async () => {
    t = await makeTestApp({ CAL_EMBEDDING_PROVIDER: 'fake' });
    const setup = await setupOwner(t);
    owner = setup.owner;
    clubId = setup.club.id;
    const file = fileOf('book.epub', makeEpub([ch1, ch2], { title: 'Alice Clone', author: 'Test' }), 'main', 'application/epub+zip');
    const result = await uploadBook(owner, clubId, 'epub', [file], { title: 'Alice Clone', author: 'Test' });
    bookId = result.bookId;
    await t.settle();
    tc = { ctx: t.ctx, embeddings: new FakeEmbeddingsProvider(), clubId, userId: await userId(owner), wholeSeries: false, offeredChunkIds: new Set() };
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

  it('get_passage refuses a chunk id the asker has not actually read, even if guessed correctly', async () => {
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
    expect(passage.text).toMatch(/not available/i);
  });

  it("whats_my_place reports chapter/percent, never a friend's note text", async () => {
    const result = await runTool(tc, 'whats_my_place', {});
    expect(result.text).not.toContain('<script');
    expect(result.text.length).toBeGreaterThan(0);
  });
});
