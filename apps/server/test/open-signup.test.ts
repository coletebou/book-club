import { type ClubDetail, type SessionInfo, type User } from '@bookclub/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { type TestApp, PASSWORD, closeApp, makeTestApp } from './helpers';

/** D211: "Start a club" with no invite at all, behind OPEN_SIGNUP (off unless a deployment opts in). */
describe('OPEN_SIGNUP off (the default)', () => {
  let t: TestApp;

  afterAll(async () => {
    await closeApp(t);
  });

  it('says so in the public config, and the route is not there at all', async () => {
    t = await makeTestApp();
    const c = t.client();
    const session = await c.json<SessionInfo>(c.get('/api/session'), 200);
    expect(session.openSignup).toBe(false);
    const res = await c.post('/api/auth/start', { displayName: 'Nora', email: 'nora@example.com', password: PASSWORD, clubName: 'Nora’s club' });
    expect(res.statusCode).toBe(404);
  });
});

describe('OPEN_SIGNUP on', () => {
  let t: TestApp;

  afterAll(async () => {
    await closeApp(t);
  });

  it('says so in the public config', async () => {
    t = await makeTestApp({ OPEN_SIGNUP: 'true' });
    const c = t.client();
    const session = await c.json<SessionInfo>(c.get('/api/session'), 200);
    expect(session.openSignup).toBe(true);
  });

  it('makes the account and a first club, owned, with its own invite link, and signs them in, all in one request', async () => {
    const c = t.client();
    const res = await c.post('/api/auth/start', { displayName: 'Nora', email: 'nora@example.com', password: PASSWORD, clubName: 'Thursday Readers' });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ user: User; clubId: string }>();
    expect(body.user.displayName).toBe('Nora');
    // Signed in: the session cookie this set already works, no separate sign-in call.
    const session = await c.json<SessionInfo>(c.get('/api/session'), 200);
    expect(session.user?.id).toBe(body.user.id);
    const club = await c.json<ClubDetail>(c.get(`/api/clubs/${body.clubId}`), 200);
    expect(club.name).toBe('Thursday Readers');
    expect(club.role).toBe('owner');
    expect(club.memberCount).toBe(1);
    expect(club.invite?.url).toContain(`/join/${club.invite?.code}`);
  });

  it('refuses a second account at an email already in use', async () => {
    const c = t.client();
    const first = await c.post('/api/auth/start', { displayName: 'Milo', email: 'milo@example.com', password: PASSWORD, clubName: 'Milo’s club' });
    expect(first.statusCode).toBe(201);
    const again = t.client();
    const res = await again.post('/api/auth/start', { displayName: 'Someone else', email: 'Milo@example.com', password: PASSWORD, clubName: 'Another club' });
    expect(res.statusCode).toBe(409);
    expect((res.json<{ error: { code: string } }>()).error.code).toBe('email_taken');
    // Nothing of the rejected attempt stuck: no second club, no session for "again".
    expect((await again.get('/api/me')).statusCode).toBe(401);
  });

  it('reuses the password and club-name rules the rest of the app has', async () => {
    const c = t.client();
    const weakPassword = await c.post('/api/auth/start', { displayName: 'Pat', email: 'pat@example.com', password: 'too short', clubName: 'Pat’s club' });
    expect(weakPassword.statusCode).toBe(400);
    expect((weakPassword.json<{ error: { fields: Record<string, string> } }>()).error.fields.password).toMatch(/at least/i);
    const noClubName = await c.post('/api/auth/start', { displayName: 'Pat', email: 'pat@example.com', password: PASSWORD, clubName: '  ' });
    expect(noClubName.statusCode).toBe(400);
  });

});

describe('OPEN_SIGNUP rate limiting', () => {
  it('is rate-limited per address, more tightly than joining with an invite (D211)', async () => {
    // Its own app and its own fresh limiter: the budget above is shared with every other request
    // this describe's own client made, including the ones that only failed validation.
    const limited = await makeTestApp({ OPEN_SIGNUP: 'true' });
    try {
      const c = limited.client();
      let last: { statusCode: number } = { statusCode: 201 };
      for (let i = 0; i < 5; i++) {
        last = await c.post('/api/auth/start', { displayName: 'Ray', email: `ray-${i}@example.com`, password: PASSWORD, clubName: `Ray's club ${i}` });
      }
      expect(last.statusCode).toBe(201);
      const sixth = await c.post('/api/auth/start', { displayName: 'Ray', email: 'ray-6@example.com', password: PASSWORD, clubName: "Ray's club 6" });
      expect(sixth.statusCode).toBe(429);
    } finally {
      await closeApp(limited);
    }
  });
});
