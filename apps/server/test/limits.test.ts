import { type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calBudgetSpent, instanceMonthSpend, logCost, monthSpend } from '../src/cal/store';
import { type Client, type TestApp, closeApp, makeTestApp, setupOwner } from './helpers';

/** D176: starting a club is open to everyone, so what bounds the instance is a cap per person. */
describe('limits once anyone can start a club', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;

  beforeAll(async () => {
    t = await makeTestApp({ CLUBS_OWNED_MAX: '3', CAL_MONTHLY_SPEND_CAP_USD: '5', CAL_INSTANCE_MONTHLY_SPEND_CAP_USD: '8' });
    ({ owner, club } = await setupOwner(t));
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('one person owns at most CLUBS_OWNED_MAX clubs; the next start is 409 club_limit', async () => {
    // Setup already made one; two more reach the cap of three.
    for (const name of ['Second', 'Third']) expect((await owner.post('/api/clubs', { name })).statusCode).toBe(201);
    const res = await owner.post('/api/clubs', { name: 'Fourth' });
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('club_limit');
  });

  it("a club under its own cap still stops once every club's spend together reaches the instance's", () => {
    const db = t.ctx.db;
    const other = db.all<{ id: string }>('SELECT id FROM clubs WHERE id != ?', [club.id])[0]!.id;
    const caps = { club: 5, instance: 8 };
    const spend = (clubId: string, costUsd: number) => logCost(db, { clubId, userId: null, kind: 'chat', provider: 'test', model: 'test', inputUnits: 0, outputUnits: 0, costUsd });

    expect(calBudgetSpent(db, club.id, caps)).toBeNull();
    spend(other, 4.5);
    spend(club.id, 3);
    // This club has spent $3 of its $5, but the instance $7.50 of its $8: still open.
    expect(calBudgetSpent(db, club.id, caps)).toBeNull();
    spend(other, 0.5);
    expect(monthSpend(db, club.id)).toBe(3);
    expect(instanceMonthSpend(db)).toBe(8);
    expect(calBudgetSpent(db, club.id, caps)).toBe('instance');
    // A club over its own cap says so first: the owner can raise that one.
    spend(club.id, 2);
    expect(calBudgetSpent(db, club.id, caps)).toBe('club');
  });
});
