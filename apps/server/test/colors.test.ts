import { type BookProgress, type ClubDetail, type CommentView, MEMBER_PALETTE } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Client,
  type TestApp,
  bookDetail,
  closeApp,
  fileOf,
  joinClub,
  makeEpub,
  makeTestApp,
  openSocket,
  setupOwner,
  uploadBook,
} from './helpers';

/** Friends tell each other apart on the club bar by colour: within a club, no two share one. */
describe('member colours', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;

  const idOf = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/me'), 200)).user.id;
  const detail = (c: Client = owner) => c.json<ClubDetail>(c.get(`/api/clubs/${club.id}`), 200);
  const colorOf = async (userId: string) => (await detail()).members.find((m) => m.userId === userId)?.color;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('gives everyone in a club of up to eight a colour of their own, in the order they join', async () => {
    const friends = ['Ana', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus'];
    for (const name of friends) await joinClub(t, club, name);
    const members = (await detail()).members;
    expect(members.map((m) => m.displayName)).toEqual(['Cole', ...friends]);
    expect(members.map((m) => m.color)).toEqual([...MEMBER_PALETTE]);
  });

  it('keeps colours when someone leaves, and gives the freed one to the next to join', async () => {
    const before = await detail();
    const ben = before.members.find((m) => m.displayName === 'Ben')!;
    expect((await owner.delete(`/api/clubs/${club.id}/members/${ben.userId}`)).statusCode).toBe(204);
    // Removing someone renews the invite link: friends join with the new one.
    club = await detail();
    const hal = await joinClub(t, club, 'Hal');
    const after = await detail();
    for (const m of after.members.filter((x) => x.displayName !== 'Hal')) {
      expect(m.color).toBe(before.members.find((x) => x.userId === m.userId)!.color);
    }
    expect(await colorOf(await idOf(hal))).toBe(ben.color);
  });

  it('shares colours in turn past eight members', async () => {
    const ivy = await joinClub(t, club, 'Ivy');
    const members = (await detail()).members;
    expect(members).toHaveLength(9);
    expect(MEMBER_PALETTE).toContain(await colorOf(await idOf(ivy)));
  });

  it('uses the same colour for a member’s progress, notes and presence', async () => {
    const bookClub = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Two of us' }), 201);
    const ana = await joinClub(t, bookClub, 'Anya');
    const anaId = await idOf(ana);
    const { bookId } = await uploadBook(owner, bookClub.id, 'epub', [fileOf('small.epub', makeEpub(['<p>One.</p>', '<p>Two.</p>']), 'main', 'application/epub+zip')], {
      title: 'Small',
      author: 'Someone',
    });
    await t.settle();
    const book = await bookDetail(owner, bookId);
    const epub = book.editions[0]!;
    const anaColor = (await owner.json<ClubDetail>(owner.get(`/api/clubs/${bookClub.id}`), 200)).members.find((m) => m.userId === anaId)!.color;
    expect(anaColor).toBe(MEMBER_PALETTE[1]);

    const note = await ana.json<CommentView>(
      ana.post(`/api/books/${bookId}/comments`, { editionId: epub.id, locator: { kind: 'epub', section: 0, offset: 0 }, text: 'Hello', clientId: 'c_colour_1' }),
      201,
    );
    expect(note.color).toBe(anaColor);
    const seenByOwner = (await owner.json<CommentView[]>(owner.get(`/api/books/${bookId}/comments`), 200)).find((c) => c.id === note.id)!;
    expect(seenByOwner.color).toBe(anaColor);

    const progress = await owner.json<BookProgress>(owner.get(`/api/books/${bookId}/progress`), 200);
    expect(progress.members.find((m) => m.userId === anaId)!.color).toBe(anaColor);

    const socket = await openSocket(t, owner);
    socket.send({ type: 'subscribe', clubId: bookClub.id });
    const snapshot = await socket.next('presence', (m) => m.clubId === bookClub.id);
    expect(snapshot.members.find((m) => m.userId === anaId)!.color).toBe(anaColor);
    socket.ws.close();

    // Once Anya has left the club, her note keeps a colour (her own), and nobody else's.
    expect((await owner.delete(`/api/clubs/${bookClub.id}/members/${anaId}`)).statusCode).toBe(204);
    const after = (await owner.json<CommentView[]>(owner.get(`/api/books/${bookId}/comments`), 200)).find((c) => c.id === note.id)!;
    expect(MEMBER_PALETTE).toContain(after.color);
  });
});
