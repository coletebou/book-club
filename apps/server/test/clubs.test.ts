import { ApiErrorSchema, ClubDetailSchema, ClubSummarySchema, InvitePreviewSchema, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, PASSWORD, type Res, type TestApp, joinClub, makeTestApp, outsider, setupOwner, closeApp } from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

describe('clubs and invites', () => {
  let t: TestApp;
  let owner: Client;
  let ownerId: string;
  let club: ClubDetail;
  let ana: Client;
  let anaId: string;

  const idOf = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/me'), 200)).user.id;
  /** A fresh club owned by `owner` (so tests that change membership do not disturb each other). */
  const newClub = async (name: string) => ClubDetailSchema.parse(await owner.json(owner.post('/api/clubs', { name }), 201));

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ownerId = await idOf(owner);
    ana = await joinClub(t, club, 'Ana');
    anaId = await idOf(ana);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  describe('creating and reading clubs', () => {
    it('creates a club with its owner and a first invite', async () => {
      const res = await owner.post('/api/clubs', { name: '  Night Owls  ', description: 'We read late.' });
      expect(res.statusCode).toBe(201);
      const created = ClubDetailSchema.parse(res.json());
      expect(created).toMatchObject({ name: 'Night Owls', description: 'We read late.', role: 'owner', memberCount: 1, bookCount: 0 });
      expect(created.members).toEqual([expect.objectContaining({ userId: ownerId, displayName: 'Cole', role: 'owner' })]);
      expect(created.invite!.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(created.invite!.url).toBe(`${t.baseUrl}/join/${created.invite!.code}`);
    });

    it('validates the club form', async () => {
      const res = await owner.post('/api/clubs', { name: '   ' });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).fields).toEqual({ name: 'Name your club' });
      expect((await owner.post('/api/clubs', { name: 'x'.repeat(101) })).statusCode).toBe(400);
      expect((await owner.post('/api/clubs', { name: 'Ok', description: 'd'.repeat(501) })).statusCode).toBe(400);
    });

    it('lists only the clubs you are in, with your role and counts', async () => {
      const mine = (await owner.json<unknown[]>(owner.get('/api/clubs'), 200)).map((c) => ClubSummarySchema.parse(c));
      expect(mine.find((c) => c.id === club.id)).toMatchObject({ name: 'Thursday Readers', role: 'owner', memberCount: 2, bookCount: 0 });
      const anas = (await ana.json<unknown[]>(ana.get('/api/clubs'), 200)).map((c) => ClubSummarySchema.parse(c));
      expect(anas).toEqual([expect.objectContaining({ id: club.id, role: 'member', memberCount: 2 })]);
    });

    it('shows members in joining order; the invite only to owners', async () => {
      const forOwner = ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${club.id}`), 200));
      expect(forOwner.members.map((m) => [m.displayName, m.role])).toEqual([
        ['Cole', 'owner'],
        ['Ana', 'member'],
      ]);
      expect(forOwner.invite).not.toBeNull();
      const forAna = ClubDetailSchema.parse(await ana.json(ana.get(`/api/clubs/${club.id}`), 200));
      expect(forAna.role).toBe('member');
      // A member can bring a friend with the club's link, but cannot renew it.
      expect(forAna.invite).toEqual(forOwner.invite);
      expect((await ana.post(`/api/clubs/${club.id}/invite/rotate`)).statusCode).toBe(403);
    });

    it('rejects malformed club ids with 400 and unknown ones with 404', async () => {
      expect((await owner.get('/api/clubs/no!')).statusCode).toBe(400);
      const missing = await owner.get('/api/clubs/doesnotexist1');
      expect(missing.statusCode).toBe(404);
      expect(errorOf(missing)).toEqual({ code: 'not_found', message: 'Club not found.' });
    });
  });

  describe('renaming', () => {
    it('the owner renames the club and changes its description', async () => {
      const c = await newClub('Old name');
      const renamed = ClubDetailSchema.parse(await owner.json(owner.patch(`/api/clubs/${c.id}`, { name: 'New name', description: 'Now with a description' }), 200));
      expect(renamed).toMatchObject({ name: 'New name', description: 'Now with a description' });
      const partial = ClubDetailSchema.parse(await owner.json(owner.patch(`/api/clubs/${c.id}`, { description: '' }), 200));
      expect(partial).toMatchObject({ name: 'New name', description: '' });
    });

    it('a member cannot rename the club (403)', async () => {
      const res = await ana.patch(`/api/clubs/${club.id}`, { name: 'Ana’s club now' });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toEqual({ code: 'forbidden', message: 'Only the club owner can do that.' });
      expect((await owner.json<ClubDetail>(owner.get(`/api/clubs/${club.id}`), 200)).name).toBe('Thursday Readers');
    });
  });

  describe('invite links', () => {
    it('anyone can preview an invite without signing in', async () => {
      const anon = t.client();
      const preview = InvitePreviewSchema.parse(await anon.json(anon.get(`/api/invites/${club.invite!.code}`), 200));
      expect(preview).toEqual({ clubName: 'Thursday Readers', inviterName: 'Cole', memberCount: 2 });
    });

    it('an unknown invite preview is 404 invite_invalid', async () => {
      const res = await t.client().get('/api/invites/not-a-real-invite');
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('invite_invalid');
    });

    it('a signed-in person joins by accepting; accepting again changes nothing', async () => {
      const c = await newClub('Accepting Club');
      const ben = await outsider(t, owner, 'Ben');
      const first = await ben.json<{ clubId: string; joined: boolean }>(ben.post(`/api/invites/${c.invite!.code}/accept`), 200);
      expect(first).toEqual({ clubId: c.id, joined: true });
      const again = await ben.json<{ clubId: string; joined: boolean }>(ben.post(`/api/invites/${c.invite!.code}/accept`), 200);
      expect(again).toEqual({ clubId: c.id, joined: false });
      const detail = ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${c.id}`), 200));
      expect(detail.memberCount).toBe(2);
      expect(t.ctx.db.get<{ uses: number }>('SELECT uses FROM invites WHERE code = ?', [c.invite!.code])!.uses).toBe(1);
      // The owner accepting their own invite is a no-op too.
      expect(await owner.json(owner.post(`/api/invites/${c.invite!.code}/accept`), 200)).toEqual({ clubId: c.id, joined: false });
    });

    it('accepting needs a session and a valid code', async () => {
      expect((await t.client().post(`/api/invites/${club.invite!.code}/accept`)).statusCode).toBe(401);
      const res = await ana.post('/api/invites/not-a-real-invite/accept');
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('invite_invalid');
    });

    it('rotating revokes the old link everywhere and issues a new one', async () => {
      const c = await newClub('Rotating');
      const oldCode = c.invite!.code;
      const rotated = await owner.json<{ code: string; url: string }>(owner.post(`/api/clubs/${c.id}/invite/rotate`), 200);
      expect(rotated.code).not.toBe(oldCode);
      expect(rotated.url).toBe(`${t.baseUrl}/join/${rotated.code}`);
      expect((await t.client().get(`/api/invites/${oldCode}`)).statusCode).toBe(404);
      expect((await ana.post(`/api/invites/${oldCode}/accept`)).statusCode).toBe(404);
      const signup = await t.client().post('/api/auth/signup', { inviteCode: oldCode, displayName: 'Too Late', email: 'late@example.com', password: PASSWORD });
      expect(signup.statusCode).toBe(404);
      // The new code works, and is the one the owner now sees.
      expect((await t.client().get(`/api/invites/${rotated.code}`)).statusCode).toBe(200);
      expect((await owner.json<ClubDetail>(owner.get(`/api/clubs/${c.id}`), 200)).invite!.code).toBe(rotated.code);
    });

    it('a member cannot rotate the invite (403)', async () => {
      const res = await ana.post(`/api/clubs/${club.id}/invite/rotate`);
      expect(res.statusCode).toBe(403);
      expect((await owner.json<ClubDetail>(owner.get(`/api/clubs/${club.id}`), 200)).invite!.code).toBe(club.invite!.code);
    });
  });

  describe('members', () => {
    it('a member cannot remove someone else (403)', async () => {
      const res = await ana.delete(`/api/clubs/${club.id}/members/${ownerId}`);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).message).toBe('Only the club owner can remove members.');
    });

    it('the owner removes a member, who immediately loses the club', async () => {
      const c = await newClub('Removal');
      const dan = await joinClub(t, c, 'Dan');
      const danId = await idOf(dan);
      expect((await dan.get(`/api/clubs/${c.id}`)).statusCode).toBe(200);
      expect((await owner.delete(`/api/clubs/${c.id}/members/${danId}`)).statusCode).toBe(204);
      expect((await dan.get(`/api/clubs/${c.id}`)).statusCode).toBe(404);
      expect((await dan.get(`/api/clubs/${c.id}/books`)).statusCode).toBe(404);
      expect(await dan.json<unknown[]>(dan.get('/api/clubs'), 200)).toEqual([]);
      expect(ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${c.id}`), 200)).memberCount).toBe(1);
    });

    it('a member can leave on their own', async () => {
      const c = await newClub('Leaving');
      const eve = await joinClub(t, c, 'Eve');
      expect((await eve.delete(`/api/clubs/${c.id}/members/${await idOf(eve)}`)).statusCode).toBe(204);
      expect((await eve.get(`/api/clubs/${c.id}`)).statusCode).toBe(404);
      // ... and can come back with the invite.
      expect(await eve.json(eve.post(`/api/invites/${c.invite!.code}/accept`), 200)).toEqual({ clubId: c.id, joined: true });
    });

    it('removing someone who is not a member is 404', async () => {
      const res = await owner.delete(`/api/clubs/${club.id}/members/notamember123`);
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).message).toBe('Member not found.');
    });

    it('the last owner can neither leave nor step down (400)', async () => {
      const c = await newClub('One owner');
      const leave = await owner.delete(`/api/clubs/${c.id}/members/${ownerId}`);
      expect(leave.statusCode).toBe(400);
      expect(errorOf(leave).message).toBe('A club needs an owner. Make someone else owner first.');
      const demote = await owner.put(`/api/clubs/${c.id}/members/${ownerId}/role`, { role: 'member' });
      expect(demote.statusCode).toBe(400);
      expect(errorOf(demote).message).toBe('A club needs an owner.');
      expect(ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${c.id}`), 200)).role).toBe('owner');
    });

    it('the owner can make a member an owner, who can then hand the club over', async () => {
      const c = await newClub('Handover');
      const fay = await joinClub(t, c, 'Fay');
      const fayId = await idOf(fay);
      expect((await fay.post(`/api/clubs/${c.id}/invite/rotate`)).statusCode).toBe(403);
      const promoted = ClubDetailSchema.parse(await owner.json(owner.put(`/api/clubs/${c.id}/members/${fayId}/role`, { role: 'owner' }), 200));
      expect(promoted.members.find((m) => m.userId === fayId)?.role).toBe('owner');
      // Fay now has owner powers, including seeing the invite.
      expect(ClubDetailSchema.parse(await fay.json(fay.get(`/api/clubs/${c.id}`), 200)).invite).not.toBeNull();
      expect((await fay.post(`/api/clubs/${c.id}/invite/rotate`)).statusCode).toBe(200);
      // With two owners, Fay can make Cole a member; then Cole has no owner powers left.
      expect((await fay.put(`/api/clubs/${c.id}/members/${ownerId}/role`, { role: 'member' })).statusCode).toBe(200);
      expect((await owner.post(`/api/clubs/${c.id}/invite/rotate`)).statusCode).toBe(403);
      expect(ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${c.id}`), 200))).toMatchObject({ role: 'member', invite: expect.objectContaining({ code: expect.any(String) as string }) as unknown });
      // And an owner who is not the last one may leave.
      expect((await owner.delete(`/api/clubs/${c.id}/members/${ownerId}`)).statusCode).toBe(204);
    });

    it('role changes are validated and owner-only', async () => {
      expect((await ana.put(`/api/clubs/${club.id}/members/${anaId}/role`, { role: 'owner' })).statusCode).toBe(403);
      const bad = await owner.put(`/api/clubs/${club.id}/members/${anaId}/role`, { role: 'admin' });
      expect(bad.statusCode).toBe(400);
      expect(errorOf(bad).message).toBe('Role must be owner or member.');
      expect((await owner.put(`/api/clubs/${club.id}/members/${anaId}/role`)).statusCode).toBe(400);
      expect((await owner.put(`/api/clubs/${club.id}/members/notamember123/role`, { role: 'owner' })).statusCode).toBe(404);
      // Demoting a member who already is one is fine.
      expect((await owner.put(`/api/clubs/${club.id}/members/${anaId}/role`, { role: 'member' })).statusCode).toBe(200);
    });

    it('outsiders see none of it (404), and anonymous visitors are asked to sign in (401)', async () => {
      const ozzy = await outsider(t, owner, 'Ozzy');
      for (const res of [
        await ozzy.get(`/api/clubs/${club.id}`),
        await ozzy.patch(`/api/clubs/${club.id}`, { name: 'Mine' }),
        await ozzy.post(`/api/clubs/${club.id}/invite/rotate`),
        await ozzy.delete(`/api/clubs/${club.id}/members/${anaId}`),
        await ozzy.put(`/api/clubs/${club.id}/members/${anaId}/role`, { role: 'owner' }),
        await ozzy.post(`/api/clubs/${club.id}/members/${anaId}/reset-link`),
      ]) {
        expect(res.statusCode).toBe(404);
        expect(errorOf(res)).toEqual({ code: 'not_found', message: 'Club not found.' });
      }
      const anon = t.client();
      for (const res of [await anon.get('/api/clubs'), await anon.post('/api/clubs', { name: 'Anon' }), await anon.get(`/api/clubs/${club.id}`)]) {
        expect(res.statusCode).toBe(401);
      }
    });
  });
});
