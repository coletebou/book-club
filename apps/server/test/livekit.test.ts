import { LiveKitConfigSchema, LiveKitTokenResponseSchema, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type TestApp, closeApp, joinClub, makeTestApp, openSocket, outsider, setupOwner } from './helpers';

// Not real credentials: a fixed, low-entropy test fixture (no LiveKit server is ever dialled in
// this suite; only token minting, a pure JWT-signing call, is exercised).
const LIVEKIT_ENV = { LIVEKIT_URL: 'wss://rtc.example.test', LIVEKIT_API_KEY: 'bookclubtest', LIVEKIT_API_SECRET: 'bookclubtest-secret-not-for-real-use' };

describe('LiveKit voice tokens (D153)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;

  beforeAll(async () => {
    t = await makeTestApp(LIVEKIT_ENV);
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('reports itself enabled with the public url, never the key or secret', async () => {
    const res = await t.client().get('/api/livekit/config');
    const config = LiveKitConfigSchema.parse(res.json());
    expect(config).toEqual({ enabled: true, url: 'wss://rtc.example.test' });
    expect(res.body).not.toContain('devsecret');
    expect(res.body).not.toContain('devkey');
  });

  it('mints a token for the club room, scoped to a room name this server built', async () => {
    const res = await ana.post('/api/livekit/token', { clubId: club.id, room: 'club' });
    expect(res.statusCode).toBe(200);
    const token = LiveKitTokenResponseSchema.parse(res.json());
    expect(token.roomName).toBe(`club:${club.id}`);
    expect(token.identity).toBe((await ana.json<{ user: { id: string } }>(ana.get('/api/me'), 200)).user.id);
    expect(token.url).toBe('wss://rtc.example.test');
    // A real JWT (header.payload.signature), never the raw key/secret.
    expect(token.token.split('.')).toHaveLength(3);
  });

  it('mints a distinct room for an ad hoc room, and refuses one with no id', async () => {
    const res = await ana.post('/api/livekit/token', { clubId: club.id, room: 'adhoc', adhocId: 'side-chat' });
    const token = LiveKitTokenResponseSchema.parse(res.json());
    expect(token.roomName).toBe(`club:${club.id}:adhoc:side-chat`);
    const missing = await ana.post('/api/livekit/token', { clubId: club.id, room: 'adhoc' });
    expect(missing.statusCode).toBe(400);
  });

  it('refuses a token for a club you are not a member of (404, never confirming it exists)', async () => {
    const stranger = await outsider(t, owner, 'Oz');
    const res = await stranger.post('/api/livekit/token', { clubId: club.id, room: 'club' });
    expect(res.statusCode).toBe(404);
  });

  it("removing a member from the club ends their voice presence in that club's rooms (PR #13 security review)", async () => {
    const oz = await joinClub(t, club, 'Olive');
    const ozMe = await oz.json<{ user: { id: string } }>(oz.get('/api/me'), 200);
    const ozId = ozMe.user.id;

    const socket = await openSocket(t, oz);
    socket.send({ type: 'subscribe', clubId: club.id });
    await socket.next('presence', (m) => m.clubId === club.id);
    socket.send({ type: 'voice:join', clubId: club.id, room: 'club' });
    await socket.next('voice:update', (m) => m.clubId === club.id && m.state.participants.some((p) => p.userId === ozId));

    expect(t.ctx.hub.voiceRoomsFor(ozId)).toEqual([`club:${club.id}`]);

    const removed = await owner.delete(`/api/clubs/${club.id}/members/${ozId}`);
    expect(removed.statusCode).toBe(204); // succeeds even though LIVEKIT_URL above is unreachable: best effort, never blocking

    // Our own presence bookkeeping for that room is cleared immediately...
    expect(t.ctx.hub.voiceRoomsFor(ozId)).toEqual([]);
    // ...and everyone still in the room is told Oz left.
    await socket.next('voice:update', (m) => m.clubId === club.id && !m.state.participants.some((p) => p.userId === ozId));

    await socket.close();
  });

  it('is reported disabled, and refuses to mint, when LIVEKIT_* is unset', async () => {
    const bare = await makeTestApp();
    const { owner: bareOwner, club: bareClub } = await setupOwner(bare);
    const config = LiveKitConfigSchema.parse((await bareOwner.get('/api/livekit/config')).json());
    expect(config.enabled).toBe(false);
    const res = await bareOwner.post('/api/livekit/token', { clubId: bareClub.id, room: 'club' });
    expect(res.statusCode).toBe(404);
    await closeApp(bare);
  });
});
