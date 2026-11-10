import { formatNames } from '../format';
import { formatDay } from './meeting';

/**
 * The meet-up (D224): the next stop's day may have a time, how long it runs, and a place. A time is
 * an instant, set in its setter's time zone; each friend sees it on their own clock, and, when they
 * are somewhere else, on the setter's too. Day names and clock times are spelled out here rather
 * than by the engine's locale data, which differs between browsers (as `formatDay` does).
 */

/** How long a meet-up runs when nobody said: an evening's talk. */
export const MEETUP_DEFAULT_MINUTES = 90;
/** The call opens this long before a meet-up in the club's voice room starts… */
export const MEETUP_CALL_EARLY_MS = 15 * 60_000;
/** …and stays offered this long after it was due to end. */
export const MEETUP_CALL_LATE_MS = 60 * 60_000;

export type MeetupPlaceKind = 'voice' | 'place' | 'link';
export type RsvpAnswer = 'yes' | 'maybe' | 'no';

/** Whether a name is a time zone this engine knows ("Europe/London"). */
export function isTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The device's own time zone, or UTC when it cannot say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const partsFormats = new Map<string, Intl.DateTimeFormat>();

/** An instant's calendar day and clock time in a time zone. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  let format = partsFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    partsFormats.set(tz, format);
  }
  const parts: Record<string, number> = {};
  for (const p of format.formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute! };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar day ("2026-11-13") an instant falls on in a time zone. */
export function localDayIn(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The instant a day and a clock time ("2026-11-13", "19:30") name in a time zone: the wall clock
 * less the zone's offset there. A time the clocks repeat (the hour after they go back) is one of
 * its two real instants; a time they skip (the hour they jump forward) is read with the offset from
 * before the jump, so it lands where the clock reads an hour later (02:30 becomes 03:30).
 */
export function zonedInstant(day: string, time: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  /** The zone's offset (its wall clock less UTC) at an instant, to the minute. */
  const offsetAt = (ms: number) => {
    const p = zonedParts(ms, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  const reads = (ms: number) => offsetAt(ms) + Math.floor(ms / 60_000) * 60_000 === wanted;
  const first = wanted - offsetAt(wanted);
  const second = wanted - offsetAt(first);
  if (reads(second)) return second;
  if (reads(first)) return first;
  // Skipped by a jump forward: the earlier offset is the smaller one, whichever side of UTC.
  return wanted - Math.min(offsetAt(first), offsetAt(second));
}

/** A clock time the way friends say it: "8 pm", "7:30 pm", "noon", "midnight". */
export function formatClock(hour: number, minute: number): string {
  if (minute === 0 && hour === 12) return 'noon';
  if (minute === 0 && hour === 0) return 'midnight';
  const h = hour % 12 || 12;
  return `${h}${minute ? `:${pad(minute)}` : ''} ${hour < 12 ? 'am' : 'pm'}`;
}

/** The place in a time zone's name: "New York" for America/New_York. */
export function zoneCity(tz: string): string {
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

/**
 * When a meet-up is, for someone in `viewerTz`: "Thursday, 8 pm", "tomorrow, 7:30 pm",
 * "Thursday 13 November, 8 pm"; with the setter's own clock when theirs reads differently:
 * "Thursday, 2 pm (8 pm in London)".
 */
export function formatMeetupWhen(at: string, tz: string | null, viewerTz: string, now = new Date()): string {
  const ms = Date.parse(at);
  const mine = zonedParts(ms, viewerTz);
  const when = `${formatDay(localDayIn(ms, viewerTz), now)}, ${formatClock(mine.hour, mine.minute)}`;
  if (!tz || tz === viewerTz) return when;
  const theirs = zonedParts(ms, tz);
  if (theirs.hour === mine.hour && theirs.minute === mine.minute && theirs.day === mine.day) return when;
  return `${when} (${formatClock(theirs.hour, theirs.minute)} in ${zoneCity(tz)})`;
}

/** Whether the club's voice room is the place to be right now for a meet-up held there. */
export function meetupCallOpen(at: string | null, minutes: number | null, nowMs = Date.now()): boolean {
  if (!at) return false;
  const start = Date.parse(at);
  const end = start + (minutes ?? MEETUP_DEFAULT_MINUTES) * 60_000;
  return nowMs >= start - MEETUP_CALL_EARLY_MS && nowMs <= end + MEETUP_CALL_LATE_MS;
}

/** Whether a meet-up with a time is over (with its call's grace), so nobody is asked to come any more. */
export function meetupOver(at: string | null, minutes: number | null, nowMs = Date.now()): boolean {
  if (!at) return false;
  return nowMs > Date.parse(at) + (minutes ?? MEETUP_DEFAULT_MINUTES) * 60_000 + MEETUP_CALL_LATE_MS;
}

/** The occasion an answer is for: the meet-up's time, else its day (D224). Null: nothing to answer yet. */
export function meetupOccasion(meeting: { readonly at: string | null; readonly on: string | null }): string | null {
  if (meeting.at) return `at:${Date.parse(meeting.at)}`;
  if (meeting.on) return `day:${meeting.on}`;
  return null;
}

export const RSVP_LABELS: Readonly<Record<RsvpAnswer, string>> = { yes: 'Coming', maybe: 'Maybe', no: 'Can’t make it' };

/**
 * Who is coming, for a line under the meet-up: "Ana and Ben are coming · Cleo maybe · Dan can’t";
 * yourself as "you". Empty when nobody has answered.
 */
export function rsvpSummary(rsvps: readonly { readonly userId: string; readonly displayName: string; readonly answer: RsvpAnswer }[], selfId?: string): string {
  const names = (answer: RsvpAnswer) => rsvps.filter((r) => r.answer === answer).map((r) => (r.userId === selfId ? 'you' : r.displayName));
  const coming = names('yes');
  const maybe = names('maybe');
  const no = names('no');
  const parts: string[] = [];
  if (coming.length > 0) {
    const plural = coming.length > 1 || coming[0] === 'you';
    parts.push(`${capitalise(formatNames(coming, 3))} ${plural ? 'are' : 'is'} coming`);
  }
  if (maybe.length > 0) parts.push(`${parts.length ? formatNames(maybe, 3) : capitalise(formatNames(maybe, 3))} maybe`);
  if (no.length > 0) parts.push(`${parts.length ? formatNames(no, 3) : capitalise(formatNames(no, 3))} can’t`);
  return parts.join(' · ');
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
