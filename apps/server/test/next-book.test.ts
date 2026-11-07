import { ApiErrorSchema, ClubDetailSchema, NextBookStateSchema, type ClubDetail, type NextBookState } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE_EPUB, type Client, fileFrom, type Res, type TestApp, closeApp, joinClub, makeTestApp, openSocket, outsider, setupOwner, uploadBook } from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

describe('picking the next book (D214)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;

  const state = async (c: Client): Promise<NextBookState> => NextBookStateSchema.parse(await c.json(c.get(`/api/clubs/${club.id}/next-book`), 200));
  const clubOf = async (c: Client): Promise<ClubDetail> => ClubDetailSchema.parse(await c.json(c.get(`/api/clubs/${club.id}`), 200));

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('a club starts with no open round, no Up next and no history', async () => {
    const s = await state(owner);
    expect(s.round).toBeNull();
    expect(s.upNext).toBeNull();
    expect(s.history).toEqual([]);
  });

  it('friends with the club open hear of a new nomination at once (D214)', async () => {
    const socket = await openSocket(t, ben);
    try {
      socket.send({ type: 'subscribe', clubId: club.id });
      const res = await ana.post(`/api/clubs/${club.id}/nominations`, { title: 'Watched live' });
      expect(res.statusCode).toBe(201);
      await socket.next('club:changed', (m) => m.clubId === club.id);
    } finally {
      await socket.close();
    }
    const s = await state(ben);
    expect(s.round!.nominations.some((n) => n.title === 'Watched live')).toBe(true);
    // Withdraw it again so the rest of this suite starts from the same fixture it expected.
    const id = s.round!.nominations.find((n) => n.title === 'Watched live')!.id;
    expect((await ana.delete(`/api/nominations/${id}`)).statusCode).toBe(204);
  });

  it('nominating opens a round; the nomination carries title, author, link and pitch', async () => {
    const res = await ana.post(`/api/clubs/${club.id}/nominations`, {
      title: 'Piranesi',
      author: 'Susanna Clarke',
      link: 'https://www.goodreads.com/book/show/50202953',
      pitch: 'A strange house, a kind narrator, and a mystery worth sitting with.',
    });
    expect(res.statusCode).toBe(201);
    const s = NextBookStateSchema.parse(res.json());
    expect(s.round).not.toBeNull();
    expect(s.round!.status).toBe('open');
    expect(s.round!.openedBy).toMatchObject({ displayName: 'Ana' });
    expect(s.round!.nominations).toHaveLength(1);
    expect(s.round!.nominations[0]).toMatchObject({
      title: 'Piranesi',
      author: 'Susanna Clarke',
      link: 'https://www.goodreads.com/book/show/50202953',
      pitch: 'A strange house, a kind narrator, and a mystery worth sitting with.',
      createdBy: { displayName: 'Ana' },
      votes: 0,
      voters: [],
      votedByMe: false,
    });
  });

  it('rejects a title-less nomination, and a link that is not http(s)', async () => {
    expect((await ana.post(`/api/clubs/${club.id}/nominations`, { title: '  ' })).statusCode).toBe(400);
    const res = await ana.post(`/api/clubs/${club.id}/nominations`, { title: 'X', link: 'javascript:alert(1)' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).fields).toHaveProperty('link');
  });

  it('a second nomination lands in the same open round, title and author optional besides', async () => {
    const res = await ben.post(`/api/clubs/${club.id}/nominations`, { title: 'The Fraud' });
    expect(res.statusCode).toBe(201);
    const s = NextBookStateSchema.parse(res.json());
    expect(s.round!.nominations.map((n) => n.title).sort()).toEqual(['Piranesi', 'The Fraud']);
    const fraud = s.round!.nominations.find((n) => n.title === 'The Fraud')!;
    expect(fraud.author).toBeNull();
    expect(fraud.link).toBeNull();
    expect(fraud.pitch).toBeNull();
  });

  it('a second "open a round" call is harmless: still the same one round', async () => {
    const res = await owner.post(`/api/clubs/${club.id}/rounds/open`);
    expect(res.statusCode).toBe(200);
    const s = NextBookStateSchema.parse(res.json());
    expect(s.round!.nominations).toHaveLength(2);
  });

  it('approval voting: any member backs any number of nominations; counts and voters show; voting again is harmless', async () => {
    const piranesi = (await state(owner)).round!.nominations.find((n) => n.title === 'Piranesi')!.id;
    const fraud = (await state(owner)).round!.nominations.find((n) => n.title === 'The Fraud')!.id;
    await owner.put(`/api/nominations/${piranesi}/vote`);
    await ben.put(`/api/nominations/${piranesi}/vote`);
    await ben.put(`/api/nominations/${piranesi}/vote`); // again: harmless
    await ana.put(`/api/nominations/${fraud}/vote`);

    const s = await state(ana);
    const p = s.round!.nominations.find((n) => n.id === piranesi)!;
    expect(p.votes).toBe(2);
    expect(p.voters.map((v) => v.displayName).sort()).toEqual(['Ben', 'Cole']);
    expect(p.votedByMe).toBe(false); // Ana voted for The Fraud, not Piranesi
    const f = s.round!.nominations.find((n) => n.id === fraud)!;
    expect(f.votes).toBe(1);
    expect(f.votedByMe).toBe(true);

    // Ben changes his mind: unvotes Piranesi, votes The Fraud too.
    await ben.delete(`/api/nominations/${piranesi}/vote`);
    await ben.put(`/api/nominations/${fraud}/vote`);
    const s2 = await state(ana);
    expect(s2.round!.nominations.find((n) => n.id === piranesi)!.votes).toBe(1);
    expect(s2.round!.nominations.find((n) => n.id === fraud)!.votes).toBe(2);
  });

  it('the nominator edits their own; nobody else may', async () => {
    const fraud = (await state(owner)).round!.nominations.find((n) => n.title === 'The Fraud')!.id;
    expect((await ana.patch(`/api/nominations/${fraud}`, { pitch: 'Zadie Smith, a courtroom, a real Victorian scandal.' })).statusCode).toBe(403);
    const res = await ben.patch(`/api/nominations/${fraud}`, { author: 'Zadie Smith', pitch: 'Zadie Smith, a courtroom, a real Victorian scandal.' });
    expect(res.statusCode).toBe(200);
    const s = NextBookStateSchema.parse(res.json());
    expect(s.round!.nominations.find((n) => n.id === fraud)).toMatchObject({ author: 'Zadie Smith', pitch: 'Zadie Smith, a courtroom, a real Victorian scandal.' });
  });

  it('withdrawing is the nominator’s own; the owner may remove any other', async () => {
    const extra = await ana.post(`/api/clubs/${club.id}/nominations`, { title: 'A third option' });
    const extraId = (NextBookStateSchema.parse(extra.json()).round!.nominations.find((n) => n.title === 'A third option')!).id;
    expect((await ben.delete(`/api/nominations/${extraId}`)).statusCode).toBe(403);
    expect((await ana.delete(`/api/nominations/${extraId}`)).statusCode).toBe(204);
    expect((await state(owner)).round!.nominations.some((n) => n.id === extraId)).toBe(false);

    const fraud = (await state(owner)).round!.nominations.find((n) => n.title === 'The Fraud')!.id;
    expect((await ana.delete(`/api/nominations/${fraud}`)).statusCode).toBe(403); // not hers, not owner
    expect((await owner.delete(`/api/nominations/${fraud}`)).statusCode).toBe(204); // owner may remove any
    expect((await state(owner)).round!.nominations.some((n) => n.id === fraud)).toBe(false);
  });

  it('closing with a single most-voted nomination needs no choice; it becomes Up next and the round joins history', async () => {
    const roundId = (await state(owner)).round!.id;
    // Only Piranesi is left, with Ben's lone vote on it now (The Fraud is gone).
    expect((await ana.post(`/api/clubs/${club.id}/rounds/${roundId}/close`)).statusCode).toBe(200);
    const s = await state(owner);
    expect(s.round).toBeNull();
    expect(s.upNext).toMatchObject({ title: 'Piranesi', author: 'Susanna Clarke' });
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({ status: 'closed', closedBy: { displayName: 'Ana' } });
    expect(s.history[0]!.winnerNominationId).not.toBeNull();

    // Shown on the club page too, with a way into the picker (the library page reads this field).
    expect((await clubOf(ben)).upNext).toMatchObject({ title: 'Piranesi' });
  });

  it('a closed round refuses new nominations, edits, withdrawals and votes', async () => {
    const closedRoundId = (await state(owner)).history[0]!.id;
    const winnerId = (await state(owner)).history[0]!.winnerNominationId!;
    expect((await ana.post(`/api/clubs/${club.id}/rounds/${closedRoundId}/close`)).statusCode).toBe(409);
    expect((await ana.patch(`/api/nominations/${winnerId}`, { title: 'Nope' })).statusCode).toBe(409);
    expect((await ana.delete(`/api/nominations/${winnerId}`)).statusCode).toBe(409);
    expect((await ana.put(`/api/nominations/${winnerId}/vote`)).statusCode).toBe(409);
  });

  it('the owner marks Up next done; a member cannot', async () => {
    const res = await ben.post(`/api/clubs/${club.id}/nominations`, { title: 'Next round starts' });
    expect(res.statusCode).toBe(201); // nominating opens a fresh round even with Up next still set
    expect((await ben.delete(`/api/clubs/${club.id}/up-next`)).statusCode).toBe(403);
    expect((await owner.delete(`/api/clubs/${club.id}/up-next`)).statusCode).toBe(204);
    expect((await state(owner)).upNext).toBeNull();
  });

  it('a tie is broken by whoever closes, among the tied; an outside choice is refused', async () => {
    const roundId = (await state(owner)).round!.id;
    const a = (await state(owner)).round!.nominations.find((n) => n.title === 'Next round starts')!.id;
    const bRes = await ana.post(`/api/clubs/${club.id}/nominations`, { title: 'Tied contender' });
    const b = NextBookStateSchema.parse(bRes.json()).round!.nominations.find((n) => n.title === 'Tied contender')!.id;
    await owner.put(`/api/nominations/${a}/vote`);
    await owner.put(`/api/nominations/${b}/vote`);

    const noChoice = await ben.post(`/api/clubs/${club.id}/rounds/${roundId}/close`);
    expect(noChoice.statusCode).toBe(400);
    expect(errorOf(noChoice).fields).toHaveProperty('winnerNominationId');

    const wrongChoice = await ben.post(`/api/clubs/${club.id}/rounds/${roundId}/close`, { winnerNominationId: 'not-a-real-id-xx' });
    expect(wrongChoice.statusCode).toBe(400);

    const res = await ben.post(`/api/clubs/${club.id}/rounds/${roundId}/close`, { winnerNominationId: b });
    expect(res.statusCode).toBe(200);
    const s = NextBookStateSchema.parse(res.json());
    expect(s.upNext).toMatchObject({ title: 'Tied contender' });
    expect(s.history.find((r) => r.id === roundId)!.winnerNominationId).toBe(b);
  });

  it('a round with nothing nominated closes with no winner', async () => {
    await owner.post(`/api/clubs/${club.id}/rounds/open`);
    const roundId = (await state(owner)).round!.id;
    const res = await owner.post(`/api/clubs/${club.id}/rounds/${roundId}/close`);
    expect(res.statusCode).toBe(200);
    const s = NextBookStateSchema.parse(res.json());
    expect(s.history.find((r) => r.id === roundId)!.winnerNominationId).toBeNull();
  });

  it('only the owner or whoever opened a round may close it', async () => {
    await ana.post(`/api/clubs/${club.id}/rounds/open`);
    const roundId = (await state(owner)).round!.id;
    const res = await ben.post(`/api/clubs/${club.id}/rounds/${roundId}/close`);
    expect(res.statusCode).toBe(403);
    expect((await ana.post(`/api/clubs/${club.id}/rounds/${roundId}/close`)).statusCode).toBe(200);
  });

  it('a round is closed only through its own club’s path: another club’s id in the URL is refused', async () => {
    await ana.post(`/api/clubs/${club.id}/rounds/open`);
    const roundId = (await state(owner)).round!.id;
    // A second, unrelated club (outsider() makes one to put Stu in); its own id is not this round's.
    const stu = await outsider(t, owner, 'Stu2');
    const otherClubId = (await stu.json<{ id: string }[]>(stu.get('/api/clubs'), 200))[0]!.id;
    const res = await owner.post(`/api/clubs/${otherClubId}/rounds/${roundId}/close`);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({ code: 'bad_request', message: 'That round belongs to another club.' });
    // Untouched: still open, under its own club.
    expect((await state(owner)).round!.id).toBe(roundId);
    expect((await owner.post(`/api/clubs/${club.id}/rounds/${roundId}/close`)).statusCode).toBe(200);
  });

  it('is the club’s own: an outsider finds no round and no nominations, and nobody signed out may touch it', async () => {
    const stranger = await outsider(t, owner, 'Stu');
    const res = await ana.post(`/api/clubs/${club.id}/nominations`, { title: 'Members only' });
    const nomId = NextBookStateSchema.parse(res.json()).round!.nominations.find((n) => n.title === 'Members only')!.id;

    expect((await stranger.get(`/api/clubs/${club.id}/next-book`)).statusCode).toBe(404);
    expect((await stranger.post(`/api/clubs/${club.id}/nominations`, { title: 'Sneaky' })).statusCode).toBe(404);
    expect((await stranger.put(`/api/nominations/${nomId}/vote`)).statusCode).toBe(404);
    expect((await stranger.delete(`/api/nominations/${nomId}`)).statusCode).toBe(404);

    const anon = t.client();
    expect((await anon.get(`/api/clubs/${club.id}/next-book`)).statusCode).toBe(401);
    expect((await anon.post(`/api/clubs/${club.id}/nominations`, { title: 'Nope' })).statusCode).toBe(401);
  });

  it('adding a book of a different title leaves Up next alone; adding a matching one clears it (D214/D215)', async () => {
    await owner.post(`/api/clubs/${club.id}/rounds/open`);
    const roundId = (await state(owner)).round!.id;
    const nom = await ana.post(`/api/clubs/${club.id}/nominations`, { title: 'Piranesi (again)' });
    const nomId = NextBookStateSchema.parse(nom.json()).round!.nominations.find((n) => n.title === 'Piranesi (again)')!.id;
    await owner.put(`/api/nominations/${nomId}/vote`);
    await owner.post(`/api/clubs/${club.id}/rounds/${roundId}/close`);
    expect((await state(owner)).upNext).toMatchObject({ title: 'Piranesi (again)' });

    await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Something else entirely', author: 'Nobody' });
    expect((await state(owner)).upNext).toMatchObject({ title: 'Piranesi (again)' });

    await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Piranesi (again)', author: 'Susanna Clarke' });
    expect((await state(owner)).upNext).toBeNull();
  });
});
