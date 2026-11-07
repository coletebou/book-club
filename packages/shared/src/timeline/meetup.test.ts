import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatMeetupWhen,
  isTimeZone,
  localDayIn,
  meetupCallOpen,
  meetupOccasion,
  meetupOver,
  rsvpSummary,
  zoneCity,
  zonedInstant,
  zonedParts,
} from './meetup';

const NY = 'America/New_York';

describe('meet-up times (D206)', () => {
  it('knows a time zone from a made-up one', () => {
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone('Europe/London; DROP TABLE')).toBe(false);
  });

  it('finds the day and clock of an instant where it is seen', () => {
    const ms = Date.parse('2026-11-14T00:30:00Z');
    expect(localDayIn(ms, NY)).toBe('2026-11-13');
    expect(localDayIn(ms, 'Europe/London')).toBe('2026-11-14');
    expect(zonedParts(ms, NY)).toEqual({ year: 2026, month: 11, day: 13, hour: 19, minute: 30 });
    expect(zonedParts(Date.parse('2026-11-13T05:00:00Z'), NY).hour).toBe(0);
  });

  it('turns a day and a clock time in a zone into the instant, either side of a clock change', () => {
    expect(new Date(zonedInstant('2026-11-13', '19:30', NY)).toISOString()).toBe('2026-11-14T00:30:00.000Z');
    // Summer time in New York (UTC-4) until 1 November 2026.
    expect(new Date(zonedInstant('2026-10-29', '19:30', NY)).toISOString()).toBe('2026-10-29T23:30:00.000Z');
    expect(new Date(zonedInstant('2026-07-01', '08:00', 'Europe/London')).toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(new Date(zonedInstant('2026-11-13', '00:00', 'Asia/Kolkata')).toISOString()).toBe('2026-11-12T18:30:00.000Z');
    // 02:30 on 8 March 2026 does not exist in New York (the clocks jump from 2 to 3): an hour later.
    expect(zonedParts(zonedInstant('2026-03-08', '02:30', NY), NY)).toMatchObject({ day: 8, hour: 3, minute: 30 });
    // East of UTC too: 01:30 on 29 March 2026 does not exist in London.
    expect(zonedParts(zonedInstant('2026-03-29', '01:30', 'Europe/London'), 'Europe/London')).toMatchObject({ day: 29, hour: 2, minute: 30 });
    // 01:30 on 1 November 2026 happens twice there: a real 01:30 either way.
    expect(zonedParts(zonedInstant('2026-11-01', '01:30', NY), NY)).toMatchObject({ day: 1, hour: 1, minute: 30 });
  });

  it('says a clock time the way friends do', () => {
    expect(formatClock(20, 0)).toBe('8 pm');
    expect(formatClock(19, 30)).toBe('7:30 pm');
    expect(formatClock(9, 5)).toBe('9:05 am');
    expect(formatClock(12, 0)).toBe('noon');
    expect(formatClock(0, 0)).toBe('midnight');
    expect(formatClock(12, 30)).toBe('12:30 pm');
    expect(formatClock(0, 15)).toBe('12:15 am');
    expect(zoneCity('America/New_York')).toBe('New York');
  });

  it('says when a meet-up is on your clock, and on its setter’s when that reads differently', () => {
    const now = new Date(2026, 10, 10, 12); // a Tuesday, where the tests run
    const at = '2026-11-14T00:30:00.000Z';
    const mine = formatMeetupWhen(at, NY, NY, now);
    expect(mine).toMatch(/, 7:30 pm$/);
    expect(mine).not.toContain('(');
    expect(formatMeetupWhen(at, NY, 'Europe/London', now)).toMatch(/, 12:30 am \(7:30 pm in New York\)$/);
    expect(formatMeetupWhen(at, null, 'Europe/London', now)).toMatch(/, 12:30 am$/);
    // Same clock elsewhere (Toronto keeps New York's time): no second clock.
    expect(formatMeetupWhen(at, NY, 'America/Toronto', now)).not.toContain('(');
  });

  it('opens the call a quarter of an hour early and keeps it an hour after the end', () => {
    const at = '2026-11-14T00:30:00.000Z';
    const start = Date.parse(at);
    expect(meetupCallOpen(at, 90, start - 16 * 60_000)).toBe(false);
    expect(meetupCallOpen(at, 90, start - 15 * 60_000)).toBe(true);
    expect(meetupCallOpen(at, 90, start + 150 * 60_000)).toBe(true);
    expect(meetupCallOpen(at, 90, start + 151 * 60_000)).toBe(false);
    expect(meetupCallOpen(at, null, start + 150 * 60_000)).toBe(true);
    expect(meetupCallOpen(null, 90, start)).toBe(false);
    expect(meetupOver(at, 90, start + 151 * 60_000)).toBe(true);
    expect(meetupOver(at, 90, start)).toBe(false);
    expect(meetupOver(null, null, start)).toBe(false);
  });

  it('answers are for the time, else the day, else nothing', () => {
    expect(meetupOccasion({ at: '2026-11-14T00:30:00.000Z', on: '2026-11-13' })).toBe(`at:${Date.parse('2026-11-14T00:30:00.000Z')}`);
    expect(meetupOccasion({ at: null, on: '2026-11-13' })).toBe('day:2026-11-13');
    expect(meetupOccasion({ at: null, on: null })).toBeNull();
  });

  it('sums up who is coming', () => {
    const r = (userId: string, answer: 'yes' | 'maybe' | 'no') => ({ userId, displayName: userId, answer });
    expect(rsvpSummary([])).toBe('');
    expect(rsvpSummary([r('Ana', 'yes')])).toBe('Ana is coming');
    expect(rsvpSummary([r('Ana', 'yes'), r('Ben', 'yes')])).toBe('Ana and Ben are coming');
    expect(rsvpSummary([r('Ana', 'yes'), r('me', 'yes')], 'me')).toBe('Ana and you are coming');
    expect(rsvpSummary([r('me', 'yes')], 'me')).toBe('You are coming');
    expect(rsvpSummary([r('Ana', 'yes'), r('Cleo', 'maybe'), r('Dan', 'no')])).toBe('Ana is coming · Cleo maybe · Dan can’t');
    expect(rsvpSummary([r('Cleo', 'maybe')])).toBe('Cleo maybe');
    expect(rsvpSummary([r('A', 'yes'), r('B', 'yes'), r('C', 'yes'), r('D', 'yes')])).toBe('A, B, C and 1 other are coming');
  });
});
