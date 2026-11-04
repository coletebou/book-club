import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Client, type TestApp, closeApp, fileOf, joinClub, makeEpub, makeTestApp, setupOwner, uploadBook } from '../../test/helpers';
import { createSeries, setBookSeries } from './store';
import { hybridSearch } from './search';
import { FakeEmbeddingsProvider } from './embeddings/fake';

async function userId(c: Client): Promise<string> {
  const me = await c.json<{ user: { id: string } }>(c.get('/api/me'), 200);
  return me.user.id;
}

async function uploadEpub(t: TestApp, clubId: string, c: Client, sections: readonly string[], title: string) {
  const file = fileOf(`${title}.epub`, makeEpub(sections, { title, author: 'Test' }), 'main', 'application/epub+zip');
  const result = await uploadBook(c, clubId, 'epub', [file], { title, author: 'Test' });
  await t.settle();
  return result;
}

const ch1 = '<p>' + 'alpha '.repeat(200) + '.</p><p>' + 'beta '.repeat(200) + '.</p>';
const ch2 = '<p>' + 'gamma '.repeat(200) + '.</p>';

describe('Cal hybrid search + spoiler gate', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp({ CAL_EMBEDDING_PROVIDER: 'fake' });
  });
  afterEach(() => closeApp(t));

  it('indexes an uploaded EPUB into cal_chunks automatically', async () => {
    const { owner, club } = await setupOwner(t);
    const { bookId, editionId } = await uploadEpub(t, club.id, owner, [ch1, ch2], 'Alice Clone');
    const rows = t.ctx.db.all<{ id: string; chapter_title: string | null }>('SELECT id, chapter_title FROM cal_chunks WHERE book_id = ? ORDER BY seq', [bookId]);
    expect(rows.length).toBeGreaterThan(0);
    const status = t.ctx.db.get('SELECT status FROM cal_index_status WHERE kind = ? AND ref_id = ?', ['edition', editionId]);
    expect(status).toMatchObject({ status: 'ready' });
  });

  it('a chunk is only returned to a user who has read far enough to hold all of it', async () => {
    const { owner, club } = await setupOwner(t);
    const friend = await joinClub(t, club, 'Friend');
    const { bookId, editionId } = await uploadEpub(t, club.id, owner, [ch1, ch2], 'Alice Clone');
    const embeddings = new FakeEmbeddingsProvider();
    const ownerUserId = await userId(owner);
    const friendUserId = await userId(friend);

    // The owner has read nothing: a chapter 2 word must not come back.
    const nothingRead = await hybridSearch(t.ctx.db, embeddings, { clubId: club.id, userId: ownerUserId, query: 'gamma', wholeSeries: false, limit: 5 });
    expect(nothingRead).toHaveLength(0);

    // The friend reads up to the end of chapter 1 ("I've read up to here"). Searching for the
    // unread chapter's own word must never surface its text — a small fixture corpus (three
    // chunks total) can still return an unrelated, already-read chunk as a vector-search
    // candidate (cosine similarity has no "doesn't match" floor), so the real guarantee under
    // test is that the chapter 2 content itself never comes back, not that nothing does.
    await friend.post(`/api/books/${bookId}/progress/read-up-to`, { editionId, locator: { kind: 'epub', section: 1, offset: 0 } });
    const afterCh1 = await hybridSearch(t.ctx.db, embeddings, { clubId: club.id, userId: friendUserId, query: 'gamma', wholeSeries: false, limit: 5 });
    expect(afterCh1.every((hit) => !hit.text.includes('gamma'))).toBe(true);
    const alphaHit = await hybridSearch(t.ctx.db, embeddings, { clubId: club.id, userId: friendUserId, query: 'alpha', wholeSeries: false, limit: 5 });
    expect(alphaHit.length).toBeGreaterThan(0);
    expect(alphaHit.some((hit) => hit.text.includes('alpha'))).toBe(true);

    // Reading past chapter 2 opens gamma too.
    await friend.post(`/api/books/${bookId}/progress/read-up-to`, { editionId, locator: { kind: 'epub', section: 1, offset: 9999 } });
    const afterCh2 = await hybridSearch(t.ctx.db, embeddings, { clubId: club.id, userId: friendUserId, query: 'gamma', wholeSeries: false, limit: 5 });
    expect(afterCh2.length).toBeGreaterThan(0);
  });

  it('a series book the asker has never started is excluded entirely, unless "whole series" is on', async () => {
    const { owner, club } = await setupOwner(t);
    const { bookId: book1Id } = await uploadEpub(t, club.id, owner, [ch1], 'Series Book One');
    const { bookId: book2Id } = await uploadEpub(t, club.id, owner, [ch2], 'Series Book Two');
    const ownerUserId = await userId(owner);
    const series = createSeries(t.ctx.db, { clubId: club.id, title: 'The Series', createdBy: ownerUserId });
    setBookSeries(t.ctx.db, book1Id, series.id, 1);
    setBookSeries(t.ctx.db, book2Id, series.id, 2);

    // The owner started book one (any progress at all) but never touched book two.
    const edition1 = t.ctx.db.get<{ id: string }>('SELECT id FROM editions WHERE book_id = ?', [book1Id])!.id;
    await owner.post(`/api/books/${book1Id}/progress/read-up-to`, { editionId: edition1, locator: { kind: 'epub', section: 0, offset: 1 } });

    const embeddings = new FakeEmbeddingsProvider();
    const excluded = await hybridSearch(t.ctx.db, embeddings, { clubId: club.id, userId: ownerUserId, query: 'gamma', wholeSeries: false, limit: 5 });
    expect(excluded).toHaveLength(0);

    const included = await hybridSearch(t.ctx.db, embeddings, { clubId: club.id, userId: ownerUserId, query: 'gamma', wholeSeries: true, limit: 5 });
    expect(included.length).toBeGreaterThan(0);
  });
});
