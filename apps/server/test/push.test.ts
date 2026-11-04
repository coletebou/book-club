import { generateKeyPairSync } from 'node:crypto';
import http2, { type Http2Server } from 'node:http2';
import { type AddressInfo } from 'node:net';
import { type BookDetail, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, setupOwner, uploadBook, waitUntil } from './helpers';

/*
 * Push to the iOS app (D134): registering a device, and a reply or a friend reaching your note
 * reaching it over APNs, in the same words and to the same place the in-app bell already uses. No
 * real Apple server is reachable here: a fake APNs (plaintext HTTP/2) stands in for it, recording
 * every push sent to it.
 */

const TOKEN = (id: string) => id.repeat(64).slice(0, 64); // 64 hex chars, like a real APNs token

interface Seen {
  path: string;
  topic: string | undefined;
  body: { aps: { alert: { title: string; body: string } }; path: string };
}

function fakeApns(): { server: Http2Server; authority: Promise<string>; requests: Seen[] } {
  const requests: Seen[] = [];
  const server = http2.createServer((req, res) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => {
      requests.push({ path: req.url, topic: req.headers['apns-topic'] as string | undefined, body: JSON.parse(data) as Seen['body'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end();
    });
  });
  const authority = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return { server, authority, requests };
}

describe('device push registration and delivery (D134)', () => {
  let apns: ReturnType<typeof fakeApns>;
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let book: BookDetail;

  beforeAll(async () => {
    apns = fakeApns();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    t = await makeTestApp({
      APNS_KEY_ID: 'KEY1',
      APNS_TEAM_ID: 'TEAM1',
      APNS_BUNDLE_ID: 'com.example.bookclub',
      APNS_PRIVATE_KEY: privateKey,
      APNS_AUTHORITY: await apns.authority,
    });
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
    await new Promise((resolve) => apns.server.close(resolve));
  });

  it('registers a device token for the signed-in user', async () => {
    expect((await ana.post('/api/push/register', { token: TOKEN('a') })).statusCode).toBe(204);
  });

  it('a reply pushes the note author over APNs, worded and linked like the bell', async () => {
    const epub = book.editions[0]!;
    const from = { kind: 'epub' as const, section: 2, offset: 0 };
    const to = { kind: 'epub' as const, section: 2, offset: 400 };
    await ana.json(ana.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);
    const note = await ana.json<{ id: string }>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: from, text: 'A cake with "EAT ME" on it!' }), 201);
    // Ben reading to the note's place pushes Ana once already (notifyReached, "got to your
    // note"); his reply pushes her again right after. `findLast` is the reply, not the reached.
    await ben.json(ben.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);
    await ben.json(ben.post(`/api/comments/${note.id}/replies`, { text: 'She ate it all!', clientId: 'push-reply-1' }), 201);
    // A push is sent after the reply is answered, not before (notifications.ts), so it can land a
    // moment later on a busy machine: wait for it, or the next test counts it as its own.
    const replyPush = () => apns.requests.some((r) => r.path === `/3/device/${TOKEN('a')}` && r.body.aps.alert.body.startsWith('Ben replied'));
    await waitUntil(replyPush, 5000, "the reply's push");

    const delivered = apns.requests.findLast((r) => r.path === `/3/device/${TOKEN('a')}`);
    expect(delivered, `sent: ${apns.requests.map((r) => r.path).join(', ')}`).toBeDefined();
    expect(delivered!.topic).toBe('com.example.bookclub');
    expect(delivered!.body.aps.alert).toMatchObject({ title: 'Alice', body: 'Ben replied: “She ate it all!”' });
    expect(delivered!.body.path).toBe(`/books/${book.id}#note-${note.id}`);
  });

  it('unregistering stops further pushes to that device', async () => {
    const before = apns.requests.length;
    expect((await ana.post('/api/push/unregister', { token: TOKEN('a') })).statusCode).toBe(204);

    const epub = book.editions[0]!;
    const from = { kind: 'epub' as const, section: 3, offset: 0 };
    const to = { kind: 'epub' as const, section: 3, offset: 400 };
    await ana.json(ana.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);
    const note = await ana.json<{ id: string }>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: from, text: 'We are all mad here.' }), 201);
    await ben.json(ben.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);
    await ben.json(ben.post(`/api/comments/${note.id}/replies`, { text: 'Quite mad.', clientId: 'push-reply-2' }), 201);

    expect(apns.requests.length).toBe(before);
  });

  it('a device token cannot be unregistered by anyone but the user who registered it', async () => {
    expect((await ben.post('/api/push/register', { token: TOKEN('b') })).statusCode).toBe(204);
    const held = () => t.ctx.db.get('SELECT 1 AS x FROM push_tokens WHERE token = ?', [TOKEN('b')]);
    expect(held()).toEqual({ x: 1 });
    // Ana cannot drop Ben's device by guessing its token.
    expect((await ana.post('/api/push/unregister', { token: TOKEN('b') })).statusCode).toBe(204);
    expect(held()).toEqual({ x: 1 });
    // Ben can.
    expect((await ben.post('/api/push/unregister', { token: TOKEN('b') })).statusCode).toBe(204);
    expect(held()).toBeUndefined();
  });
});

describe('push stays off with APNS_* unset (D134)', () => {
  it('still accepts a registration (so a token already kept is ready the day a key is added)', async () => {
    const t = await makeTestApp();
    const { club } = await setupOwner(t);
    const ana = await joinClub(t, club, 'Ana');
    expect((await ana.post('/api/push/register', { token: TOKEN('c') })).statusCode).toBe(204);
    expect(t.ctx.push).toBeNull();
    expect(t.ctx.db.get('SELECT 1 AS x FROM push_tokens WHERE token = ?', [TOKEN('c')])).toEqual({ x: 1 });
    await closeApp(t);
  });
});
