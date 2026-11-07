import { describe, expect, it } from 'vitest';
import { foldLine, icsCalendar, icsInstant, icsText } from '../src/services/calendar';

describe('iCalendar text (RFC 5545, D207)', () => {
  it('escapes what TEXT must', () => {
    expect(icsText('Ana’s; then the pub, maybe\\or not\nfine')).toBe('Ana’s\\; then the pub\\, maybe\\\\or not\\nfine');
    expect(icsText('a\r\nb\rc')).toBe('a\\nb\\nc');
  });

  it('folds long lines at 75 octets and never inside a character', () => {
    const short = 'SUMMARY:Thursday Readers: Alice';
    expect(foldLine(short)).toBe(short);
    const long = `DESCRIPTION:${'é'.repeat(80)}`;
    const folded = foldLine(long);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    for (const line of lines.slice(1)) expect(line.startsWith(' ')).toBe(true);
    // Unfolding gives the line back, every character whole.
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    expect(folded).not.toContain('�');
  });

  it('writes instants in UTC and ends every line with CRLF', () => {
    expect(icsInstant(Date.parse('2026-11-14T00:30:05Z'))).toBe('20261114T003005Z');
    const cal = icsCalendar([], 'Book Club meet-ups');
    expect(cal).toBe(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Book Club//Meet-ups//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:Book Club meet-ups\r\nREFRESH-INTERVAL;VALUE=DURATION:PT1H\r\nX-PUBLISHED-TTL:PT1H\r\nEND:VCALENDAR\r\n',
    );
  });
});
