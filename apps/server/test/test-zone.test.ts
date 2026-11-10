import { describe, expect, it } from 'vitest';

/** The zone the tests run in is pinned (D225) in this package's vitest.config.ts. */
const pinned = process.env.BOOKCLUB_TEST_TZ || 'UTC';

describe('the zone the tests run in (D225)', () => {
  it('is UTC, the server’s own, whatever the machine’s own, unless BOOKCLUB_TEST_TZ names another', () => {
    // Compared as ICU names it, which may be an older alias (Asia/Kolkata is Asia/Calcutta).
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(new Intl.DateTimeFormat('en-US', { timeZone: pinned }).resolvedOptions().timeZone);
  });

  it('is the zone the Date functions read too, not only Intl', () => {
    // Midnight UTC is still the evening before west of Greenwich: the Club Pro date that read a day
    // early on a laptop in New York and right in CI.
    const midnight = new Date(Date.UTC(2027, 10, 8));
    const there = new Intl.DateTimeFormat('en-US', { timeZone: pinned, day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(midnight);
    const part = (type: string) => Number(there.find((p) => p.type === type)!.value);
    expect([midnight.getDate(), midnight.getHours()]).toEqual([part('day'), part('hour')]);
  });
});
