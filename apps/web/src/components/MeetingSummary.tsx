import { type Meeting, type MemberProgress, deviceTimeZone, formatDay, formatMeetupWhen, hasReached, meetupOver } from '@bookclub/shared';
import { Icon } from './Icon';

// Library cards need only these labels and counts. The editor stays with the book routes (D290).
export const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Whether a calendar day ("2026-10-23") is before today. */
function before(day: string, now: Date): boolean {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Whether the meet-up is behind us: its time (and its call) over, or, with only a day, that day gone. */
export function isOver(meeting: Meeting, now: Date): boolean {
  return meeting.at ? meetupOver(meeting.at, meeting.minutes, now.getTime()) : !!meeting.on && before(meeting.on, now);
}

/**
 * "The end of Chapter 2, by Sunday"; with a time (D224), "…, by Thursday, 8 pm" (and the setter's
 * own clock when yours differs, unless `short`); once it has gone by, "…, planned for yesterday".
 */
export function meetingHeadline(meeting: Meeting, now = new Date(), viewerTz = deviceTimeZone(), short = false): string {
  if (meeting.at) {
    const when = formatMeetupWhen(meeting.at, short ? null : meeting.tz, viewerTz, now);
    return `${capitalised(meeting.label)}, ${isOver(meeting, now) ? 'planned for' : 'by'} ${when}`;
  }
  const when = meeting.on ? `, ${before(meeting.on, now) ? 'planned for' : 'by'} ${formatDay(meeting.on, now)}` : '';
  return `${capitalised(meeting.label)}${when}`;
}

/** Who is there already: "2 of 4 there", or "everyone is there". */
export function meetingTally(meeting: Meeting, progress: readonly MemberProgress[]): string {
  const there = progress.filter((p) => hasReached(p, meeting.t)).length;
  return there === progress.length && there > 1 ? 'everyone is there' : `${there} of ${progress.length} there`;
}

/** The library card's line about it, with how many are coming once anyone has said (D224). */
export function MeetingLine({ meeting, progress }: { meeting: Meeting; progress: readonly MemberProgress[] }) {
  const coming = meeting.rsvps.filter((r) => r.answer === 'yes').length;
  return (
    <span className="small meeting-line" data-testid="meeting-line">
      <Icon name="flag" size={14} /> {meetingHeadline(meeting, new Date(), deviceTimeZone(), true)} · {meetingTally(meeting, progress)}
      {coming > 0 ? ` · ${coming} coming` : ''}
    </span>
  );
}
