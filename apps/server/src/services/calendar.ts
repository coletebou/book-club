import { MEETUP_DEFAULT_MINUTES, stopLabel } from '@bookclub/shared';
import { type BookRow, bookChapters } from '../repos/books';
import { type MeetingRow } from '../repos/meetings';

/**
 * Meet-ups as iCalendar (RFC 5545, D207): one event per meet-up with a day, for a file to open in a
 * calendar app or a feed it subscribes to. The calendar does the reminding (an alarm the day
 * before and an hour before), so the server keeps no schedule of its own. An event says what the
 * app already shows every member on the library page (the book, the club, the stop's name and
 * where), never a chapter's title or anything said in the book.
 */

export interface MeetupEventInput {
  readonly meeting: MeetingRow;
  readonly bookId: string;
  readonly bookTitle: string;
  readonly chapters: ReturnType<typeof bookChapters>;
  readonly clubId: string;
  readonly clubName: string;
}

const CRLF = '\r\n';
const SEQUENCE_EPOCH = Date.UTC(2026, 0, 1);

/** A TEXT value, escaped (RFC 5545 3.3.11). */
export function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** A content line folded at 75 octets, never inside a UTF-8 character (RFC 5545 3.1). */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off continuation bytes (10xxxxxx) so a character is never split.
    while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // each continuation line starts with one space
  }
  return out.join(`${CRLF} `);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An instant as a UTC DATE-TIME: 20261114T003000Z. */
export function icsInstant(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** A calendar day as a DATE: 20261113. */
function icsDay(day: string): string {
  return day.replace(/-/g, '');
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`;
}

function alarm(trigger: string, description: string): string[] {
  return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(description)}`, `TRIGGER:${trigger}`, 'END:VALARM'];
}

/** One meet-up's VEVENT lines, or none when it has no day. */
export function meetupEvent(input: MeetupEventInput, origin: string, host: string, now = Date.now()): string[] {
  const m = input.meeting;
  if (!m.on_day) return [];
  const stop = stopLabel(input.chapters, m.t);
  const bookUrl = `${origin}/books/${input.bookId}`;
  const where =
    m.place_kind === 'voice'
      ? { location: 'The club’s voice room in Book Club', detail: `In the club’s voice room: ${origin}/clubs/${input.clubId}/chat` }
      : m.place_kind === 'link' && m.place
        ? { location: m.place, detail: `Video call: ${m.place}` }
        : m.place_kind === 'place' && m.place
          ? { location: m.place, detail: null }
          : { location: null, detail: null };
  const timed = m.starts_at !== null;
  const summary = timed ? `${input.clubName}: ${input.bookTitle}` : `${input.clubName}: read ${stop} of ${input.bookTitle}`;
  const description = [timed ? `Read to ${stop} before you meet.` : `Read to ${stop}.`, where.detail, bookUrl].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VEVENT',
    `UID:meetup-${input.bookId}@${host}`,
    `DTSTAMP:${icsInstant(now)}`,
    `LAST-MODIFIED:${icsInstant(m.set_at)}`,
    // A meet-up is one event that moves: a newer state carries a higher sequence (whole seconds).
    `SEQUENCE:${Math.max(0, Math.floor((m.set_at - SEQUENCE_EPOCH) / 1000))}`,
  ];
  if (timed) {
    const start = m.starts_at!;
    lines.push(`DTSTART:${icsInstant(start)}`, `DTEND:${icsInstant(start + (m.minutes ?? MEETUP_DEFAULT_MINUTES) * 60_000)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${icsDay(m.on_day)}`, `DTEND;VALUE=DATE:${nextDay(m.on_day)}`, 'TRANSP:TRANSPARENT');
  }
  lines.push(`SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(description)}`);
  if (where.location) lines.push(`LOCATION:${icsText(where.location)}`);
  lines.push(`URL:${bookUrl}`);
  if (timed) {
    lines.push(...alarm('-P1D', `Tomorrow: ${summary}`), ...alarm('-PT1H', `In an hour: ${summary}`));
  } else {
    // The day before, at nine in the morning (an all-day event starts at midnight).
    lines.push(...alarm('-PT15H', `Tomorrow: read ${stop} of ${input.bookTitle}`));
  }
  lines.push('END:VEVENT');
  return lines;
}

/** A whole calendar: its events, folded and CRLF-terminated. */
export function icsCalendar(events: readonly string[][], name: string | null): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Book Club//Meet-ups//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (name) lines.push(`X-WR-CALNAME:${icsText(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H');
  for (const e of events) lines.push(...e);
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** The input for one book's meet-up. */
export function meetupInput(meeting: MeetingRow, book: BookRow, clubName: string): MeetupEventInput {
  return { meeting, bookId: book.id, bookTitle: book.title, chapters: bookChapters(book), clubId: book.club_id, clubName };
}
