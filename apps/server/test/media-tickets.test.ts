import { type ClubDetail, type Edition, MEDIA_TICKET_HEADER, type MediaTicket } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ALICE_EPUB, SYNTHETIC_AUDIO, type Client, type TestApp, audioTracks, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, setupOwner, uploadBook } from './helpers';
import { MEDIA_TICKET_MS } from '../src/auth/media-tickets';

/**
 * The iOS app's audio player sends no session cookie (AppleCoreMedia; D219), so a track it streams
 * is opened by a media ticket in a header: one edition's tracks, for one session, for a while.
 */
describe('media tickets for the native audio player (D219)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let audio: Edition;
  let other: Edition;
  let epubId: string;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    const a = await uploadBook(owner, club.id, 'audio', audioTracks(SYNTHETIC_AUDIO), { title: 'The Synthetic Tale', author: 'Ada Tone' });
    const b = await uploadBook(owner, club.id, 'audio', audioTracks(SYNTHETIC_AUDIO), { title: 'Another Tale', author: 'Ada Tone' });
    const e = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    audio = (await bookDetail(owner, a.bookId)).editions[0]!;
    other = (await bookDetail(owner, b.bookId)).editions[0]!;
    epubId = (await bookDetail(owner, e.bookId)).editions[0]!.id;
  });
  afterAll(async () => { await closeApp(t); });

  const ticketFor = async (c: Client, editionId: string) => c.json<MediaTicket>(c.post('/api/media/ticket', { editionId }), 200);
  /** A request as AVPlayer makes it: no cookie, a Range, the ticket in its header. */
  const asPlayer = (url: string, ticket?: string) =>
    t.client().request({ method: 'GET', url, headers: { range: 'bytes=0-1', ...(ticket ? { [MEDIA_TICKET_HEADER]: ticket } : {}) } });

  it('opens the edition’s tracks with no cookie, ranges and all', async () => {
    expect((await asPlayer(audio.tracks[0]!.url)).statusCode).toBe(401);
    const { ticket, expiresAt } = await ticketFor(owner, audio.id);
    expect(expiresAt - Date.now()).toBeGreaterThan(MEDIA_TICKET_MS - 60_000);
    const res = await asPlayer(audio.tracks[0]!.url, ticket);
    expect(res.statusCode).toBe(206);
    expect(res.headers['cache-control']).toContain('private');
    expect((await asPlayer(audio.tracks[1]!.url, ticket)).statusCode).toBe(206);
  });

  it('opens nothing else: another edition, a book’s file or cover, an API route', async () => {
    const { ticket } = await ticketFor(owner, audio.id);
    expect((await asPlayer(other.tracks[0]!.url, ticket)).statusCode).toBe(401);
    for (const url of [`/media/editions/${audio.id}/file`, `/media/editions/${epubId}/file`, '/api/clubs', `/api/clubs/${club.id}`]) {
      expect((await asPlayer(url, ticket)).statusCode, url).toBe(401);
    }
  });

  it('is refused when forged, altered, expired, or its session has ended', async () => {
    const { ticket } = await ticketFor(owner, audio.id);
    const [hash, edition, until, sig] = ticket.split('.') as [string, string, string, string];
    const url = audio.tracks[0]!.url;
    expect((await asPlayer(url, `${hash}.${edition}.${Number(until) + 1}.${sig}`)).statusCode).toBe(401);
    expect((await asPlayer(url, `${hash}.${other.id}.${until}.${sig}`)).statusCode).toBe(401);
    expect((await asPlayer(url, `${'0'.repeat(64)}.${edition}.${until}.${sig}`)).statusCode).toBe(401);
    expect((await asPlayer(url, 'not a ticket')).statusCode).toBe(401);
    vi.useFakeTimers({ now: Date.now() + MEDIA_TICKET_MS + 1000, toFake: ['Date'] });
    try {
      expect((await asPlayer(url, ticket)).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    // Signing out ends the session, and every ticket it asked for.
    const ben = await joinClub(t, club, 'Ben');
    const bens = await ticketFor(ben, audio.id);
    expect((await asPlayer(url, bens.ticket)).statusCode).toBe(206);
    expect((await ben.post('/api/auth/signout', {})).statusCode).toBeLessThan(300);
    expect((await asPlayer(url, bens.ticket)).statusCode).toBe(401);
  });

  it('is given only to a member of the edition’s club, signed in with a session', async () => {
    expect((await t.client().post('/api/media/ticket', { editionId: audio.id })).statusCode).toBe(401);
    const second = await owner.post('/api/clubs', { name: 'Other' });
    const otherClub = await owner.json<ClubDetail>(owner.get(`/api/clubs/${second.json<{ id: string }>().id}`), 200);
    const outsider = await joinClub(t, otherClub, 'Outsider');
    expect((await outsider.post('/api/media/ticket', { editionId: audio.id })).statusCode).toBe(404);
    expect((await owner.post('/api/media/ticket', { editionId: '../etc' })).statusCode).toBe(400);
    expect((await owner.post('/api/media/ticket', { editionId: audio.id, extra: 1 })).statusCode).toBe(400);
  });

  it('stops opening tracks once its holder has left the club', async () => {
    const cleo = await joinClub(t, club, 'Cleo');
    const { ticket } = await ticketFor(cleo, audio.id);
    expect((await asPlayer(audio.tracks[0]!.url, ticket)).statusCode).toBe(206);
    const me = await cleo.json<{ user: { id: string } }>(cleo.get('/api/session'), 200);
    const removed = await owner.request({ method: 'DELETE', url: `/api/clubs/${club.id}/members/${me.user.id}` });
    expect(removed.statusCode).toBeLessThan(300);
    expect((await asPlayer(audio.tracks[0]!.url, ticket)).statusCode).toBe(404);
  });
});
