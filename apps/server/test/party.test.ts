import { PartyStateSchema, type BookDetail, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALICE_EPUB,
  type Client,
  type TestApp,
  bookDetail,
  closeApp,
  fileFrom,
  joinClub,
  makeTestApp,
  openSocket,
  setupOwner,
  uploadBook,
} from './helpers';

describe('listening together (D155-D158)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let book: BookDetail;
  let editionId: string;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
    editionId = book.editions.find((e) => e.kind === 'epub')!.id;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('starts, is joinable, and nobody has one before it starts', async () => {
    const none = await owner.get(`/api/books/${book.id}/party`);
    expect(none.json()).toBeNull();

    const started = PartyStateSchema.parse(await owner.json(owner.post(`/api/books/${book.id}/party/start`, { editionId }), 200));
    expect(started.hostId).toBeDefined();
    expect(started.playing).toBe(false);
    expect(started.members).toHaveLength(1);

    const joined = PartyStateSchema.parse(await ana.json(ana.post(`/api/books/${book.id}/party/join`, {}), 200));
    expect(joined.members.map((m) => m.displayName).sort()).toEqual(['Ana', 'Cole']);
  });

  it('play/pause/seek/rate mutate the server clock, and only the host may when host-only is set', async () => {
    await owner.post(`/api/books/${book.id}/party/control`, { action: 'settings', settings: { hostOnlyControls: true } });
    const anaTriesPlay = await ana.post(`/api/books/${book.id}/party/control`, { action: 'play' });
    expect(anaTriesPlay.statusCode).toBe(403);

    const played = PartyStateSchema.parse(await owner.json(owner.post(`/api/books/${book.id}/party/control`, { action: 'play' }), 200));
    expect(played.playing).toBe(true);

    const sought = PartyStateSchema.parse(await owner.json(owner.post(`/api/books/${book.id}/party/control`, { action: 'seek', track: 0, position: 120 }), 200));
    expect(sought.position).toBe(120);

    const rated = PartyStateSchema.parse(await owner.json(owner.post(`/api/books/${book.id}/party/control`, { action: 'rate', rate: 1.5 }), 200));
    expect(rated.rate).toBe(1.5);

    await owner.post(`/api/books/${book.id}/party/control`, { action: 'settings', settings: { hostOnlyControls: false } });
  });

  it("pauses for everyone on an interruption and resumes after quiet (fed fake speaker events over the hub)", async () => {
    await owner.post(`/api/books/${book.id}/party/control`, {
      action: 'settings',
      settings: { autoPause: true, autoPauseSensitivityMs: 40, autoResume: true, autoResumeAfterMs: 60, rewindOnResumeMs: 0 },
    });
    await owner.post(`/api/books/${book.id}/party/control`, { action: 'play' });

    const socket = await openSocket(t, ana);
    socket.send({ type: 'subscribe', clubId: club.id });
    await socket.next('presence', (m) => m.clubId === club.id);

    socket.send({ type: 'party:speaking', clubId: club.id, bookId: book.id, speaking: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    socket.send({ type: 'party:speaking', clubId: club.id, bookId: book.id, speaking: true });

    const paused = await socket.next('party:state', (m) => m.bookId === book.id && m.state.paused?.reason === 'interruption');
    expect(paused.state.playing).toBe(false);
    expect(paused.state.paused?.by).toBe('Ana');

    socket.send({ type: 'party:speaking', clubId: club.id, bookId: book.id, speaking: false });
    const resumed = await socket.next('party:state', (m) => m.bookId === book.id && m.state.playing === true, 5000);
    expect(resumed.state.paused).toBeNull();
    await socket.close();
  });

  it('the host leaving hands off to another member, and loses control until they rejoin (PR #13 review)', async () => {
    const before = PartyStateSchema.parse(await owner.json(owner.get(`/api/books/${book.id}/party`), 200));
    expect(before.hostId).toBe(before.members.find((m) => m.displayName === 'Cole')!.userId);

    const ownerLeave = await owner.post(`/api/books/${book.id}/party/leave`, {});
    expect(ownerLeave.statusCode).toBe(204);

    const afterHostLeft = PartyStateSchema.parse(await ana.json(ana.get(`/api/books/${book.id}/party`), 200));
    expect(afterHostLeft.members.map((m) => m.displayName)).toEqual(['Ana']);
    expect(afterHostLeft.hostId).toBe(afterHostLeft.members[0]!.userId); // host handed to the only remaining member

    // The ex-host, though still a club member, is no longer in the party and may not control it,
    // host-only or not: this is what used to stay bound to `hostId` forever.
    const ownerTriesPlay = await owner.post(`/api/books/${book.id}/party/control`, { action: 'play' });
    expect(ownerTriesPlay.statusCode).toBe(403);

    const rejoined = PartyStateSchema.parse(await owner.json(owner.post(`/api/books/${book.id}/party/join`, {}), 200));
    expect(rejoined.members.map((m) => m.displayName).sort()).toEqual(['Ana', 'Cole']);
    expect(rejoined.hostId).toBe(afterHostLeft.hostId); // rejoining does not restore the old host

    // Rejoined as an ordinary member (not host), the ex-host may still issue non-host-only
    // controls (hostOnlyControls is false here), but not take host-only actions.
    await ana.post(`/api/books/${book.id}/party/control`, { action: 'settings', settings: { hostOnlyControls: true } });
    const ownerStillNotHost = await owner.post(`/api/books/${book.id}/party/control`, { action: 'play' });
    expect(ownerStillNotHost.statusCode).toBe(403);
    await ana.post(`/api/books/${book.id}/party/control`, { action: 'settings', settings: { hostOnlyControls: false } });
  });

  it('leaving removes you, and the last member leaving ends the party', async () => {
    const leave = await ana.post(`/api/books/${book.id}/party/leave`, {});
    expect(leave.statusCode).toBe(204);
    const stillRunning = PartyStateSchema.parse(await owner.json(owner.get(`/api/books/${book.id}/party`), 200));
    expect(stillRunning.members.map((m) => m.displayName)).toEqual(['Cole']);

    const ownerLeave = await owner.post(`/api/books/${book.id}/party/leave`, {});
    expect(ownerLeave.statusCode).toBe(204);
    const gone = await owner.get(`/api/books/${book.id}/party`);
    expect(gone.json()).toBeNull();
  });
});
