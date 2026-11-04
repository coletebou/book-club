import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Chapter, CommentView, MemberProgress, PresenceEntry } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAR_TARGET_PX, type BarMember, ClubBar, FLAG_PX, TICK_GAP_PX, barMembers, commentTargetPx, groupOnTrack, layoutMembers, layoutNotes, memberTargetPx, placeText, reactionTally, visibleTicks } from './ClubBar';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* groupOnTrack --------------------------------------------------------------------------------- */

interface Dot {
  readonly id: string;
  readonly t: number;
}
const dots = (...ts: number[]): Dot[] => ts.map((t, i) => ({ id: `d${i}`, t }));
const tOf = (d: Dot) => d.t;
const mean = (items: readonly Dot[]) => items.reduce((s, d) => s + d.t, 0) / items.length;

/** Deterministic pseudo-random numbers (mulberry32), so a failing case can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('groupOnTrack', () => {
  it('leaves every item alone, in timeline order, before the track has a width', () => {
    const items = dots(0.5, 0.1, 0.3, 0.3);
    for (const width of [0, -1]) {
      const groups = groupOnTrack(items, tOf, width);
      expect(groups.map((g) => g.items.map((d) => d.id))).toEqual([['d1'], ['d2'], ['d3'], ['d0']]);
      expect(groups.map((g) => g.t)).toEqual([0.1, 0.3, 0.3, 0.5]);
    }
  });

  it('uses a tap target of at least 24 px (WCAG 2.5.8) as the default gap', () => {
    expect(BAR_TARGET_PX).toBeGreaterThanOrEqual(24);
    // 260 px wide: items 0.09 apart (23.4 px) are too close, 0.11 apart (28.6 px) are not.
    expect(groupOnTrack(dots(0.4, 0.49), tOf, 260)).toHaveLength(1);
    expect(groupOnTrack(dots(0.4, 0.51), tOf, 260)).toHaveLength(2);
  });

  it('merges items closer than the gap into one group at the mean of its items', () => {
    const groups = groupOnTrack(dots(0.75, 0.25, 0.3125), tOf, 100, 25);
    expect(groups).toEqual([
      { t: (0.25 + 0.3125) / 2, items: [{ id: 'd1', t: 0.25 }, { id: 'd2', t: 0.3125 }] },
      { t: 0.75, items: [{ id: 'd0', t: 0.75 }] },
    ]);
  });

  it('keeps items exactly one gap apart separate', () => {
    expect(groupOnTrack(dots(0.25, 0.5, 0.75), tOf, 100, 25).map((g) => g.items.length)).toEqual([1, 1, 1]);
  });

  it('merges a group that ends up too close to the next one too (chains merge transitively)', () => {
    // 0.50 and 0.58 merge at 0.54, which is now within the gap of 0.61: all three become one.
    const groups = groupOnTrack(dots(0.5, 0.58, 0.61), tOf, 100, 10);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.t).toBeCloseTo((0.5 + 0.58 + 0.61) / 3, 12);
    // A long run of close items collapses to one group.
    expect(groupOnTrack(dots(0.5, 0.52, 0.54, 0.56, 0.58), tOf, 100, 10)).toHaveLength(1);
  });

  it('puts everything in one group on a track too narrow for two targets', () => {
    // 20 px: not even both ends are a target apart. (At 40 px the two ends already are.)
    expect(groupOnTrack(dots(0, 0.5, 1), tOf, 40)).toHaveLength(2);
    const groups = groupOnTrack(dots(0, 0.5, 1), tOf, 20);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.t).toBeCloseTo(0.5, 12);
  });

  it('gives a target drawn wider more room: a group’s pill does not cover the item next to it', () => {
    const wide = (items: readonly Dot[]) => (items.length > 1 ? 80 : BAR_TARGET_PX);
    // 300 px: 0.5 and 0.6 are 30 px apart, room enough for two plain targets...
    expect(groupOnTrack(dots(0.5, 0.6), tOf, 300, BAR_TARGET_PX, wide)).toHaveLength(2);
    // ...but not once the one at 0.5 is a pill 80 px wide: (80 + 26) / 2 = 53 px > 30.
    expect(groupOnTrack(dots(0.49, 0.5, 0.6), tOf, 300, BAR_TARGET_PX, wide)).toHaveLength(1);
  });

  it('checks a group, wider once merged, again against the one before it', () => {
    const wide = (items: readonly Dot[]) => (items.length > 1 ? 80 : BAR_TARGET_PX);
    // 0.62 and 0.63 merge into a pill 80 px wide at 0.625, which is 37.5 px from 0.5: closer than
    // (26 + 80) / 2 = 53 px, so 0.5 joins it too.
    const groups = groupOnTrack(dots(0.5, 0.62, 0.63), tOf, 300, BAR_TARGET_PX, wide);
    expect(groups.map((g) => g.items.length)).toEqual([3]);
  });

  it('never lets targets of any width overlap, for any input', () => {
    const next = random(20261024);
    for (let run = 0; run < 400; run++) {
      const n = Math.floor(next() * 40);
      const items = Array.from({ length: n }, (_, i) => ({ id: `d${i}`, t: next() < 0.3 ? Math.round(next() * 5) / 5 : next() }));
      const width = 30 + Math.floor(next() * 1200);
      // Wider the more there are in a group, as a pill of reactions is.
      const sizeOf = (g: readonly Dot[]) => BAR_TARGET_PX + Math.min(4, g.length - 1) * 22;
      const groups = groupOnTrack(items, tOf, width, BAR_TARGET_PX, sizeOf);
      const context = JSON.stringify({ run, width, ts: items.map(tOf) });
      expect(groups.flatMap((g) => g.items.map((d) => d.id)).sort(), context).toEqual(items.map((d) => d.id).sort());
      groups.forEach((g, i) => {
        expect(g.t, context).toBeCloseTo(mean(g.items), 12);
        const prev = groups[i - 1];
        if (prev) expect((g.t - prev.t) * width, context).toBeGreaterThanOrEqual((sizeOf(prev.items) + sizeOf(g.items)) / 2 - 1e-6);
      });
    }
  });

  it('measures a group of notes by what its pill shows, and members by their dots', () => {
    const notes = (...rs: (string | null)[]) => rs.map((reaction) => ({ reaction })) as Parameters<typeof commentTargetPx>[0];
    expect(commentTargetPx(notes('😂'))).toBe(BAR_TARGET_PX);
    // One reaction with its count; two; two and "+1" for a third kind; a two-digit count is wider.
    const one = commentTargetPx(notes('😂', '😂'));
    const two = commentTargetPx(notes('😂', '😢'));
    const three = commentTargetPx(notes('😂', '😢', '🤯'));
    expect(one).toBeGreaterThan(BAR_TARGET_PX);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
    expect(commentTargetPx(notes(...Array<string>(12).fill('😂'), '😢'))).toBeGreaterThan(two);
    // Pills measured at 65 to 83 px in both engines: the estimate is never narrower than the real one.
    expect(two).toBeGreaterThanOrEqual(65);
    expect(three).toBeGreaterThanOrEqual(83);
    expect(memberTargetPx(['a'])).toBe(BAR_TARGET_PX);
    expect(memberTargetPx(['a', 'b'])).toBeGreaterThanOrEqual(BAR_TARGET_PX);
    expect(memberTargetPx(['a', 'b', 'c', 'd', 'e'])).toBeGreaterThan(memberTargetPx(['a', 'b', 'c']));
  });

  it('does not change the list it was given', () => {
    const items = dots(0.9, 0.1, 0.11);
    const copy = structuredClone(items);
    groupOnTrack(items, tOf, 300);
    expect(items).toEqual(copy);
  });

  it('keeps its promises for any input: every item once, groups at their mean, never closer than the gap', () => {
    const next = random(20261023);
    for (let run = 0; run < 400; run++) {
      const n = Math.floor(next() * 40);
      // Clusters (several readers on one page) as well as spread-out items.
      const items = Array.from({ length: n }, (_, i) => ({ id: `d${i}`, t: next() < 0.3 ? Math.round(next() * 5) / 5 : next() }));
      const width = 30 + Math.floor(next() * 1200);
      const groups = groupOnTrack(items, tOf, width);
      const context = JSON.stringify({ run, width, ts: items.map(tOf) });

      const seen = groups.flatMap((g) => g.items.map((d) => d.id)).sort();
      expect(seen, context).toEqual(items.map((d) => d.id).sort());
      const gap = BAR_TARGET_PX / width;
      groups.forEach((g, i) => {
        expect(g.items.length, context).toBeGreaterThan(0);
        expect(g.t, context).toBeCloseTo(mean(g.items), 12);
        // A group's items are neighbours on the track: nothing from another group lies between them.
        const lo = Math.min(...g.items.map(tOf));
        const hi = Math.max(...g.items.map(tOf));
        const prev = groups[i - 1];
        if (prev) {
          expect(g.t - prev.t, context).toBeGreaterThanOrEqual(gap - 1e-9);
          expect(lo, context).toBeGreaterThanOrEqual(Math.max(...prev.items.map(tOf)));
        }
        expect(hi, context).toBeGreaterThanOrEqual(lo);
      });
    }
  });
});

/* ticks and words ------------------------------------------------------------------------------ */

describe('the chapter ticks drawn', () => {
  it('are every chapter on a short book, and none closer than a few pixels on a long one', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ index: i, t: i / 12 }));
    expect(visibleTicks(twelve, 360)).toHaveLength(12);
    // War and Peace: 384 chapters on a phone's bar of some 360 px.
    const many = Array.from({ length: 384 }, (_, i) => ({ index: i, t: i / 384 }));
    const shown = visibleTicks(many, 360);
    expect(shown.length).toBeLessThanOrEqual(360 / TICK_GAP_PX + 1);
    expect(shown.length).toBeGreaterThan(40);
    shown.slice(1).forEach((c, i) => expect((c.t - shown[i]!.t) * 360).toBeGreaterThanOrEqual(TICK_GAP_PX));
    // Before the bar is laid out there is nothing to space them by: all of them, until it is.
    expect(visibleTicks(many, 0)).toHaveLength(384);
  });
});

describe('where a member is, in words', () => {
  const m = (over: Partial<Parameters<typeof placeText>[0]>) => ({ label: 'Chapter 12 · 99%', t: 0.99, live: false, finished: false, ...over });
  it('says Finished for a friend who has finished, rather than the 99% of their last page', () => {
    expect(placeText(m({ finished: true }))).toBe('Finished');
    expect(placeText(m({}))).toBe('Chapter 12 · 99%');
    // Reading again somewhere: where they are now.
    expect(placeText(m({ finished: true, live: true, label: 'Chapter 3 · 20%' }))).toBe('Chapter 3 · 20%');
    expect(placeText(m({ label: '', t: 0.5 }))).toBe('50%');
  });
});

/* barMembers ----------------------------------------------------------------------------------- */

const saved = (userId: string, t: number, over: Partial<MemberProgress> = {}): MemberProgress => ({
  userId,
  displayName: userId.replace('user_', ''),
  color: '#4ECDC4',
  t,
  furthest: t,
  coverage: t,
  kind: 'epub',
  label: `Chapter ${Math.ceil(t * 10)}`,
  updatedAt: '2026-10-22T20:00:00.000Z',
  finished: false,
  ...over,
});

const here = (userId: string, reading: PresenceEntry['reading']): PresenceEntry => ({ userId, displayName: userId, color: '#4ECDC4', online: true, reading });

describe('reactionTally', () => {
  it('counts each reaction in a group, the most frequent first, words-only notes last at a tie', () => {
    const notes = (...rs: (string | null)[]) => rs.map((reaction) => ({ reaction })) as Parameters<typeof reactionTally>[0];
    expect(reactionTally(notes('🤯', '😂'))).toEqual([
      { reaction: '🤯', count: 1 },
      { reaction: '😂', count: 1 },
    ]);
    expect(reactionTally(notes('😢', '😱', null, '😱'))).toEqual([
      { reaction: '😱', count: 2 },
      { reaction: '😢', count: 1 },
      { reaction: null, count: 1 },
    ]);
    expect(reactionTally(notes(null, null))).toEqual([{ reaction: null, count: 2 }]);
  });
});

describe('barMembers', () => {
  const live = { bookId: 'book_alice', editionId: 'ed_audio', kind: 'audio' as const, t: 0.62, label: 'Chapter 7 · 2:10', at: 1 };

  it('places members at their saved progress when nobody is reading now', () => {
    const members = barMembers('book_alice', [saved('user_ana', 0.2, { finished: true }), saved('user_ben', 0.5, { kind: 'pdf' })], new Map());
    expect(members).toEqual([
      { userId: 'user_ana', displayName: 'ana', color: '#4ECDC4', t: 0.2, label: 'Chapter 2', live: false, kind: 'epub', finished: true, started: true },
      { userId: 'user_ben', displayName: 'ben', color: '#4ECDC4', t: 0.5, label: 'Chapter 5', live: false, kind: 'pdf', finished: false, started: true },
    ]);
  });

  it('knows who has not opened the book yet (they wait, faint, at its start on the card)', () => {
    const [cleo] = barMembers('book_alice', [saved('user_cleo', 0, { updatedAt: null, kind: null })], new Map());
    expect(cleo!.started).toBe(false);
    const { container } = render(<ClubBar bookId="book_alice" members={[cleo!]} compact />);
    expect(container.querySelector('[data-testid="member-marker"]')!.classList.contains('is-unstarted')).toBe(true);
  });

  it('lets live presence on this book override position, label and format', () => {
    const [ana] = barMembers('book_alice', [saved('user_ana', 0.2, { finished: true })], new Map([['user_ana', here('user_ana', live)]]));
    expect(ana).toMatchObject({ t: 0.62, label: 'Chapter 7 · 2:10', kind: 'audio', live: true, finished: true });
  });

  it('ignores live presence on another book', () => {
    const elsewhere = { ...live, bookId: 'book_other' };
    const [ana] = barMembers('book_alice', [saved('user_ana', 0.2)], new Map([['user_ana', here('user_ana', elsewhere)]]));
    expect(ana).toMatchObject({ t: 0.2, label: 'Chapter 2', kind: 'epub', live: false });
  });

  it('ignores members who are online but not reading', () => {
    const [ana] = barMembers('book_alice', [saved('user_ana', 0.2)], new Map([['user_ana', here('user_ana', null)]]));
    expect(ana).toMatchObject({ t: 0.2, live: false });
  });

  it('shows exactly the members with progress, in their order, whoever else is online', () => {
    const presence = new Map([['user_zoe', here('user_zoe', live)]]);
    expect(barMembers('book_alice', [saved('user_ben', 0.5), saved('user_ana', 0.2)], presence).map((m) => m.userId)).toEqual(['user_ben', 'user_ana']);
  });
});

/* ClubBar -------------------------------------------------------------------------------------- */

/** Where a marker sits along the track, in percent (jsdom normalises "10.000%" to "10%"). */
const left = (el: HTMLElement) => Number.parseFloat(el.style.left);

/**
 * The words and numbers of a text as WCAG 2.5.3 (label in name) compares a control's text with its
 * name, the way axe's label-content-name-mismatch does: emoji, signs and asides in parentheses
 * left out.
 */
const words = (text: string) => text.toLowerCase().replace(/\([^()]*\)/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
/** Whether the words a control shows are in its name, together and in their order. */
const inName = (shown: string, name: string) => {
  const [seen, named] = [words(shown), words(name)];
  return seen.length > 0 && named.some((_, i) => seen.every((w, j) => named[i + j] === w));
};

const member = (userId: string, t: number, over: Partial<BarMember> = {}): BarMember => ({
  userId,
  displayName: userId.replace('user_', '').replace(/^./, (c) => c.toUpperCase()),
  color: '#45B7D1',
  t,
  label: '',
  live: false,
  kind: 'epub',
  finished: false,
  started: true,
  ...over,
});

const base = { bookId: 'book_alice', editionId: 'ed_epub', kind: 'epub' as const, locator: { kind: 'epub' as const, section: 2, offset: 10 }, createdAt: '2026-10-23T10:00:00.000Z', color: '#FF6B6B' };
const revealedNote = (id: string, authorName: string, t: number, text: string | null, reaction: CommentView['reaction'] = null): CommentView => ({
  ...base,
  id,
  userId: `user_${authorName.toLowerCase()}`,
  authorName,
  t,
  reaction,
  hidden: false,
  endLocator: null,
  endT: null,
  quote: null,
  text,
});
const hiddenNote = (id: string, authorName: string, t: number, reaction: CommentView['reaction'] = null): CommentView => ({
  ...base,
  id,
  userId: `user_${authorName.toLowerCase()}`,
  authorName,
  t,
  reaction,
  hidden: true,
  hasText: reaction === null,
});

const chapters: Chapter[] = [
  { index: 0, title: 'Down the Rabbit-Hole', t: 0 },
  { index: 1, title: 'The Pool of Tears', t: 0.25 },
  { index: 2, title: 'A Caucus-Race', t: 0.5 },
];

describe('ClubBar', () => {
  const members = [member('user_ana', 0.2, { label: 'Chapter 1 · 20%' }), member('user_ben', 0.6, { live: true, kind: 'audio', label: 'Chapter 3 · 4:05' }), member('user_cole', 0.4)];
  const notes = [revealedNote('cm_a', 'Ana', 0.1, 'What a line', '😂'), hiddenNote('cm_b', 'Ben', 0.8, '😱'), hiddenNote('cm_c', 'Cleo', 0.9)];

  it('shows each note as its own button, spoiler-free when it is ahead of you', () => {
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" chapters={chapters} comments={notes} />);
    const buttons = screen.getAllByTestId('bar-comment');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Ana: 😂 What a line', 'Ben reacted 😱 ahead of you', 'Cleo left a note ahead of you']);
    expect(buttons.map((b) => b.dataset.hidden)).toEqual(['false', 'true', 'true']);
    // A hidden marker shows its reaction or a dot: never words.
    expect(buttons[1]!.textContent).toBe('😱');
    expect(buttons[2]!.textContent).toBe('');
    expect(screen.getByTestId('club-bar').textContent).not.toMatch(/[A-Za-z]/);
  });

  it('says why a closed note is closed: ahead, about here in another format, in a part not read, or from where its writer was', () => {
    const held = { ...hiddenNote('cm_d', 'Dee', 0.15), horizon: 'Chapter 3' } as CommentView;
    const near = { ...hiddenNote('cm_e', 'Eve', 0.3, '😢'), kind: 'audio' } as CommentView;
    const skipped = hiddenNote('cm_f', 'Fay', 0.45);
    // Read from the start to 0.32, and from 0.5 to 0.6: Fay's note lies in the part between.
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" chapters={chapters} comments={[held, near, skipped, notes[2]!]} readRanges={[[0, 0.32], [0.5, 0.6]]} />);
    expect(screen.getAllByTestId('bar-comment').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Dee left a note from Chapter 3',
      'Eve reacted 😢 while listening about here, open a little further on',
      'Fay left a note in a part you have not read',
      'Cleo left a note ahead of you',
    ]);
    // Without the reading known, a closed note is ahead of you, as before.
    cleanup();
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" chapters={chapters} comments={[near]} />);
    expect(screen.getByTestId('bar-comment').getAttribute('aria-label')).toBe('Eve reacted 😢 ahead of you');
  });

  it('places markers along the track at their timeline position', () => {
    render(<ClubBar bookId="book_alice" members={members} comments={notes} />);
    expect(screen.getAllByTestId('bar-comment').map(left)).toEqual([10, 80, 90]);
    expect(screen.getAllByTestId('member-marker').map(left)).toEqual([20, 40, 60]);
  });

  it('keeps markers on the track for positions just outside [0, 1]', () => {
    render(<ClubBar bookId="book_alice" members={[member('user_ana', -0.01), member('user_ben', 1.02)]} />);
    expect(screen.getAllByTestId('member-marker').map(left)).toEqual([0, 100]);
  });

  it('opens the note that was tapped', () => {
    const onComments = vi.fn();
    render(<ClubBar bookId="book_alice" members={members} comments={notes} onComments={onComments} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ben reacted 😱 ahead of you' }));
    expect(onComments).toHaveBeenCalledWith([notes[1]]);
  });

  it('marks every member with who they are, where they are and whether they are reading now', () => {
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" comments={[]} />);
    const markers = screen.getAllByTestId('member-marker');
    expect(markers.map((m) => [m.dataset.user, m.dataset.t, m.dataset.live])).toEqual([
      ['user_ana', '0.200000', 'false'],
      ['user_cole', '0.400000', 'false'],
      ['user_ben', '0.600000', 'true'],
    ]);
    expect(markers.map((m) => m.getAttribute('aria-label'))).toEqual(['Ana: Chapter 1 · 20%', 'You: 40%', 'Ben: Chapter 3 · 4:05, listening now']);
  });

  it('shows who is at a marker in a tip while it has focus or the pointer', () => {
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" />);
    const ben = screen.getByRole('button', { name: /^Ben:/ });
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.focus(ben);
    expect(screen.getByRole('status').textContent).toBe('Ben · Chapter 3 · 4:05 · listening now');
    fireEvent.blur(ben);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: /^You:/ }));
    expect(screen.getByRole('status').textContent).toBe('You · 40%');
  });

  it('a tap opens the tip and a second tap closes it (a tap sends hover and focus too, which do not count)', () => {
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" />);
    const ben = screen.getByRole('button', { name: /^Ben:/ });
    const tap = () => {
      fireEvent.pointerDown(ben, { pointerType: 'touch' });
      fireEvent.mouseEnter(ben);
      fireEvent.focus(ben);
      fireEvent.click(ben);
    };
    tap();
    expect(screen.getByRole('status').textContent).toBe('Ben · Chapter 3 · 4:05 · listening now');
    tap();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('with a mouse, hovering shows the tip and a click keeps it open until the next click', () => {
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" />);
    const ana = screen.getByRole('button', { name: 'Ana: Chapter 1 · 20%' });
    fireEvent.mouseEnter(ana);
    expect(screen.getByRole('status').textContent).toBe('Ana · Chapter 1 · 20%');
    fireEvent.pointerDown(ana, { pointerType: 'mouse' });
    fireEvent.click(ana);
    fireEvent.mouseLeave(ana);
    expect(screen.getByRole('status').textContent).toBe('Ana · Chapter 1 · 20%');
    fireEvent.pointerDown(ana, { pointerType: 'mouse' });
    fireEvent.click(ana);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("counts each friend's notes in their tip (v1: name, percentage, comment count)", () => {
    const anaNotes = [revealedNote('n1', 'Ana', 0.1, 'One'), hiddenNote('n2', 'Ana', 0.7, '😂')];
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" comments={anaNotes} />);
    // (Ana's note buttons are named "Ana: …" too; her marker is the one with her place.)
    fireEvent.focus(screen.getByRole('button', { name: 'Ana: Chapter 1 · 20%' }));
    expect(screen.getByRole('status').textContent).toBe('Ana · Chapter 1 · 20% · 2 notes');
    fireEvent.focus(screen.getByRole('button', { name: /^Ben:/ }));
    expect(screen.getByRole('status').textContent).not.toContain('note');
  });

  it('draws your own marker larger, with an outline (v1 progress design)', () => {
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" />);
    const own = screen.getByRole('button', { name: /^You:/ }).querySelector('.club-bar-dot');
    const other = screen.getByRole('button', { name: /^Ana:/ }).querySelector('.club-bar-dot');
    expect(own?.classList.contains('is-self')).toBe(true);
    expect(other?.classList.contains('is-self')).toBe(false);
  });

  it('names whoever a compact library-card dot is on hover', () => {
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" compact />);
    expect(screen.getAllByTestId('member-marker').map((m) => m.getAttribute('title'))).toEqual(['Ana: Chapter 1 · 20%', 'You: 40%', 'Ben: Chapter 3 · 4:05']);
  });

  it('seeks to where the track itself is tapped, but not when a marker on it is tapped', () => {
    const onSeek = vi.fn();
    render(<ClubBar bookId="book_alice" members={members} onSeek={onSeek} />);
    const track = screen.getByTestId('club-bar').firstElementChild as HTMLElement;
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 400, 26));
    fireEvent.click(track, { clientX: 300 });
    expect(onSeek).toHaveBeenCalledWith(0.5);
    fireEvent.click(screen.getAllByTestId('member-marker')[0]!, { clientX: 180 });
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it('draws a tick for every chapter', () => {
    const { container } = render(<ClubBar bookId="book_alice" members={[]} chapters={chapters} />);
    expect([...container.querySelectorAll<HTMLElement>('.club-bar-tick')].map(left)).toEqual([0, 25, 50]);
  });

  it('in its compact form shows only member markers, in order, hidden from assistive technology', () => {
    render(<ClubBar bookId="book_alice" members={members} selfId="user_cole" comments={notes} compact />);
    const markers = screen.getAllByTestId('member-marker');
    expect(markers.map((m) => m.dataset.user)).toEqual(['user_ana', 'user_cole', 'user_ben']);
    expect(markers.every((m) => m.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByTestId('bar-comment')).toHaveLength(0);
  });

  describe('on a laid-out track (260 px: markers closer than 0.1 share a target)', () => {
    const laidOut = () => vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(260);

    it('gathers notes too close to tap one by one into a group that opens all of them', () => {
      laidOut();
      const onComments = vi.fn();
      const close = [revealedNote('cm_1', 'Ana', 0.5, 'Ha', '😂'), hiddenNote('cm_2', 'Ben', 0.52), hiddenNote('cm_3', 'Ana', 0.54, '😱'), revealedNote('cm_4', 'Cleo', 0.9, 'Far away')];
      render(<ClubBar bookId="book_alice" members={[]} comments={close} onComments={onComments} />);
      const group = screen.getByTestId('bar-comment-group');
      expect(group.dataset.count).toBe('3');
      expect(group.getAttribute('aria-label')).toBe('😂 1, 😱 1, +1 more: 3 notes here (Laughing 1, Shocked 1), from Ana and Ben (2 ahead of you)');
      // Each reaction with how many (v1's "😱2 😢1"), the rest as a count.
      expect(group.textContent).toBe('😂1 😱1 +1');
      expect(left(group)).toBeCloseTo(52, 6);
      expect(screen.getAllByTestId('bar-comment')).toHaveLength(1);
      fireEvent.click(group);
      expect(onComments).toHaveBeenCalledWith([close[0], close[1], close[2]]);
    });

    it('names a group of notes by what it shows, first (WCAG 2.5.3, label in name), then in words', () => {
      laidOut();
      const groups = [
        // Notes in words, drawn as a dot, between two counts; a third reaction as "+1".
        [revealedNote('a1', 'Ana', 0.1, null, '😂'), revealedNote('a2', 'Ben', 0.11, 'Ha', '😂'), revealedNote('a3', 'Cleo', 0.12, 'Hm'), revealedNote('a4', 'Dee', 0.13, 'Oh'), hiddenNote('a5', 'Eli', 0.14, '😱')],
        // All of them ahead of you: still each reaction with its count, never the words.
        [hiddenNote('b1', 'Ana', 0.5, '😢'), hiddenNote('b2', 'Ben', 0.51, '😢'), hiddenNote('b3', 'Cleo', 0.52, '❤️'), hiddenNote('b4', 'Dee', 0.53, '🤯'), hiddenNote('b5', 'Eli', 0.54)],
        [revealedNote('c1', 'Ana', 0.9, 'One'), revealedNote('c2', 'Ben', 0.91, 'Two'), revealedNote('c3', 'Cleo', 0.92, null, '😡')],
      ];
      render(<ClubBar bookId="book_alice" members={[]} comments={groups.flat()} />);
      const pills = screen.getAllByTestId('bar-comment-group');
      expect(pills.map((p) => p.getAttribute('aria-label'))).toEqual([
        '😂 2, 💬 2, +1 more: 5 notes here (Laughing 2, Shocked 1), from Ana, Ben, Cleo, Dee and Eli (1 ahead of you)',
        '😢 2, ❤️ 1, +2 more: 5 notes here (Sad 2, Love 1, Mind blown 1), from Ana, Ben, Cleo, Dee and Eli (5 ahead of you)',
        '💬 2, 😡 1: 3 notes here (Angry 1), from Ana, Ben and Cleo',
      ]);
      expect(pills.map((p) => p.textContent)).toEqual(['😂2 2 +1', '😢2 ❤️1 +2', '2 😡1']);
      for (const pill of pills) {
        const shown = words(pill.textContent);
        expect(words(pill.getAttribute('aria-label')!).slice(0, shown.length)).toEqual(shown);
        expect(inName(pill.textContent, pill.getAttribute('aria-label')!)).toBe(true);
      }
      // The check itself: the counts run together round a dot ("😂22"), or a name without them, fail it.
      expect(inName('😂22 +1', pills[0]!.getAttribute('aria-label')!)).toBe(false);
      expect(inName('😂2 2 +1', '5 notes here (Laughing 2, Shocked 1), from Ana, Ben, Cleo, Dee and Eli')).toBe(false);
    });

    // Your own marker used to be one of the group's dots, drawn under its "+N" (fidelity review
    // round 15): it now stays apart, at your place, with the friends there beside it (D90).
    it('gathers friends on the same page into one marker that still names each of them; yours stays apart', () => {
      laidOut();
      const crowd = [member('user_ana', 0.3), member('user_ben', 0.31), member('user_cole', 0.32), member('user_dan', 0.33), member('user_fay', 0.34), member('user_eve', 0.8)];
      render(<ClubBar bookId="book_alice" members={crowd} selfId="user_cole" />);
      const group = screen.getByTestId('member-group');
      // In the order it shows them: a dot for each of three, then "+1", who is Fay.
      expect(group.getAttribute('aria-label')).toBe('Ana: 30%; Ben: 31%; Dan: 33%; +1 more: Fay: 34%');
      expect(group.textContent).toBe('+1');
      expect(inName(group.textContent, group.getAttribute('aria-label')!)).toBe(true);
      // Every member keeps a marker with its data, the ones past the third one hidden; yours first,
      // where you are, and the group beside it.
      const markers = screen.getAllByTestId('member-marker');
      expect(markers.map((m) => m.dataset.user)).toEqual(['user_cole', 'user_ana', 'user_ben', 'user_dan', 'user_fay', 'user_eve']);
      expect(markers.map((m) => m.hidden)).toEqual([false, false, false, false, true, false]);
      const own = screen.getByRole('button', { name: 'You: 32%' });
      expect(left(own)).toBeCloseTo(32, 6);
      // (Positions are drawn to a thousandth of a per cent.)
      expect((left(group) / 100) * 260 - memberTargetPx(['a', 'b', 'c', 'd']) / 2).toBeGreaterThanOrEqual(0.32 * 260 + BAR_TARGET_PX / 2 - 0.01);
      fireEvent.click(group);
      expect(screen.getByRole('status').textContent).toBe('Ana · 30%Ben · 31%Dan · 33%Fay · 34%');
    });

    it('keeps your marker at your place and tappable on a new book, everyone at its start: the friends beside it', () => {
      laidOut();
      const everyone = ['user_ben', 'user_cleo', 'user_cole', 'user_ana', 'user_dee'].map((id) => member(id, 0, { started: id === 'user_cole' }));
      render(<ClubBar bookId="book_alice" members={everyone} selfId="user_cole" />);
      const own = screen.getByRole('button', { name: 'You: 0%' });
      const group = screen.getByTestId('member-group');
      expect(left(own)).toBe(0);
      expect(own.querySelector('.club-bar-dot')!.classList.contains('is-self')).toBe(true);
      // Beside it, not over it: the group's left edge is past your marker's right edge.
      expect((left(group) / 100) * 260 - memberTargetPx(['a', 'b', 'c', 'd']) / 2).toBeCloseTo(BAR_TARGET_PX / 2, 1);
      expect(group.getAttribute('aria-label')).toBe('Ben: 0%; Cleo: 0%; Ana: 0%; +1 more: Dee: 0%');
      // Each says its own: you, or the friends.
      fireEvent.click(own);
      expect(screen.getByRole('status').textContent).toBe('You · 0%');
      fireEvent.click(own);
      fireEvent.click(group);
      expect(screen.getByRole('status').textContent).toBe('Ben · 0%Cleo · 0%Ana · 0%Dee · 0%');
    });

    it('at the very end, the friends who finished with you sit before your marker', () => {
      laidOut();
      render(<ClubBar bookId="book_alice" members={[member('user_ana', 1), member('user_cole', 1), member('user_ben', 1)]} selfId="user_cole" />);
      const own = screen.getByRole('button', { name: 'You: 100%' });
      const group = screen.getByTestId('member-group');
      expect(left(own)).toBe(100);
      expect((left(group) / 100) * 260 + memberTargetPx(['a', 'b']) / 2).toBeCloseTo(260 - BAR_TARGET_PX / 2, 1);
      expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Ana: 100%; Ben: 100%', 'You: 100%']);
    });

    it('draws a friend a step ahead of you beside your marker, and still says where they are', () => {
      laidOut();
      render(<ClubBar bookId="book_alice" members={[member('user_cole', 0.5), member('user_ana', 0.51, { label: 'Chapter 6 · 51%' })]} selfId="user_cole" />);
      const ana = screen.getByRole('button', { name: 'Ana: Chapter 6 · 51%' });
      expect(ana.dataset.t).toBe('0.510000');
      expect(left(ana)).toBeCloseTo(60, 6);
      expect(left(screen.getByRole('button', { name: 'You: 50%' }))).toBe(50);
    });
  });
});

/* layoutMembers -------------------------------------------------------------------------------- */

describe('layoutMembers', () => {
  const isSelf = (d: Dot) => d.id === 'me';
  const size = (items: readonly Dot[]) => memberTargetPx(items);

  it('is groupOnTrack when you are not on the bar, and everyone at their place before it has a width', () => {
    const items = dots(0.2, 0.21, 0.6);
    expect(layoutMembers(items, tOf, isSelf, 260, size)).toEqual(groupOnTrack(items, tOf, 260, BAR_TARGET_PX, size).map((g) => ({ x: g.t, items: g.items, self: false })));
    const withYou = [...items, { id: 'me', t: 0.205 }];
    expect(layoutMembers(withYou, tOf, isSelf, 0, size).map((g) => [g.x, g.items.map((d) => d.id), g.self])).toEqual([
      [0.2, ['d0'], false],
      [0.205, ['me'], true],
      [0.21, ['d1'], false],
      [0.6, ['d2'], false],
    ]);
  });

  it('leaves friends who are not near you where groupOnTrack puts them', () => {
    const items = [...dots(0.1, 0.11, 0.9), { id: 'me', t: 0.5 }];
    const laid = layoutMembers(items, tOf, isSelf, 260, size);
    expect(laid.map((g) => g.items.map((d) => d.id))).toEqual([['d0', 'd1'], ['me'], ['d2']]);
    expect(laid.map((g) => g.x)).toEqual([expect.closeTo(0.105, 12), 0.5, 0.9]);
  });

  it('puts the friends who would cover you on their side of you, or on the other when theirs has no room', () => {
    // Just behind you, with room behind: before your marker.
    const behind = layoutMembers([...dots(0.49), { id: 'me', t: 0.5 }], tOf, isSelf, 260, size);
    expect(behind.map((g) => g.items.map((d) => d.id))).toEqual([['d0'], ['me']]);
    expect(behind[0]!.x * 260).toBeCloseTo(0.5 * 260 - BAR_TARGET_PX, 6);
    // Just behind you at the very start: no room behind, so after it.
    const start = layoutMembers([...dots(0), { id: 'me', t: 0.01 }], tOf, isSelf, 260, size);
    expect(start.map((g) => g.items.map((d) => d.id))).toEqual([['me'], ['d0']]);
  });

  it('takes into the group beside you a group it would otherwise cover', () => {
    // Friends at your place, and one a little further on, alone where it was (it covers no one)…
    const items = [...dots(0.5, 0.5, 0.5, 0.64), { id: 'me', t: 0.5 }];
    expect(groupOnTrack(items.filter((d) => !isSelf(d)), tOf, 260, BAR_TARGET_PX, size).map((g) => g.items.length)).toEqual([3, 1]);
    // …until the group of the three is drawn beside you, over it: then it joins them.
    const laid = layoutMembers(items, tOf, isSelf, 260, size);
    expect(laid.map((g) => g.items.map((d) => d.id))).toEqual([['me'], ['d0', 'd1', 'd2', 'd3']]);
  });

  it('keeps its promises for any club: everyone once, you alone at your place, no two targets overlapping', () => {
    const next = random(20261025);
    for (let run = 0; run < 600; run++) {
      const n = Math.floor(next() * 12);
      // Clusters (a new book, everyone at its start; friends on one page) as well as spread out.
      const pick = () => (next() < 0.4 ? Math.round(next() * 4) / 4 : next());
      const items: Dot[] = Array.from({ length: n }, (_, i) => ({ id: `d${i}`, t: pick() }));
      const withSelf = next() < 0.85;
      if (withSelf) items.splice(Math.floor(next() * (n + 1)), 0, { id: 'me', t: next() < 0.5 && n > 0 ? items[Math.floor(next() * n)]!.t : pick() });
      const width = 200 + Math.floor(next() * 1100);
      const laid = layoutMembers(items, tOf, isSelf, width, size);
      const context = JSON.stringify({ run, width, ts: items.map((d) => [d.id, d.t]) });
      expect(laid.flatMap((g) => g.items.map((d) => d.id)).sort(), context).toEqual(items.map((d) => d.id).sort());
      const own = laid.filter((g) => g.self);
      expect(own.length, context).toBe(withSelf ? 1 : 0);
      if (withSelf) {
        expect(own[0]!.items.map((d) => d.id), context).toEqual(['me']);
        expect(own[0]!.x, context).toBe(items.find(isSelf)!.t);
        expect(laid.filter((g) => !g.self).every((g) => !g.items.some(isSelf)), context).toBe(true);
      }
      const w = (g: (typeof laid)[number]) => (g.self ? BAR_TARGET_PX : size(g.items));
      laid.forEach((g, i) => {
        const prev = laid[i - 1];
        if (prev) expect((g.x - prev.x) * width, context).toBeGreaterThanOrEqual((w(prev) + w(g)) / 2 - 1e-6);
      });
    }
  });
});

/* layoutNotes ---------------------------------------------------------------------------------- */

describe('the notes’ lane, which the next stop’s flag stands in (FR157)', () => {
  // As a group of notes is drawn: a pill a little wider for every note in it.
  const size = (items: readonly Dot[]) => BAR_TARGET_PX + Math.min(3, items.length - 1) * 22;
  /** The flag's box on a track `width` px wide, as app.css draws it. */
  const flag = (t: number, width: number) => ({ lo: t * width - FLAG_PX.before, hi: t * width + FLAG_PX.after });
  const box = (g: { t: number; items: readonly Dot[] }, width: number) => ({ lo: g.t * width - size(g.items) / 2, hi: g.t * width + size(g.items) / 2 });

  it('is groupOnTrack with no stop, or nothing near it', () => {
    const items = dots(0.1, 0.11, 0.6);
    expect(layoutNotes(items, tOf, 260, null, size)).toEqual(groupOnTrack(items, tOf, 260, BAR_TARGET_PX, size));
    expect(layoutNotes(items, tOf, 260, 0.35, size)).toEqual(groupOnTrack(items, tOf, 260, BAR_TARGET_PX, size));
  });

  it('puts a note at the stop after the flag, one just before it before, the flag where it is', () => {
    const at = layoutNotes(dots(0.5), tOf, 260, 0.5, size);
    expect(box(at[0]!, 260).lo).toBeGreaterThanOrEqual(flag(0.5, 260).hi);
    const before = layoutNotes(dots(0.49), tOf, 260, 0.5, size);
    expect(box(before[0]!, 260).hi).toBeLessThanOrEqual(flag(0.5, 260).lo);
    // Notes on both sides of it, which would be one group, are two: each on its own side.
    const both = layoutNotes(dots(0.495, 0.5, 0.505), tOf, 260, 0.5, size);
    expect(both.map((g) => g.items.map((d) => d.id))).toEqual([['d0'], ['d1', 'd2']]);
  });

  it('gives its side’s notes to the other where the track ends too soon', () => {
    const start = layoutNotes(dots(0, 0.001), tOf, 300, 0.02, size);
    expect(start).toHaveLength(1);
    expect(box(start[0]!, 300).lo).toBeGreaterThanOrEqual(flag(0.02, 300).hi);
  });

  it('keeps its promises for any notes and stop: every note once, none over the flag or another', () => {
    const next = random(20261025);
    for (let run = 0; run < 600; run++) {
      const n = Math.floor(next() * 14);
      const width = 200 + Math.floor(next() * 1100);
      // The stop away from the track's ends by more than a pill or two, as a chapter's end is.
      const stop = 0.15 + next() * 0.7;
      const pick = () => (next() < 0.4 ? stop + (next() - 0.5) * 0.05 : next());
      const items: Dot[] = Array.from({ length: n }, (_, i) => ({ id: `d${i}`, t: pick() }));
      const laid = layoutNotes(items, tOf, width, stop, size);
      const context = JSON.stringify({ run, width, stop, ts: items.map(tOf) });
      expect(laid.flatMap((g) => g.items.map((d) => d.id)).sort(), context).toEqual(items.map((d) => d.id).sort());
      const f = flag(stop, width);
      laid.forEach((g, i) => {
        const b = box(g, width);
        expect(b.hi <= f.lo + 1e-6 || b.lo >= f.hi - 1e-6, context).toBe(true);
        const prev = laid[i - 1];
        if (prev) expect(b.lo, context).toBeGreaterThanOrEqual(box(prev, width).hi - 1e-6);
      });
    }
  });

  it('draws the flag where the stop is, and a note there beside it', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(260);
    const meeting = { t: 0.5, label: 'The end of Chapter 6', on: null, setBy: { userId: 'user_ana', displayName: 'Ana' }, setAt: '2026-10-25T10:00:00.000Z' };
    render(<ClubBar bookId="book_alice" members={[member('user_cole', 0.1)]} selfId="user_cole" comments={[hiddenNote('c1', 'Ana', 0.5, '😱')]} meeting={meeting} />);
    const flagEl = screen.getByTestId('meeting-flag');
    expect(left(flagEl)).toBe(50);
    const note = screen.getByTestId('bar-comment');
    expect((left(note) / 100) * 260 - BAR_TARGET_PX / 2).toBeGreaterThanOrEqual(0.5 * 260 + FLAG_PX.after);
  });
});
