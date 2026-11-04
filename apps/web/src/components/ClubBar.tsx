import { Fragment, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type Chapter, type CommentView, type Meeting, type MemberProgress, type PresenceEntry, type Reaction, REACTION_LABELS, type Span, formatPercent } from '@bookclub/shared';
import { MADE_IN, whyClosed } from '../lib/further';
import { meetingHeadline } from './Meeting';

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

/** " (Shocked 2, Sad 1)": the reactions of a tally, for a screen reader. */
function feelings(tally: readonly { reaction: Reaction | null; count: number }[]): string {
  const named = tally.filter((x) => x.reaction).map((x) => `${REACTION_LABELS[x.reaction!]} ${x.count}`);
  return named.length > 0 ? ` (${named.join(', ')})` : '';
}

/**
 * The reactions in a group of notes, each with how many, the most frequent first (notes without
 * one count as words): friends see "😱 2 😢 1", spoiler-free, as v1's design had it.
 */
export function reactionTally(items: readonly Pick<CommentView, 'reaction'>[]): { reaction: Reaction | null; count: number }[] {
  const counts = new Map<Reaction | null, number>();
  for (const c of items) counts.set(c.reaction ?? null, (counts.get(c.reaction ?? null) ?? 0) + 1);
  // Reactions before words-only notes at the same count: the feeling is what the bar shows.
  return [...counts].map(([reaction, count]) => ({ reaction, count })).sort((a, b) => b.count - a.count || (a.reaction === null ? 1 : 0) - (b.reaction === null ? 1 : 0));
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

/** Chapter ticks closer than this on the bar are drawn as one: a long book's hundreds would be a grey smear. */
export const TICK_GAP_PX = 6;

/**
 * The chapter ticks to draw on a track `width` px wide, none closer than TICK_GAP_PX. Before the
 * track is laid out (no width yet, which is before anything is painted) every one.
 */
export function visibleTicks<T extends { readonly t: number }>(chapters: readonly T[], width: number): T[] {
  if (width <= 0) return [...chapters];
  const shown: T[] = [];
  let last = -Infinity;
  for (const c of chapters) {
    if (c.t * width - last < TICK_GAP_PX) continue;
    shown.push(c);
    last = c.t * width;
  }
  return shown;
}

/** Every tap target on the bar is at least this wide and tall (WCAG 2.5.8 asks for 24 px). */
export const BAR_TARGET_PX = 26;
/** A group of members shows this many of their dots. */
const SHOWN_DOTS = 3;

export interface TrackGroup<T> {
  /** Where the group sits, as a fraction of the track: the mean of its items. */
  readonly t: number;
  readonly items: readonly T[];
}

/**
 * Lay items out along a track `width` px wide so that no two tap targets overlap. Each target is
 * centred on its place and `sizeOf` its items wide (`minGap` for every one unless told otherwise):
 * neighbours whose targets would overlap join one group, at the mean of its items. A group can be
 * drawn wider than its parts (a pill of reactions and counts), so once merged it is checked again
 * against the group before it as well as the next. With no width yet (before layout) every item
 * stands alone.
 */
export function groupOnTrack<T>(items: readonly T[], tOf: (item: T) => number, width: number, minGap = BAR_TARGET_PX, sizeOf: (items: readonly T[]) => number = () => minGap): TrackGroup<T>[] {
  const groups: TrackGroup<T>[] = [...items].sort((a, b) => tOf(a) - tOf(b)).map((item) => ({ t: tOf(item), items: [item] }));
  if (width <= 0) return groups;
  let i = 0;
  while (i + 1 < groups.length) {
    const a = groups[i]!;
    const b = groups[i + 1]!;
    if ((b.t - a.t) * width >= (sizeOf(a.items) + sizeOf(b.items)) / 2) {
      i++;
      continue;
    }
    const merged = [...a.items, ...b.items];
    groups.splice(i, 2, { t: merged.reduce((sum, item) => sum + tOf(item), 0) / merged.length, items: merged });
    if (i > 0) i--;
  }
  return groups;
}

/**
 * The next stop's flag (D53), as app.css draws it: a pole from a pixel before its place and a
 * pennant beside it, this many pixels wide in all, in the notes' lane above the line (FR157): the
 * members' markers, on the line, never meet it.
 */
export const FLAG_PX = { before: 1, after: 10 } as const;

/** What a target keeps clear of the flag by, each side. */
const FLAG_GAP_PX = 1;

/** A group of notes on the track: where it is drawn (a fraction of the track), and its notes. */
export interface NoteTarget<T> {
  readonly t: number;
  readonly items: readonly T[];
}

/**
 * The notes' targets on a track `width` px wide, none over another (groupOnTrack) nor over the next
 * stop's flag at `flagT` (FR157): notes whose targets would cover it gather beside it, those before
 * the stop before it and those at it or after after it (the flag stays at its place), each taking in
 * the groups further out it would then cover, as friends beside your marker do (D90). A side with no
 * room before the track's end (half a target past it) gives its notes to the other. With no width
 * yet, or no stop, as groupOnTrack has them.
 */
export function layoutNotes<T>(items: readonly T[], tOf: (item: T) => number, width: number, flagT: number | null, sizeOf: (items: readonly T[]) => number): NoteTarget<T>[] {
  const groups = groupOnTrack(items, tOf, width, BAR_TARGET_PX, sizeOf);
  if (flagT === null || width <= 0) return groups;
  const lo = flagT * width - FLAG_PX.before - FLAG_GAP_PX;
  const hi = flagT * width + FLAG_PX.after + FLAG_GAP_PX;
  const covers = (g: NoteTarget<T>) => g.t * width + sizeOf(g.items) / 2 > lo + 1e-9 && g.t * width - sizeOf(g.items) / 2 < hi - 1e-9;
  const first = groups.findIndex(covers);
  if (first === -1) return groups;
  const last = groups.findLastIndex(covers);
  const near = groups.slice(first, last + 1).flatMap((g) => g.items);
  let before = near.filter((item) => tOf(item) < flagT - 1e-9);
  let after = near.filter((item) => tOf(item) >= flagT - 1e-9);
  const half = BAR_TARGET_PX / 2;
  if (before.length > 0 && lo - sizeOf(before) < -half) [before, after] = [[], [...before, ...after]];
  else if (after.length > 0 && hi + sizeOf(after) > width + half) [before, after] = [[...before, ...after], []];
  // Beside the flag; the groups further out on that side, nearest first, join it while it covers them.
  let left = first;
  while (before.length > 0 && left > 0) {
    const g = groups[left - 1]!;
    if (g.t * width + sizeOf(g.items) / 2 <= lo - sizeOf(before) + 1e-9) break;
    before = [...g.items, ...before];
    left--;
  }
  let right = last;
  while (after.length > 0 && right + 1 < groups.length) {
    const g = groups[right + 1]!;
    if (g.t * width - sizeOf(g.items) / 2 >= hi + sizeOf(after) - 1e-9) break;
    after = [...after, ...g.items];
    right++;
  }
  return [
    ...groups.slice(0, left),
    ...(before.length > 0 ? [{ t: (lo - sizeOf(before) / 2) / width, items: before }] : []),
    ...(after.length > 0 ? [{ t: (hi + sizeOf(after) / 2) / width, items: after }] : []),
    ...groups.slice(right + 1),
  ];
}

/** What a group of notes shows: its two most frequent reactions with their counts, and how many more. */
export function tallyShown(items: readonly Pick<CommentView, 'reaction'>[]): { shown: { reaction: Reaction | null; count: number }[]; more: number } {
  const tally = reactionTally(items);
  return { shown: tally.slice(0, 2), more: tally.slice(2).reduce((n, x) => n + x.count, 0) };
}

/**
 * What a group of notes shows, in the order it shows it: "😂 2, 😢 1, +2 more". Its name begins
 * with this, so that what is on screen is what a screen reader or speech input calls it (WCAG
 * 2.5.3, label in name); the dot drawn for notes in words is 💬, a note's sign on the listen page.
 */
function tallyText({ shown, more }: ReturnType<typeof tallyShown>): string {
  const parts = shown.map((x) => `${x.reaction ?? '💬'} ${x.count}`);
  if (more > 0) parts.push(`+${more} more`);
  return parts.join(', ');
}

/*
 * The widest the bar's targets are drawn, from the sizes in app.css (.club-bar-comment.is-group,
 * .club-bar-count, .club-bar-dot), rounded up: an emoji at 14 px, a count's digit at 0.68 rem
 * bold. Too wide only groups a little sooner; too narrow lets pills overlap.
 */
const EMOJI_PX = 20;
const DIGIT_PX = 8;
const COUNT_PX = (n: number) => 2 + String(n).length * DIGIT_PX;

/** How wide a group of notes' pill is drawn, at most: padding, each reaction with its count, "+N". */
export function commentTargetPx(items: readonly Pick<CommentView, 'reaction'>[]): number {
  if (items.length <= 1) return BAR_TARGET_PX;
  const { shown, more } = tallyShown(items);
  const parts = shown.map((x) => EMOJI_PX + COUNT_PX(x.count));
  if (more > 0) parts.push(COUNT_PX(more) + DIGIT_PX);
  return Math.max(BAR_TARGET_PX, 4 + 6 + parts.reduce((sum, w) => sum + w, 0) + 4 * (parts.length - 1));
}

/** How wide a group of members is drawn, at most: overlapping dots, "+N" past three. */
export function memberTargetPx(items: readonly unknown[]): number {
  if (items.length <= 1) return BAR_TARGET_PX;
  const dots = Math.min(items.length, SHOWN_DOTS);
  const extra = items.length - SHOWN_DOTS;
  return Math.max(BAR_TARGET_PX, 18 + (dots - 1) * 12 + (extra > 0 ? COUNT_PX(extra) + DIGIT_PX : 0));
}

/** A member's target on the bar: a friend, a group of friends, or you. */
export interface MemberTarget<T> {
  /** Where it is drawn, as a fraction of the track: its friends' mean, beside your marker, or your place. */
  readonly x: number;
  readonly items: readonly T[];
  /** Your own marker: alone, at your place. */
  readonly self: boolean;
}

/**
 * The members' targets on a track `width` px wide, none over another: friends gathered as
 * groupOnTrack gathers them, and your own marker alone and always at your place (D90). Friends
 * whose targets would cover yours join one group beside it, on their side of it where that has
 * room, else on the other, taking in any group it would then cover: on a new book, with everyone
 * at its start, your marker and then the group of friends. A target at the track's end reaches half
 * a target past it, as a marker there always has. With no width yet, everyone at their place.
 */
export function layoutMembers<T>(items: readonly T[], tOf: (item: T) => number, isSelf: (item: T) => boolean, width: number, sizeOf: (items: readonly T[]) => number = memberTargetPx): MemberTarget<T>[] {
  const self = items.find(isSelf);
  const friends: MemberTarget<T>[] = groupOnTrack(
    items.filter((m) => m !== self),
    tOf,
    width,
    BAR_TARGET_PX,
    sizeOf,
  ).map((g) => ({ x: g.t, items: g.items, self: false }));
  if (self === undefined) return friends;
  const s = Math.min(1, Math.max(0, tOf(self)));
  const own: MemberTarget<T> = { x: s, items: [self], self: true };
  const atTheirPlaces = () => [...friends, own].sort((a, b) => a.x - b.x);
  if (width <= 0) return atTheirPlaces();
  const at = s * width;
  const half = BAR_TARGET_PX / 2;
  const covers = (g: MemberTarget<T>) => Math.abs(g.x * width - at) < half + sizeOf(g.items) / 2 - 1e-9;
  const first = friends.findIndex(covers);
  if (first === -1) return atTheirPlaces();
  const last = friends.findLastIndex(covers);
  const near = friends.slice(first, last + 1).flatMap((g) => g.items);
  // Room for a group from your marker's edge to the track's end (half a target past it).
  const room = (side: 1 | -1) => (side === 1 ? width - at : at);
  const mean = near.reduce((sum, m) => sum + tOf(m), 0) / near.length;
  let side: 1 | -1 = mean < tOf(self) ? -1 : 1;
  if (room(side) < sizeOf(near) && room(-side as 1 | -1) >= sizeOf(near)) side = -side as 1 | -1;
  // Beside your marker; the groups further out on that side, nearest first, join it while it covers them.
  let group = near;
  const place = () => (at + side * (half + sizeOf(group) / 2)) / width;
  const outward = side === 1 ? friends.slice(last + 1) : friends.slice(0, first).reverse();
  let taken = 0;
  for (const g of outward) {
    if (Math.abs(g.x - place()) * width >= (sizeOf(group) + sizeOf(g.items)) / 2 - 1e-9) break;
    group = side === 1 ? [...group, ...g.items] : [...g.items, ...group];
    taken++;
  }
  const beside: MemberTarget<T> = { x: place(), items: group, self: false };
  const left = side === 1 ? friends.slice(0, first) : outward.slice(taken).reverse();
  const right = side === 1 ? outward.slice(taken) : friends.slice(last + 1);
  return [...left, ...(side === 1 ? [own, beside] : [beside, own]), ...right];
}

function useWidth(ref: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return width;
}

interface ClubBarProps {
  readonly bookId: string;
  readonly members: readonly BarMember[];
  readonly selfId?: string | undefined;
  readonly chapters?: readonly Chapter[];
  readonly comments?: readonly CommentView[];
  /** The club's next stop (D53), flagged on the line. */
  readonly meeting?: Meeting | null;
  readonly compact?: boolean;
  readonly onSeek?: (t: number) => void;
  /** One note, or the notes of a group too close together to tap one by one. */
  readonly onComments?: (comments: readonly CommentView[]) => void;
  /** What you have read on the timeline: a closed note's place you have read says so (whyClosed). */
  readonly readRanges?: readonly Span[];
}

const KIND_LABEL: Record<string, string> = { epub: 'reading', pdf: 'reading the PDF', audio: 'listening' };

function names(list: readonly string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function commentLabel(c: CommentView, readRanges: readonly Span[] | undefined): string {
  if (!c.hidden) return `${c.authorName}: ${c.reaction ?? ''} ${c.text ?? ''}`.trim();
  const what = `${c.authorName} ${c.reaction ? `reacted ${c.reaction}` : 'left a note'}`;
  const why = whyClosed(c, readRanges);
  // Here, but written from further on (D69): it opens when you get to where its writer was.
  if (why === 'held') return `${what} from ${c.horizon}`;
  // Made in another format about here: it opens a little further on (D63).
  if (why === 'near') return `${what} ${MADE_IN[c.kind]} about here, open a little further on`;
  return why === 'skipped' ? `${what} in a part you have not read` : `${what} ahead of you`;
}

/**
 * The club's shared timeline: one bar for every format. Member markers sit at their timeline
 * position (live while they read), chapter ticks mark the book's chapters, and comment markers
 * show who reacted where. Markers ahead of you are spoiler-free: an emoji or a dot, no text.
 * Markers too close to tap one by one gather into a group that opens all of them.
 */
export function ClubBar({ bookId, members, selfId, chapters = [], comments = [], meeting = null, compact, onSeek, onComments, readRanges }: ClubBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const width = useWidth(trackRef, !compact);
  const [focused, setFocused] = useState<string | null>(null);
  // Who is at a marker shows on hover and keyboard focus, and a click or tap pins it open (a
  // second one closes it). A tap also sends the hover and focus a mouse would: those are
  // ignored, or the tap would open the tip and close it again at once.
  const [pinned, setPinned] = useState(false);
  const pressed = useRef({ at: 0, touch: false });
  // Grouped by how wide each group is drawn, so that no pill covers its neighbour (D31); your own
  // marker stays alone at your place, friends there beside it (D90).
  const ticks = useMemo(() => visibleTicks(chapters, width), [chapters, width]);
  const memberGroups = useMemo(() => layoutMembers(members, (m) => m.t, (m) => m.userId === selfId, width), [members, selfId, width]);
  // Notes, in their lane above the line, keep clear of the next stop's flag there too (FR157).
  const commentGroups = useMemo(() => layoutNotes(comments, (c) => c.t, width, meeting?.t ?? null, commentTargetPx), [comments, width, meeting?.t]);
  const pct = (t: number) => `${Math.min(100, Math.max(0, t * 100)).toFixed(3)}%`;
  const who = (m: BarMember) => (m.userId === selfId ? 'You' : m.displayName);
  const notesBy = (m: BarMember) => comments.filter((c) => c.userId === m.userId).length;
  const where = (m: BarMember) => `${placeText(m)}${m.live && m.kind ? `, ${KIND_LABEL[m.kind] ?? 'reading'} now` : ''}`;
  const said = (m: BarMember) => `${who(m)}: ${where(m)}`;
  // A group of friends named in the order it shows them: the friend of each dot, then the "+N"
  // past the third dot as it is on screen (WCAG 2.5.3, label in name), and who they are.
  const groupName = (items: readonly BarMember[]) => {
    const dots = items.slice(0, SHOWN_DOTS).map(said).join('; ');
    const rest = items.slice(SHOWN_DOTS);
    return rest.length > 0 ? `${dots}; +${rest.length} more: ${rest.map(said).join('; ')}` : dots;
  };
  const dot = (m: BarMember, extra?: Record<string, string>) => (
    <span
      key={m.userId}
      className={`club-bar-dot${m.userId === selfId ? ' is-self' : ''}${m.live ? ' is-live' : ''}`}
      style={{ background: m.color }}
      data-testid={extra ? 'member-marker' : undefined}
      {...extra}
    />
  );
  const markerData = (m: BarMember) => ({ 'data-user': m.userId, 'data-t': m.t.toFixed(6), 'data-live': m.live ? 'true' : 'false' });

  if (compact) {
    return (
      <div className="club-bar club-bar-compact" data-testid="club-bar" data-book={bookId}>
        <div className="club-bar-track">
          {meeting ? <span className="club-bar-meeting" style={{ left: pct(meeting.t) }} aria-hidden="true" data-testid="meeting-flag" /> : null}
          {[...members]
            .sort((a, b) => a.t - b.t)
            .map((m) => (
              <span
                key={m.userId}
                className={`club-bar-marker${m.userId === selfId ? ' is-self' : ''}${m.live ? ' is-live' : ''}${m.started ? '' : ' is-unstarted'}`}
                style={{ left: pct(m.t), background: m.color }}
                data-testid="member-marker"
                {...markerData(m)}
                title={`${m.userId === selfId ? 'You' : m.displayName}: ${placeText(m)}`}
                aria-hidden="true"
              />
            ))}
        </div>
      </div>
    );
  }

  const focusedGroup = memberGroups.find((g) => g.items.some((m) => m.userId === focused));
  const recentlyPressed = () => Date.now() - pressed.current.at < 800;
  const markerEvents = (lead: string, open: boolean) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      pressed.current = { at: Date.now(), touch: e.pointerType !== 'mouse' };
    },
    onMouseEnter: () => {
      if (!(recentlyPressed() && pressed.current.touch) && !pinned) setFocused(lead);
    },
    onMouseLeave: () => {
      if (!pinned) setFocused(null);
    },
    onFocus: () => {
      if (!recentlyPressed()) setFocused(lead);
    },
    onBlur: () => {
      setPinned(false);
      setFocused(null);
    },
    onClick: () => {
      if (open && pinned) {
        setPinned(false);
        setFocused(null);
      } else {
        setPinned(true);
        setFocused(lead);
      }
    },
  });

  return (
    <div className="club-bar" data-testid="club-bar" data-book={bookId}>
      <div
        ref={trackRef}
        className="club-bar-track"
        role={onSeek ? 'presentation' : undefined}
        onClick={(e) => {
          if (!onSeek || e.target !== e.currentTarget) return;
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek((e.clientX - rect.left) / rect.width);
        }}
      >
        {ticks.map((c) => (
          <span key={c.index} className="club-bar-tick" style={{ left: pct(c.t) }} aria-hidden="true" />
        ))}
        {meeting ? (
          <span className="club-bar-meeting" style={{ left: pct(meeting.t) }} role="img" aria-label={`Next stop: ${meetingHeadline(meeting)}`} data-testid="meeting-flag" data-t={meeting.t.toFixed(6)} />
        ) : null}
        {commentGroups.map((g) => {
          const only = g.items.length === 1 ? g.items[0]! : null;
          if (only) {
            return (
              <button
                key={only.id}
                type="button"
                className={`club-bar-comment${only.hidden ? ' is-hidden' : ''}`}
                style={{ left: pct(g.t) }}
                data-testid="bar-comment"
                data-hidden={only.hidden ? 'true' : 'false'}
                aria-label={commentLabel(only, readRanges)}
                onClick={() => onComments?.([only])}
              >
                {only.reaction ?? <span className="club-bar-comment-dot" />}
              </button>
            );
          }
          const closed = g.items.filter((c) => c.hidden);
          const ahead = closed.filter((c) => whyClosed(c, readRanges) === 'ahead').length;
          const tally = reactionTally(g.items);
          const { shown, more } = tallyShown(g.items);
          return (
            <button
              key={`g:${g.items.map((c) => c.id).join(',')}`}
              type="button"
              className={`club-bar-comment is-group${closed.length === g.items.length ? ' is-hidden' : ''}`}
              style={{ left: pct(g.t) }}
              data-testid="bar-comment-group"
              data-count={g.items.length}
              aria-label={`${tallyText({ shown, more })}: ${g.items.length} notes here${feelings(tally)}, from ${names([...new Set(g.items.map((c) => c.authorName))])}${closed.length === 0 ? '' : ahead === closed.length ? ` (${ahead} ahead of you)` : ` (${closed.length} not open yet)`}`}
              onClick={() => onComments?.(g.items)}
            >
              {/* A space between the parts, which the pill (a flex box) does not draw: its text reads
                  "😂2 1" as its name does, not "😂21" with the dot for words between two counts. */}
              {shown.map((x, i) => (
                <Fragment key={x.reaction ?? 'words'}>
                  {i > 0 ? ' ' : null}
                  <span className="club-bar-tally" aria-hidden="true" data-reaction={x.reaction ?? ''}>
                    {x.reaction ?? <span className="club-bar-comment-dot" />}
                    <span className="club-bar-count">{x.count}</span>
                  </span>
                </Fragment>
              ))}
              {more > 0 ? (
                <>
                  {' '}
                  <span className="club-bar-count" aria-hidden="true">
                    +{more}
                  </span>
                </>
              ) : null}
            </button>
          );
        })}
        {memberGroups.map((g) => {
          const only = g.items.length === 1 ? g.items[0]! : null;
          const key = only ? only.userId : `g:${g.items.map((m) => m.userId).join(',')}`;
          const lead = g.items[0]!.userId;
          return (
            <button
              key={key}
              type="button"
              className={`club-bar-marker${only ? '' : ' is-group'}`}
              style={{ left: pct(g.x) }}
              {...(only ? { 'data-testid': 'member-marker', ...markerData(only) } : { 'data-testid': 'member-group' })}
              aria-label={only ? said(only) : groupName(g.items)}
              {...markerEvents(lead, focusedGroup === g)}
            >
              {only ? dot(only) : g.items.map((m, i) => (i < SHOWN_DOTS ? dot(m, markerData(m)) : <span key={m.userId} hidden data-testid="member-marker" {...markerData(m)} />))}
              {g.items.length > SHOWN_DOTS ? <span className="club-bar-count">+{g.items.length - SHOWN_DOTS}</span> : null}
            </button>
          );
        })}
      </div>
      {focusedGroup ? (
        <BarTip t={focusedGroup.x}>
          {focusedGroup.items.map((m, i) => (
            <span key={m.userId}>
              {i > 0 ? <br /> : null}
              <strong>{who(m)}</strong> · {placeText(m)}
              {m.live && m.kind ? ` · ${KIND_LABEL[m.kind] ?? 'reading'} now` : ''}
              {notesBy(m) > 0 ? ` · ${notesBy(m)} ${notesBy(m) === 1 ? 'note' : 'notes'}` : ''}
            </span>
          ))}
        </BarTip>
      ) : null}
    </div>
  );
}

/**
 * Who is at a marker, under it: centred on it where there is room, else held inside the bar, so the
 * friend furthest ahead (or just starting) is not cut off at the screen's edge.
 */
function BarTip({ t, children }: { t: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const bar = el?.offsetParent as HTMLElement | null;
    const track = bar?.querySelector('.club-bar-track');
    if (!el || !bar || !track) return;
    // The marker's place on the track, in the bar's own coordinates.
    const box = bar.getBoundingClientRect();
    const line = track.getBoundingClientRect();
    const width = el.offsetWidth;
    const centre = line.left - box.left + Math.min(1, Math.max(0, t)) * line.width;
    setLeft(Math.max(0, Math.min(centre - width / 2, bar.clientWidth - width)));
  }, [t, children]);
  // Until it is measured (which is before it is painted), centred on its marker.
  const centred = { left: `${(Math.min(1, Math.max(0, t)) * 100).toFixed(3)}%`, transform: 'translateX(-50%)' };
  return (
    <div ref={ref} className="club-bar-tip" style={left === null ? centred : { left: `${left}px` }} role="status" data-testid="bar-tip">
      {children}
    </div>
  );
}
