import { ApiErrorSchema } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { type Client, type Res, type TestApp, closeApp, fileOf, makeEpub, makeTestApp, rawRequest, setupOwner, uploadBook } from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

describe('HTTP platform behaviour', () => {
  let t: TestApp;
  let owner: Client;

  let clubId: string;

  beforeAll(async () => {
    t = await makeTestApp();
    let club;
    ({ owner, club } = await setupOwner(t));
    clubId = club.id;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('has a health check', async () => {
    const res = await t.client().get('/healthz');
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
  });

  it('never lets API responses be cached, and sends the security headers', async () => {
    for (const res of [await owner.get('/api/me'), await t.client().get('/api/session'), await t.client().get('/api/me')]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      // camera and microphone are allowed from this app's own pages only (D140: media notes).
      expect(res.headers['permissions-policy']).toBe('camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
    }
  });

  it('answers unknown routes with a JSON 404 naming the route (without its query)', async () => {
    const res = await owner.get('/api/nothing-here?secret=1');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toEqual({ code: 'not_found', message: 'No route for GET /api/nothing-here' });
  });

  it('turns malformed JSON into a 400 in the API’s error format', async () => {
    const res = await owner.post('/api/clubs', '{"name": ', { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('bad_request');
  });

  it('refuses bodies over 1 MiB (413) and unknown content types (415)', async () => {
    const big = await owner.post('/api/clubs', JSON.stringify({ name: 'x', description: 'y'.repeat(1024 * 1024) }), { 'content-type': 'application/json' });
    expect(big.statusCode).toBe(413);
    expect(errorOf(big).message).toBe('Request body is too large');
    const xml = await owner.post('/api/clubs', '<club/>', { 'content-type': 'application/xml' });
    expect(xml.statusCode).toBe(415);
    expect(errorOf(xml).code).toBe('bad_request');
  });

  it('reports invalid ids as a 400 with the reason', async () => {
    const res = await owner.get('/api/books/not!an!id');
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({ code: 'bad_request', message: 'Invalid id', fields: { _: 'Invalid id' } });
  });

  it('answers an internal failure with a generic 500 that reveals nothing', async () => {
    const { editionId } = await uploadBook(owner, clubId, 'epub', [fileOf('small.epub', makeEpub(['<p>Hello.</p>']), 'main', 'application/epub+zip')], {
      title: 'Small',
      author: '',
    });
    await t.settle();
    expect((await owner.get(`/api/editions/${editionId}/publication`)).statusCode).toBe(200);
    // Someone deletes the publication from disk behind the server's back.
    rmSync(t.ctx.storage.pubFile(editionId, '.publication.json')!);
    const res = await owner.get(`/api/editions/${editionId}/publication`);
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toEqual({ code: 'internal', message: 'Something went wrong on our side.' });
    expect(res.body).not.toContain(t.dir);
    expect(res.body).not.toContain('ENOENT');
  });

  it('refuses malformed percent-encoding before any route runs', async () => {
    const res = await rawRequest(t.baseUrl, 'GET', '/api/clubs/%E0%A4%A', { cookie: owner.cookieHeader });
    expect(res.statusCode).toBe(400);
  });
});
