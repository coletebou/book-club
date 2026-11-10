import { Suspense, lazy, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type BookDetail,
  type Meeting,
  type MemberProgress,
  type RsvpAnswer,
  RSVP_LABELS,
  chaptersToGo,
  deviceTimeZone,
  formatDay,
  formatMeetupWhen,
  formatNames,
  formatRoughDuration,
  hasReached,
  localDayIn,
  meetupCallOpen,
  meetupOccasion,
  meetupOver,
  rsvpSummary,
  timeToGo,
  zonedInstant,
  zonedParts,
} from '@bookclub/shared';
import { api } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { keys } from '../lib/queries';
import { stopChoices } from '../lib/stop-titles';
import { Field, FormError, fieldErrors } from './Form';
import { Icon } from './Icon';
import { Modal } from './Modal';

/**
 * The club's next stop (D53): how far to read before talking it over, and perhaps by when. A
 * place on the shared timeline, so a reader and a listener each see how far they have to go, and
 * it gives nothing away: it is a chapter's end, never what happens there. As a meet-up (D224) it
 * may also say at what time, where (the club's voice room, a place, a video call) and who is coming.
 */

// The voice room's bar brings LiveKit with it: loaded only while a meet-up's call is open.
const VoiceBar = lazy(() => import('../live/VoiceBar').then((m) => ({ default: m.VoiceBar })));

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Whether a calendar day ("2026-10-23") is before today. */
function before(day: string, now: Date): boolean {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Whether the meet-up is behind us: its time (and its call) over, or, with only a day, that day gone. */
function isOver(meeting: Meeting, now: Date): boolean {
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

/** One member's way to it: "there", "2 chapters to go", "almost there". */
function wayToGo(book: BookDetail, meeting: Meeting, p: MemberProgress): string {
  if (hasReached(p, meeting.t)) return 'there';
  const n = chaptersToGo(book.chapters, p.furthest, meeting.t);
  return n === 0 ? 'almost there' : `${n} ${n === 1 ? 'chapter' : 'chapters'} to go`;
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

/** Where the meet-up is, as a line: the voice room, a place, or a video call's link. */
function MeetupPlaceLine({ meeting }: { meeting: Meeting }) {
  const place = meeting.place;
  if (!place) return null;
  if (place.kind === 'voice') {
    return (
      <p className="small meetup-place" data-testid="meetup-place">
        <Icon name="headphones" size={16} /> In the club’s voice room
      </p>
    );
  }
  if (place.kind === 'link') {
    let host = place.value;
    try {
      host = new URL(place.value).host;
    } catch {
      // shown as given
    }
    return (
      <p className="small meetup-place" data-testid="meetup-place">
        <Icon name="video" size={16} /> Video call:{' '}
        <a href={place.value} target="_blank" rel="noopener noreferrer">
          {host}
        </a>
      </p>
    );
  }
  return (
    <p className="small meetup-place" data-testid="meetup-place">
      <Icon name="pin" size={16} /> {place.value}
    </p>
  );
}

/** Who is coming (D224): your answer, three buttons, and everyone's, in a line. */
function MeetupRsvp({ book, meeting, selfId }: { book: BookDetail; meeting: Meeting; selfId: string | undefined }) {
  const qc = useQueryClient();
  const mine = meeting.rsvps.find((r) => r.userId === selfId)?.answer ?? null;
  const answer = useMutation({
    mutationFn: (a: RsvpAnswer | null) => api.rsvp(book.id, a),
    onSuccess: async (detail) => {
      qc.setQueryData(keys.book(book.id), detail);
      await qc.invalidateQueries({ queryKey: keys.books(book.clubId) });
    },
  });
  const summary = rsvpSummary(meeting.rsvps, selfId);
  return (
    <div className="stack-tight" data-testid="meetup-rsvp">
      <div className="row rsvp-buttons" role="group" aria-label="Are you coming?">
        {(['yes', 'maybe', 'no'] as const).map((a) => (
          <button
            key={a}
            type="button"
            className={`btn btn-small${mine === a ? ' btn-primary' : ''}`}
            aria-pressed={mine === a}
            disabled={answer.isPending}
            onClick={() => answer.mutate(mine === a ? null : a)}
            data-testid={`rsvp-${a}`}
          >
            {mine === a ? <Icon name="check" size={14} /> : null} {RSVP_LABELS[a]}
          </button>
        ))}
      </div>
      <FormError error={answer.error} />
      {summary ? (
        <p className="small muted" data-testid="rsvp-summary">
          {summary}
        </p>
      ) : null}
    </div>
  );
}

/** The book page's card: the stop, who is there, how long you have to go, and a way to change it. */
export function MeetingCard({ book, progress, selfId }: { book: BookDetail; progress: readonly MemberProgress[]; selfId: string | undefined }) {
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const clear = useMutation({
    mutationFn: () => api.clearMeeting(book.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.book(book.id) });
      await qc.invalidateQueries({ queryKey: keys.books(book.clubId) });
    },
  });
  const meeting = book.meeting;
  const now = new Date();
  const mine = progress.find((p) => p.userId === selfId);
  const left = meeting && mine && !hasReached(mine, meeting.t) ? timeToGo(book.editions, mine.furthest, meeting.t) : null;
  const durations = left
    ? [left.readingMs !== null ? `${formatRoughDuration(left.readingMs)} of reading` : null, left.listeningMs !== null ? `${formatRoughDuration(left.listeningMs)} of listening` : null].filter(Boolean)
    : [];
  const answerable = !!meeting && meetupOccasion(meeting) !== null && !isOver(meeting, now);
  const callOpen = meeting?.place?.kind === 'voice' && meetupCallOpen(meeting.at, meeting.minutes, now.getTime());
  return (
    <section aria-labelledby="meeting-title" className="card stack meeting" data-testid="meeting">
      <h2 id="meeting-title">Next stop</h2>
      {meeting ? (
        <>
          <p className="meeting-headline" data-testid="meeting-headline">
            <Icon name="flag" size={18} /> {meetingHeadline(meeting, now)}
          </p>
          <MeetupPlaceLine meeting={meeting} />
          {callOpen ? (
            <div className="stack-tight" data-testid="meetup-call">
              <p className="small">The meet-up is on: join the call.</p>
              <Suspense fallback={null}>
                <VoiceBar clubId={book.clubId} />
              </Suspense>
            </div>
          ) : null}
          {answerable ? <MeetupRsvp book={book} meeting={meeting} selfId={selfId} /> : null}
          <p className="muted small">
            Set by {meeting.setBy.userId === selfId ? 'you' : meeting.setBy.displayName} · {meetingTally(meeting, progress)}
          </p>
          <ul className="member-progress">
            {progress.map((p) => (
              <li key={p.userId} data-testid="meeting-member" data-user={p.userId} data-there={hasReached(p, meeting.t) ? 'true' : 'false'}>
                <span className="dot" style={{ background: p.color }} aria-hidden="true" />
                <span>{p.userId === selfId ? 'You' : p.displayName}</span>
                <span className="muted small">{wayToGo(book, meeting, p)}</span>
              </li>
            ))}
          </ul>
          {durations.length > 0 ? (
            <p className="small" data-testid="meeting-time">
              About {durations.join(' or ')} to go.
            </p>
          ) : null}
          <FormError error={clear.error} />
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => setEditing(true)} data-testid="meeting-change">
              Change
            </button>
            {meeting.on && !isOver(meeting, now) ? (
              <a className="btn btn-small btn-ghost" href={api.meetingIcsUrl(book.id)} download="meet-up.ics" data-testid="meetup-ics">
                <Icon name="calendar" size={16} /> Add to calendar
              </a>
            ) : null}
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => void confirmAction({ title: 'Clear the next stop?', body: 'It goes for everyone in the club.', confirm: 'Clear', cancel: 'Keep it' }).then((yes) => yes && clear.mutate())}
              disabled={clear.isPending}
              data-testid="meeting-clear"
            >
              Clear
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Agree how far to read before you talk it over, and when and where you meet.</p>
          <div>
            <button type="button" className="btn" onClick={() => setEditing(true)} data-testid="meeting-set">
              <Icon name="flag" size={18} /> Choose the next stop
            </button>
          </div>
        </>
      )}
      {editing ? <MeetingModal book={book} progress={progress} selfId={selfId} onClose={() => setEditing(false)} /> : null}
    </section>
  );
}

type PlaceChoice = '' | 'voice' | 'place' | 'link';

const DURATIONS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 90, label: '1 hour 30 minutes' },
  { minutes: 120, label: '2 hours' },
  { minutes: 180, label: '3 hours' },
];

/** The meet-up's time on this device's clock, "19:30", as the time field takes it. */
function clockOf(at: string, tz: string): string {
  const p = zonedParts(Date.parse(at), tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function MeetingModal({ book, progress, selfId, onClose }: { book: BookDetail; progress: readonly MemberProgress[]; selfId: string | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const selectId = useId();
  const durationId = useId();
  const tz = deviceTimeZone();
  const voice = useQuery({ queryKey: keys.livekitConfig, queryFn: () => api.livekitConfig(), staleTime: 3600_000 });
  // Each with its chapter's title, where it has one beyond its number; the stop is saved by its place.
  const stops = stopChoices(book.chapters);
  // A place set some other way (a percentage) stays on the list.
  if (book.meeting && !stops.some((s) => Math.abs(s.t - book.meeting!.t) < 1e-6)) stops.push({ t: book.meeting.t, label: book.meeting.label, text: capitalised(book.meeting.label) });
  stops.sort((a, b) => a.t - b.t);
  const furthest = Math.max(0, ...progress.filter((p) => p.userId === selfId).map((p) => p.furthest));
  const current = book.meeting;
  const [t, setT] = useState(current?.t ?? (stops.find((s) => s.t > furthest + 1e-6) ?? stops[stops.length - 1]!).t);
  // A meet-up with a time is shown, and changed, on this device's own clock.
  const [on, setOn] = useState(current?.at ? localDayIn(Date.parse(current.at), tz) : (current?.on ?? ''));
  const [time, setTime] = useState(current?.at ? clockOf(current.at, tz) : '');
  const [minutes, setMinutes] = useState(current?.minutes ?? 90);
  const [placeKind, setPlaceKind] = useState<PlaceChoice>(current?.place?.kind ?? '');
  const [placeText, setPlaceText] = useState(current?.place && current.place.kind !== 'voice' ? current.place.value : '');
  const [localError, setLocalError] = useState<string | null>(null);
  const voiceOn = voice.data?.enabled === true || placeKind === 'voice';
  const save = useMutation({
    mutationFn: () => {
      const at = on && time ? new Date(zonedInstant(on, time, tz)).toISOString() : null;
      const place = placeKind === 'voice' ? { kind: 'voice' as const, value: '' as const } : placeKind ? { kind: placeKind, value: placeText.trim() } : null;
      return api.setMeeting(book.id, { t, on: on || null, at, tz: at ? tz : null, minutes: at ? minutes : null, place });
    },
    onSuccess: async (detail) => {
      qc.setQueryData(keys.book(book.id), detail);
      await qc.invalidateQueries({ queryKey: keys.books(book.clubId) });
      onClose();
    },
  });
  const errors = fieldErrors(save.error);
  const submit = () => {
    if (time && !on) {
      setLocalError('Choose a day for the time.');
      return;
    }
    setLocalError(null);
    save.mutate();
  };
  const placeOptions: { value: PlaceChoice; label: string }[] = [
    { value: '', label: 'Not decided yet' },
    ...(voiceOn ? [{ value: 'voice' as const, label: 'Our voice room, here in the app' }] : []),
    { value: 'place', label: 'Somewhere: a home, a café' },
    { value: 'link', label: 'A video call' },
  ];
  return (
    <Modal
      title="The next stop"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={submit} disabled={save.isPending} data-testid="meeting-save">
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <div className="form">
        <FormError error={save.error} />
        {localError ? (
          <p className="error" role="alert">
            {localError}
          </p>
        ) : null}
        <div className="field">
          <label htmlFor={selectId}>Read up to</label>
          <select id={selectId} value={String(t)} onChange={(e) => setT(Number(e.target.value))} data-testid="meeting-stop">
            {stops.map((s) => (
              <option key={s.t} value={String(s.t)}>
                {s.text}
              </option>
            ))}
          </select>
        </div>
        <Field label="By (optional)" type="date" value={on} onChange={(e) => setOn(e.target.value)} data-testid="meeting-day" hint="The day you plan to talk it over." error={errors.on} />
        <Field
          label="Time (optional)"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          data-testid="meetup-time"
          hint={`When you meet, on your clock (${tz.replace(/_/g, ' ')}). Friends elsewhere see it on theirs.`}
          error={errors.at ?? errors.tz}
        />
        {time ? (
          <div className="field">
            <label htmlFor={durationId}>For about</label>
            <select id={durationId} value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))} data-testid="meetup-minutes">
              {DURATIONS.map((d) => (
                <option key={d.minutes} value={String(d.minutes)}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <fieldset className="meetup-where">
          <legend>Where</legend>
          {placeOptions.map((o) => (
            <label key={o.value || 'none'}>
              <input type="radio" name="meetup-place" value={o.value} checked={placeKind === o.value} onChange={() => setPlaceKind(o.value)} data-testid={`meetup-place-${o.value || 'none'}`} />{' '}
              {o.label}
            </label>
          ))}
        </fieldset>
        {placeKind === 'place' ? (
          <Field label="The place" value={placeText} onChange={(e) => setPlaceText(e.target.value)} maxLength={200} data-testid="meetup-place-text" hint="An address, or just “Ana’s”." error={errors['place.value'] ?? errors.place} />
        ) : null}
        {placeKind === 'link' ? (
          <Field label="The call’s link" type="url" inputMode="url" value={placeText} onChange={(e) => setPlaceText(e.target.value)} maxLength={500} data-testid="meetup-place-link" hint="https://…" error={errors['place.value'] ?? errors.place} />
        ) : null}
      </div>
    </Modal>
  );
}

/** The club's next stop, just reached by reading or listening, and who else is there. */
export interface MeetingReachedInfo {
  readonly meeting: Meeting;
  /** The friends there already, by name. */
  readonly others: readonly string[];
  /** The friends who have finished the book: past the stop, not waiting at it. */
  readonly finished?: readonly string[];
}

/** The stop as you reach it, with the friends among `members` who have read or heard that far. */
export function meetingReachedInfo(meeting: Meeting, members: readonly MemberProgress[], selfId: string | undefined): MeetingReachedInfo {
  const there = members.filter((m) => m.userId !== selfId && hasReached(m, meeting.t));
  return { meeting, others: there.filter((m) => !m.finished).map((m) => m.displayName), finished: there.filter((m) => m.finished).map((m) => m.displayName) };
}

/**
 * The button for the notes of the chapter just ended, naming whose they are (D92): "Show Ana’s
 * note", "Show Ana’s 2 notes"; from several friends, how many ("Show 3 notes"), and to a screen
 * reader whose too.
 */
export function showNotesLabel(count: number, names: readonly string[] = []): { text: string; name?: string } {
  const one = names.length === 1 ? names[0]! : null;
  if (count === 1) return { text: one ? `Show ${one}’s note` : 'Show the note' };
  if (one) return { text: `Show ${one}’s ${count} notes` };
  const text = `Show ${count} notes`;
  return names.length > 1 ? { text, name: `${text} from ${formatNames(names, names.length)}` } : { text };
}

/**
 * What the stop's card says as you reach it, short enough for a phone's footer beside its buttons
 * (fidelity review round 16: "You're at the next stop. Ana and Cleo are…"): who is there with you,
 * and who has finished the book (past the stop, not waiting at it).
 */
export function meetingReachedLine(others: readonly string[], finished: readonly string[] = []): string {
  const done = finished.length > 0 ? ` ${formatNames(finished)} ${finished.length === 1 ? 'has' : 'have'} finished the book.` : '';
  if (others.length > 0) return `You’re at the next stop, with ${formatNames(others)}.${done}`;
  return done ? `You’re at the next stop.${done}` : 'You’re the first at the next stop.';
}

/** In the reader: you have just read as far as the club's next stop. */
export function MeetingReachedCard({
  meeting,
  others,
  finished = [],
  notes,
  onClose,
}: {
  meeting: Meeting;
  others: readonly string[];
  finished?: readonly string[];
  /** The chapter that just ended had friends' notes (by `names`, its writers): offer them here too. */
  notes: { count: number; names?: readonly string[]; onShow: () => void } | null;
  onClose: () => void;
}) {
  const show = notes ? showNotesLabel(notes.count, notes.names) : null;
  return (
    <div className="chapter-end meeting-reached" role="status" data-testid="meeting-reached">
      <span title={`The club’s next stop: ${meeting.label}`}>
        <Icon name="flag" size={16} /> {meetingReachedLine(others, finished)}
      </span>
      <span className="row">
        {notes && show ? (
          <button type="button" className="btn btn-small btn-primary" onClick={notes.onShow} aria-label={show.name} data-testid="meeting-show-notes">
            {show.text}
          </button>
        ) : null}
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </span>
    </div>
  );
}
