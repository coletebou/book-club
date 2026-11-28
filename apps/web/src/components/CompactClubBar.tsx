import { type Meeting, type MemberProgress, type PresenceEntry, formatPercent } from '@bookclub/shared';

export interface BarMember {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;
  readonly t: number;
  readonly label: string;
  readonly live: boolean;
  readonly kind: string | null;
  readonly finished: boolean;
  /** Has opened the book at all (a member who has not waits, faint, at its start). */
  readonly started: boolean;
}

/** Saved progress, overridden by live presence for members reading this book right now. */
export function barMembers(bookId: string, progress: readonly MemberProgress[], presence: ReadonlyMap<string, PresenceEntry>): BarMember[] {
  return progress.map((p) => {
    const live = presence.get(p.userId)?.reading;
    const reading = live && live.bookId === bookId ? live : null;
    return {
      userId: p.userId,
      displayName: p.displayName,
      color: p.color,
      t: reading ? reading.t : p.t,
      label: reading ? reading.label : p.label,
      live: !!reading,
      kind: reading ? reading.kind : p.kind,
      finished: p.finished,
      started: !!reading || p.t > 0 || p.updatedAt !== null,
    };
  });
}

/**
 * Where a member is, in words: where they are reading now, else "Finished" once they have finished
 * (their last page is just short of the very end, which would read "99%"), else their saved place.
 */
export function placeText(m: Pick<BarMember, 'label' | 't' | 'live' | 'finished'>): string {
  if (!m.live && m.finished) return 'Finished';
  return m.label || formatPercent(m.t);
}

export const trackPercent = (t: number) => `${Math.min(100, Math.max(0, t * 100)).toFixed(3)}%`;
export const memberMarkerData = (m: BarMember) => ({ 'data-user': m.userId, 'data-t': m.t.toFixed(6), 'data-live': m.live ? 'true' : 'false' });

/** The library card shows member places and the next stop without the interactive bar (D304). */
export function CompactClubBar({ bookId, members, selfId, meeting }: {
  bookId: string;
  members: readonly BarMember[];
  selfId?: string | undefined;
  meeting?: Meeting | null;
}) {
  return (
    <div className="club-bar club-bar-compact" data-testid="club-bar" data-book={bookId}>
      <div className="club-bar-track">
        {meeting ? <span className="club-bar-meeting" style={{ left: trackPercent(meeting.t) }} aria-hidden="true" data-testid="meeting-flag" /> : null}
        {[...members]
          .sort((a, b) => a.t - b.t)
          .map((m) => (
            <span
              key={m.userId}
              className={`club-bar-marker${m.userId === selfId ? ' is-self' : ''}${m.live ? ' is-live' : ''}${m.started ? '' : ' is-unstarted'}`}
              style={{ left: trackPercent(m.t), background: m.color }}
              data-testid="member-marker"
              {...memberMarkerData(m)}
              title={`${m.userId === selfId ? 'You' : m.displayName}: ${placeText(m)}`}
              aria-hidden="true"
            />
          ))}
      </div>
    </div>
  );
}
