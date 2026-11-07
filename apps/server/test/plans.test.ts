import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ClubDetail, ClubDetailSchema } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPlan } from '../src/services/plans';
import { ALICE_EPUB, ALICE_PDF, type Client, PASSWORD, type TestApp, closeApp, fileFrom, joinClub, makeTestApp, setupOwner, uploadBook } from './helpers';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GB = 1024 ** 3;

/** A declared import of one file, as the upload dialog starts one (the file itself never sent). */
const declare = (c: Client, clubId: string, size: number, kind: 'epub' | 'pdf' = 'epub') =>
  c.post(`/api/clubs/${clubId}/imports`, { kind, files: [{ name: `book.${kind}`, size, type: kind === 'epub' ? 'application/epub+zip' : 'application/pdf', role: 'main' }] });

describe('a club’s plan and what it allows (D208)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;

  const detail = async (c: Client = owner) => ClubDetailSchema.parse(await c.json(c.get(`/api/clubs/${club.id}`), 200));

  beforeAll(async () => {
    t = await makeTestApp({
      // Room for one small book (with its cover) and not a second; three members on the free plan.
      CLUB_FREE_STORAGE_GB: String(400_000 / GB),
      CLUB_FREE_MEMBERS_MAX: '3',
      CLUB_PRO_STORAGE_GB: '1',
      CLUB_PRO_MEMBERS_MAX: '5',
      CLUB_PRO_URL: 'https://pay.example/b/club-pro?prefilled_email=',
    });
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('every member sees the plan and what it uses; only an owner gets the way to Club Pro, naming the club', async () => {
    const mine = (await detail()).plan;
    expect(mine).toMatchObject({ name: 'free', until: null, storage: { usedBytes: 0, maxBytes: 400_000 }, members: { count: 2, max: 3 } });
    const url = new URL(mine.proUrl!);
    expect(`${url.origin}${url.pathname}`).toBe('https://pay.example/b/club-pro');
    expect(url.searchParams.get('client_reference_id')).toBe(club.id);
    expect(url.searchParams.has('prefilled_email')).toBe(true);
    expect((await detail(ana)).plan.proUrl).toBeNull();
  });

  it('a book that fits is taken, and counts', async () => {
    await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    const used = (await detail()).plan.storage.usedBytes;
    expect(used).toBeGreaterThanOrEqual(189_249);
    expect(used).toBeLessThan(400_000);
  });

  it('one that does not fit is refused before a byte is sent, saying how much room is left and where more is', async () => {
    const res = await declare(ana, club.id, 221_210, 'pdf');
    expect(res.statusCode).toBe(413);
    const error = res.json<{ error: { code: string; message: string } }>().error;
    expect(error.code).toBe('storage_full');
    expect(error.message).toMatch(/^This club has room for [\d.]+ KB more, and this is 216 KB\./);
    expect(error.message).toContain('Club Pro');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM imports WHERE club_id = ? AND kind = ?', [club.id, 'pdf'])?.n).toBe(0);
    // The real file, the same way.
    await expect(uploadBook(ana, club.id, 'pdf', [fileFrom(ALICE_PDF, 'main', 'application/pdf')], { title: 'Alice', author: 'Lewis Carroll' })).rejects.toThrow(/413/);
  });

  it('an upload under way holds its room, so two at once cannot both take the last of it; cancelled, it frees it', async () => {
    const free = 400_000 - (await detail()).plan.storage.usedBytes;
    const first = await owner.json<{ id: string }>(declare(owner, club.id, free - 1000), 201);
    expect((await declare(ana, club.id, 2000)).statusCode).toBe(413);
    expect((await owner.delete(`/api/imports/${first.id}`)).statusCode).toBe(204);
    const second = await ana.json<{ id: string }>(declare(ana, club.id, 2000), 201);
    expect((await ana.delete(`/api/imports/${second.id}`)).statusCode).toBe(204);
  });

  it('a book removed from the club gives its room back', async () => {
    const books = await owner.json<{ id: string }[]>(owner.get(`/api/clubs/${club.id}/books`), 200);
    expect((await owner.delete(`/api/books/${books[0]!.id}`)).statusCode).toBe(204);
    expect((await detail()).plan.storage.usedBytes).toBe(0);
    await uploadBook(ana, club.id, 'pdf', [fileFrom(ALICE_PDF, 'main', 'application/pdf')], { title: 'Alice', author: 'Lewis Carroll' });
  });

  it('a full club takes nobody new: no account is made for a signup, and an account in no club is turned away', async () => {
    await joinClub(t, club, 'Ben');
    expect((await detail()).plan.members).toEqual({ count: 3, max: 3 });
    const res = await t.client().post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: 'Cleo', email: 'cleo@example.com', password: PASSWORD });
    expect(res.statusCode).toBe(409);
    const full = res.json<{ error: { code: string; message: string } }>().error;
    expect(full.code).toBe('club_full');
    expect(full.message).toContain('its 3 members');
    expect(t.ctx.db.get('SELECT id FROM users WHERE email = ?', ['cleo@example.com'])).toBeUndefined();
    // Someone with an account elsewhere: the same.
    const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Elsewhere' }), 201);
    const dan = await joinClub(t, other, 'Dan');
    const accept = await dan.post(`/api/invites/${club.invite!.code}/accept`);
    expect(accept.statusCode).toBe(409);
    expect(accept.json<{ error: { code: string } }>().error.code).toBe('club_full');
    // A member already in it following the link again just goes in.
    expect((await ana.post(`/api/invites/${club.invite!.code}/accept`)).statusCode).toBe(200);
  });

  it('signups at once for the last place: one gets in, the rest are turned away, none past the limit', async () => {
    const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Two places' }), 201);
    // The owner and First hold two of its three places: one is left, and five ask for it at once.
    await joinClub(t, other, 'First');
    const tries = await Promise.all(
      ['Gus', 'Hal', 'Ivy', 'Jo', 'Kit'].map((name) =>
        t.client().post('/api/auth/signup', { inviteCode: other.invite!.code, displayName: name, email: `${name.toLowerCase()}@race.example`, password: PASSWORD }),
      ),
    );
    expect(tries.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(tries.filter((r) => r.statusCode === 409).every((r) => r.json<{ error: { code: string } }>().error.code === 'club_full')).toBe(true);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memberships WHERE club_id = ?', [other.id])?.n).toBe(3);
    // Nobody turned away was given an account.
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@race.example'")?.n).toBe(1);
  });

  it('Club Pro raises both limits, and the way to it is no longer offered; past its day, the free limits are back', async () => {
    expect(setPlan(t.ctx.db, club.id, 'pro', null)).toBe(true);
    const pro = (await detail()).plan;
    expect(pro).toMatchObject({ name: 'pro', until: null, storage: { maxBytes: GB }, members: { count: 3, max: 5 }, proUrl: null });
    await joinClub(t, club, 'Cleo');
    expect((await declare(owner, club.id, 1_000_000)).statusCode).toBe(201);
    setPlan(t.ctx.db, club.id, 'pro', Date.now() - 1);
    const lapsed = (await detail()).plan;
    expect(lapsed).toMatchObject({ name: 'free', until: null, members: { count: 4, max: 3 } });
    expect(lapsed.proUrl).not.toBeNull();
    // Nothing is taken away: the four stay, and the club just takes nobody new.
    expect((await t.client().post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: 'Eve', email: 'eve@example.com', password: PASSWORD })).statusCode).toBe(409);
    setPlan(t.ctx.db, club.id, 'pro', Date.now() + 86_400_000);
    const renewed = (await detail()).plan;
    expect(renewed.name).toBe('pro');
    expect(typeof renewed.until).toBe('string');
  });

  it('the server’s own command lists every club’s plan and use, and puts a club on a plan', () => {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], { cwd: SERVER, encoding: 'utf8', env: { ...process.env, DATA_DIR: t.dir, LOG_LEVEL: 'silent' } });
    const done = cli('club-plan', '--club', club.id, '--plan', 'pro', '--until', '2099-12-31');
    expect(done.stderr).toBe('');
    expect(done.stdout).toBe(`club ${club.id} is on Club Pro through 2099-12-31\n`);
    const listing = cli('clubs');
    expect(listing.status).toBe(0);
    expect(listing.stdout).toMatch(new RegExp(`^${club.id}\\tpro until 2100-01-01\\t4 members\\t[\\d.]+ (KB|MB)\\tThursday Readers$`, 'm'));
    expect(cli('club-plan', '--club', club.id, '--plan', 'free').stdout).toBe(`club ${club.id} is on the free plan\n`);
    expect(cli('club-plan', '--club', club.id, '--plan', 'gold').status).toBe(1);
    expect(cli('club-plan', '--club', club.id, '--plan', 'free', '--until', '2099-12-31').status).toBe(1);
    expect(cli('club-plan', '--club', 'nope-nope', '--plan', 'pro').stderr).toContain('no club nope-nope');
  });
});

describe('an instance whose host sets no limits (D208)', () => {
  let t: TestApp;
  afterAll(async () => {
    await closeApp(t);
  });

  it('allows any size and any number, and offers no Club Pro', async () => {
    t = await makeTestApp();
    const { owner, club } = await setupOwner(t);
    const plan = ClubDetailSchema.parse(await owner.json(owner.get(`/api/clubs/${club.id}`), 200)).plan;
    expect(plan).toEqual({ name: 'free', until: null, storage: { usedBytes: 0, maxBytes: null }, members: { count: 1, max: null }, proUrl: null });
    const big = await owner.json<{ id: string }>(declare(owner, club.id, 3 * GB), 201);
    expect((await owner.delete(`/api/imports/${big.id}`)).statusCode).toBe(204);
  });
});
