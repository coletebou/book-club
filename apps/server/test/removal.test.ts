import { existsSync } from 'node:fs';
import { ApiErrorSchema, ClubDetailSchema, ClubSummarySchema, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listDeleted, purgeClub, undelete } from '../src/services/removal';
import { type Client, type Res, type TestApp, closeApp, fileOf, joinClub, makeTestApp, outsider, setupOwner, standardEbook, uploadBook } from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

describe('disbanding a club and removing a book, recoverably (D179)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;

  const newClub = async (name: string) => ClubDetailSchema.parse(await owner.json(owner.post('/api/clubs', { name }), 201));
  const clubIds = async (c: Client) => (await c.json<unknown[]>(c.get('/api/clubs'), 200)).map((x) => ClubSummarySchema.parse(x).id);
  const epub = (words = 200) => fileOf('book.epub', standardEbook({ chapterWords: words }), 'main', 'application/epub+zip');
  const blobsOf = (editionId: string) => t.ctx.db.all<{ blob_id: string }>('SELECT blob_id FROM edition_files WHERE edition_id = ?', [editionId]).map((r) => r.blob_id);

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('only an owner may disband; members are refused, outsiders see no club', async () => {
    const ana = await joinClub(t, club, 'Ana');
    expect((await ana.delete(`/api/clubs/${club.id}`)).statusCode).toBe(403);
    const ozzy = await outsider(t, owner, 'Ozzy');
    const hidden = await ozzy.delete(`/api/clubs/${club.id}`);
    expect(hidden.statusCode).toBe(404);
    expect(errorOf(hidden)).toEqual({ code: 'not_found', message: 'Club not found.' });
    expect((await t.client().delete(`/api/clubs/${club.id}`)).statusCode).toBe(401);
    expect((await owner.get(`/api/clubs/${club.id}`)).statusCode).toBe(200);
  });

  it('the only owner disbands it: gone for everyone in the app, kept on the server, and brought back whole', async () => {
    const doomed = await newClub('Short-lived');
    const ben = await joinClub(t, doomed, 'Ben');
    const { bookId, editionId } = await uploadBook(owner, doomed.id, 'epub', [epub()], { title: 'Doomed' });
    await t.settle();
    expect((await owner.post(`/api/clubs/${doomed.id}/chat`, { text: 'last words' })).statusCode).toBe(201);
    const invite = doomed.invite!.code;
    expect(ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${doomed.id}`), 200)).members).toHaveLength(2);

    expect((await owner.delete(`/api/clubs/${doomed.id}`)).statusCode).toBe(204);

    for (const c of [owner, ben]) {
      expect((await c.get(`/api/clubs/${doomed.id}`)).statusCode).toBe(404);
      expect((await c.get(`/api/clubs/${doomed.id}/books`)).statusCode).toBe(404);
      expect((await c.get(`/api/clubs/${doomed.id}/chat`)).statusCode).toBe(404);
      expect((await c.get(`/api/books/${bookId}`)).statusCode).toBe(404);
      expect((await c.get(`/media/editions/${editionId}/file`)).statusCode).toBe(404);
      expect(await clubIds(c)).not.toContain(doomed.id);
    }
    expect((await t.client().get(`/api/invites/${invite}`)).statusCode).toBe(404);
    // Nobody joins a disbanded club with its old link: neither someone signed in, nor a new account.
    const late = await outsider(t, owner, 'Late');
    expect((await late.post(`/api/invites/${invite}/accept`)).statusCode).toBe(404);
    const signup = await t.client().post('/api/auth/signup', { displayName: 'Newcomer', email: 'newcomer@example.org', password: 'a-long-enough-password', inviteCode: invite });
    expect(signup.statusCode).toBeGreaterThanOrEqual(400);
    expect(t.ctx.db.get("SELECT 1 AS x FROM users WHERE email = 'newcomer@example.org'")).toBeUndefined();
    expect((await owner.delete(`/api/clubs/${doomed.id}`)).statusCode).toBe(404);
    // Kept: the rows and the files.
    expect(t.ctx.db.get('SELECT 1 AS x FROM memberships WHERE club_id = ?', [doomed.id])).toBeDefined();
    for (const id of blobsOf(editionId)) expect(existsSync(t.ctx.storage.blobPath(id))).toBe(true);
    expect(listDeleted(t.ctx.db)).toContainEqual(expect.objectContaining({ kind: 'club', id: doomed.id, name: 'Short-lived' }));

    expect(undelete(t.ctx, 'club', doomed.id)).toBe(true);
    expect(undelete(t.ctx, 'club', doomed.id)).toBe(false);
    expect(await clubIds(ben)).toContain(doomed.id);
    expect((await ben.get(`/api/books/${bookId}`)).statusCode).toBe(200);
    expect((await ben.get(`/media/editions/${editionId}/file`)).statusCode).toBe(200);
    const back = ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${doomed.id}`), 200));
    expect(back).toMatchObject({ memberCount: 2, bookCount: 1 });
    expect(back.members.map((m) => m.displayName)).not.toContain('Late');
  });

  it('removing a book hides it from the club, keeps its files, and can be undone', async () => {
    const shelf = await newClub('Shelf');
    const { bookId, editionId } = await uploadBook(owner, shelf.id, 'epub', [epub(250)], { title: 'Removed' });
    await t.settle();
    expect((await owner.delete(`/api/books/${bookId}`)).statusCode).toBe(204);
    expect((await owner.get(`/api/books/${bookId}`)).statusCode).toBe(404);
    expect((await owner.json<{ id: string }[]>(owner.get(`/api/clubs/${shelf.id}/books`), 200)).map((b) => b.id)).not.toContain(bookId);
    expect(ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${shelf.id}`), 200)).bookCount).toBe(0);
    for (const id of blobsOf(editionId)) expect(existsSync(t.ctx.storage.blobPath(id))).toBe(true);
    expect(listDeleted(t.ctx.db)).toContainEqual(expect.objectContaining({ kind: 'book', id: bookId, clubId: shelf.id, name: 'Removed' }));
    expect(undelete(t.ctx, 'book', bookId)).toBe(true);
    expect((await owner.get(`/api/books/${bookId}`)).statusCode).toBe(200);
  });

  it('a purge removes a disbanded club and the files nothing else uses, for good', async () => {
    const solo = await newClub('Solo');
    const kept = await newClub('Kept');
    const shared = epub(321);
    const { editionId } = await uploadBook(owner, solo.id, 'epub', [shared], { title: 'Solo' });
    const other = await uploadBook(owner, kept.id, 'epub', [shared], { title: 'Same file' });
    const own = await uploadBook(owner, solo.id, 'epub', [epub(123)], { title: 'Only here' });
    await t.settle();
    const sharedBlobs = blobsOf(editionId);
    expect(blobsOf(other.editionId)).toEqual(sharedBlobs);
    const ownBlobs = blobsOf(own.editionId);
    expect((await owner.delete(`/api/clubs/${solo.id}`)).statusCode).toBe(204);
    expect(await purgeClub(t.ctx, solo.id)).toBe(true);
    expect(t.ctx.db.get('SELECT 1 AS x FROM clubs WHERE id = ?', [solo.id])).toBeUndefined();
    expect(t.ctx.db.get('SELECT 1 AS x FROM books WHERE club_id = ?', [solo.id])).toBeUndefined();
    for (const id of ownBlobs) expect(existsSync(t.ctx.storage.blobPath(id))).toBe(false);
    for (const id of sharedBlobs) expect(existsSync(t.ctx.storage.blobPath(id))).toBe(true);
    expect((await owner.get(`/media/editions/${other.editionId}/file`)).statusCode).toBe(200);
    expect(undelete(t.ctx, 'club', solo.id)).toBe(false);
  });
});
