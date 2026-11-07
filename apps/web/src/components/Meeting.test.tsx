import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BookDetail, Meeting, MemberProgress } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClubBar } from './ClubBar';
import { MeetingCard, MeetingLine, MeetingReachedCard, meetingHeadline, meetingReachedLine, meetingTally, showNotesLabel } from './Meeting';

afterEach(cleanup);

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  t: 0.25,
  label: 'the end of Chapter 2',
  on: null,
  at: null,
  tz: null,
  minutes: null,
  place: null,
  rsvps: [],
  setBy: { userId: 'user_ana', displayName: 'Ana' },
  setAt: '2026-10-23T20:00:00.000Z',
  ...over,
});

const member = (userId: string, furthest: number, finished = false): MemberProgress => ({
  userId,
  displayName: userId.replace('user_', ''),
  color: '#D6B85E',
  t: furthest,
  furthest,
  coverage: furthest,
  kind: 'epub',
  label: '',
  updatedAt: null,
  finished,
});

describe('the next stop', () => {
  it('reads as a place and, if set, a day', () => {
    const friday = new Date(2026, 9, 23, 20);
    expect(meetingHeadline(meeting(), friday)).toBe('The end of Chapter 2');
    expect(meetingHeadline(meeting({ on: '2026-10-25' }), friday)).toBe('The end of Chapter 2, by Sunday');
    expect(meetingHeadline(meeting({ on: '2026-10-24' }), friday)).toBe('The end of Chapter 2, by tomorrow');
    // A day gone by is not one to read by any more.
    expect(meetingHeadline(meeting({ on: '2026-10-22' }), friday)).toBe('The end of Chapter 2, planned for yesterday');
  });

  it('counts who is there, finished readers included', () => {
    expect(meetingTally(meeting(), [member('user_ana', 0.3), member('user_ben', 0.1), member('user_cleo', 0.05, true)])).toBe('2 of 3 there');
    expect(meetingTally(meeting(), [member('user_ana', 0.3), member('user_ben', 0.25)])).toBe('everyone is there');
    expect(meetingTally(meeting(), [member('user_ana', 0.3)])).toBe('1 of 1 there');
  });

  it('shows on the library card, and as a flag on the club bar, named for screen readers', () => {
    render(<MeetingLine meeting={meeting()} progress={[member('user_ana', 0.3), member('user_ben', 0.1)]} />);
    expect(screen.getByTestId('meeting-line').textContent).toBe(' The end of Chapter 2 · 1 of 2 there');
    cleanup();
    render(<ClubBar bookId="book_1" members={[]} meeting={meeting()} />);
    const flag = screen.getByRole('img', { name: 'Next stop: The end of Chapter 2' });
    expect(parseFloat(flag.style.left)).toBe(25);
    cleanup();
    render(<ClubBar bookId="book_1" members={[]} meeting={meeting()} compact />);
    expect(screen.getByTestId('meeting-flag').getAttribute('aria-hidden')).toBe('true');
    cleanup();
    render(<ClubBar bookId="book_1" members={[]} />);
    expect(screen.queryByTestId('meeting-flag')).toBeNull();
  });

  it('greets you there, with whoever is there already', () => {
    const { rerender } = render(<MeetingReachedCard meeting={meeting()} others={['Ana', 'Cleo']} notes={null} onClose={() => undefined} />);
    expect(screen.getByRole('status').textContent?.trim()).toBe('You’re at the next stop, with Ana and Cleo.');
    // Short enough for a phone's footer; the stop itself is named on hover and to the club bar.
    expect(screen.getByTitle('The club’s next stop: the end of Chapter 2')).toBeTruthy();
    // A friend who has finished is past the stop, not waiting at it.
    rerender(<MeetingReachedCard meeting={meeting()} others={['Ana']} finished={['Cleo']} notes={null} onClose={() => undefined} />);
    expect(screen.getByRole('status').textContent?.trim()).toBe('You’re at the next stop, with Ana. Cleo has finished the book.');
    rerender(<MeetingReachedCard meeting={meeting()} others={[]} finished={['Cleo']} notes={null} onClose={() => undefined} />);
    expect(screen.getByRole('status').textContent?.trim()).toBe('You’re at the next stop. Cleo has finished the book.');
    rerender(<MeetingReachedCard meeting={meeting()} others={[]} notes={{ count: 3, onShow: () => undefined }} onClose={() => undefined} />);
    expect(screen.getByRole('status').textContent).toContain('You’re the first at the next stop.');
    expect(screen.getByRole('button', { name: 'Show 3 notes' })).toBeTruthy();
  });

  it('says it all in fewer words than it did, for a phone’s footer (fidelity review round 16)', () => {
    // "You’re at the next stop. Ana and Cleo are here too." was cut at "are…" beside "Show Ana’s note".
    expect(meetingReachedLine(['Ana', 'Cleo'])).toBe('You’re at the next stop, with Ana and Cleo.');
    expect(meetingReachedLine(['Ana', 'Cleo']).length).toBeLessThan('You’re at the next stop. Ana and Cleo are here too.'.length);
    expect(meetingReachedLine(['Ana', 'Ben', 'Cleo', 'Dee'])).toBe('You’re at the next stop, with Ana, Ben and 2 others.');
    expect(meetingReachedLine([], ['Cleo', 'Dee'])).toBe('You’re at the next stop. Cleo and Dee have finished the book.');
    expect(meetingReachedLine([])).toBe('You’re the first at the next stop.');
  });

  it('names whose notes it offers from the chapter just ended, and how many', () => {
    expect(showNotesLabel(1, ['Ana'])).toEqual({ text: 'Show Ana’s note' });
    expect(showNotesLabel(2, ['Ana'])).toEqual({ text: 'Show Ana’s 2 notes' });
    // From several friends: how many on the button, and whose to a screen reader (the button's
    // words first in its name, WCAG 2.5.3).
    expect(showNotesLabel(3, ['Ana', 'Ben'])).toEqual({ text: 'Show 3 notes', name: 'Show 3 notes from Ana and Ben' });
    expect(showNotesLabel(4, ['Ana', 'Ben', 'Cleo'])).toEqual({ text: 'Show 4 notes', name: 'Show 4 notes from Ana, Ben and Cleo' });
    expect(showNotesLabel(1)).toEqual({ text: 'Show the note' });

    let shown = 0;
    render(<MeetingReachedCard meeting={meeting()} others={['Ana']} finished={['Cleo']} notes={{ count: 1, names: ['Ana'], onShow: () => shown++ }} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Ana’s note' }));
    expect(shown).toBe(1);
    cleanup();
    render(<MeetingReachedCard meeting={meeting()} others={[]} notes={{ count: 3, names: ['Ana', 'Ben'], onShow: () => undefined }} onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Show 3 notes from Ana and Ben' }).textContent).toBe('Show 3 notes');
  });

  it('lists the stops to choose with their chapters’ titles, and saves the stop by its place', () => {
    const chapter = (index: number, title: string, t: number) => ({ index, title, t });
    const book = {
      id: 'book_1',
      clubId: 'club_1',
      title: 'Alice',
      author: 'Lewis Carroll',
      meeting: meeting({ t: 0.5, label: 'the end of Chapter 2' }),
      chapters: [chapter(0, 'CHAPTER I. Down the Rabbit-Hole', 0), chapter(1, 'CHAPTER II. The Pool of Tears', 0.25), chapter(2, 'CHAPTER III. A Caucus-Race and a Long Tale', 0.5), chapter(3, 'CHAPTER IV.', 0.75)],
      editions: [],
      progress: [],
    } as unknown as BookDetail;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MeetingCard book={book} progress={[member('user_ana', 0.3)]} selfId="user_ana" />
      </QueryClientProvider>,
    );
    // The card says the stop as it is saved.
    expect(screen.getByTestId('meeting-headline').textContent).toBe(' The end of Chapter 2');
    fireEvent.click(screen.getByTestId('meeting-change'));
    const select = within(screen.getByRole('dialog', { name: 'The next stop' })).getByLabelText<HTMLSelectElement>('Read up to');
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['0.25', 'The end of Chapter 1 · Down the Rabbit-Hole'],
      ['0.5', 'The end of Chapter 2 · The Pool of Tears'],
      ['0.75', 'The end of Chapter 3 · A Caucus-Race and a Long Tale'],
      // Chapter 4 has no title beyond its number; its end is the book's.
      ['1', 'The end of the book'],
    ]);
    expect(select.value).toBe('0.5');
  });

  describe('as a meet-up (D206)', () => {
    const NY = 'America/New_York';
    // Tuesday 10 November 2026, noon in New York; the meet-up is Friday at half past seven there.
    const tuesday = new Date('2026-11-10T17:00:00.000Z');
    const at = '2026-11-14T00:30:00.000Z';
    const meetup = (over: Partial<Meeting> = {}) => meeting({ on: '2026-11-13', at, tz: NY, minutes: 90, ...over });

    it('reads as the stop and the evening, on your clock, with the setter’s when it reads differently', () => {
      expect(meetingHeadline(meetup(), tuesday, NY)).toBe('The end of Chapter 2, by Friday, 7:30 pm');
      expect(meetingHeadline(meetup(), tuesday, 'Europe/London')).toBe('The end of Chapter 2, by Saturday, 12:30 am (7:30 pm in New York)');
      // The library card keeps it short.
      expect(meetingHeadline(meetup(), tuesday, 'Europe/London', true)).toBe('The end of Chapter 2, by Saturday, 12:30 am');
      // Over (with its call's hour of grace): planned for.
      expect(meetingHeadline(meetup(), new Date('2026-11-16T12:00:00.000Z'), NY)).toBe('The end of Chapter 2, planned for Friday 13 November, 7:30 pm');
    });

    it('the library card says how many are coming, once anyone has', () => {
      const rsvps = [
        { userId: 'user_ana', displayName: 'Ana', answer: 'yes' as const },
        { userId: 'user_ben', displayName: 'Ben', answer: 'maybe' as const },
        { userId: 'user_cleo', displayName: 'Cleo', answer: 'yes' as const },
      ];
      render(<MeetingLine meeting={meetup({ rsvps })} progress={[member('user_ana', 0.3)]} />);
      expect(screen.getByTestId('meeting-line').textContent).toMatch(/ · 1 of 1 there · 2 coming$/);
      cleanup();
      render(<MeetingLine meeting={meetup()} progress={[member('user_ana', 0.3)]} />);
      expect(screen.getByTestId('meeting-line').textContent).not.toContain('coming');
    });

    const bookWith = (m: Meeting) =>
      ({ id: 'book_1', clubId: 'club_1', title: 'Alice', author: 'Lewis Carroll', meeting: m, chapters: [], editions: [], progress: [] }) as unknown as BookDetail;
    const renderCard = (m: Meeting, selfId = 'user_ana') =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MeetingCard book={bookWith(m)} progress={[member('user_ana', 0.3), member('user_ben', 0.1)]} selfId={selfId} />
        </QueryClientProvider>,
      );

    it('asks whether you are coming, shows your answer and everyone’s, and offers the calendar', () => {
      vi.useFakeTimers({ now: tuesday, toFake: ['Date'] });
      try {
        renderCard(meetup({ rsvps: [{ userId: 'user_ben', displayName: 'Ben', answer: 'yes' }, { userId: 'user_ana', displayName: 'Ana', answer: 'maybe' }] }));
        expect(screen.getByRole('group', { name: 'Are you coming?' })).toBeTruthy();
        expect(screen.getByTestId('rsvp-maybe').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('rsvp-yes').getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByTestId('rsvp-summary').textContent).toBe('Ben is coming · you maybe');
        expect(screen.getByTestId('meetup-ics').getAttribute('href')).toBe('/api/books/book_1/meeting.ics');
      } finally {
        vi.useRealTimers();
      }
    });

    it('says where: a place as written, a video call by its site, the club’s voice room', () => {
      vi.useFakeTimers({ now: tuesday, toFake: ['Date'] });
      try {
        renderCard(meetup({ place: { kind: 'place', value: 'Ana’s, 12 Elm Street' } }));
        expect(screen.getByTestId('meetup-place').textContent).toBe(' Ana’s, 12 Elm Street');
        cleanup();
        renderCard(meetup({ place: { kind: 'link', value: 'https://meet.example/abc-def' } }));
        const link = within(screen.getByTestId('meetup-place')).getByRole('link');
        expect(link.textContent).toBe('meet.example');
        expect(link.getAttribute('href')).toBe('https://meet.example/abc-def');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        cleanup();
        renderCard(meetup({ place: { kind: 'voice', value: '' } }));
        expect(screen.getByTestId('meetup-place').textContent).toBe(' In the club’s voice room');
        // Two days before, the call is not open yet.
        expect(screen.queryByTestId('meetup-call')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('asks nothing once the meet-up is over, nor before it has a day', () => {
      vi.useFakeTimers({ now: new Date('2026-11-16T12:00:00.000Z'), toFake: ['Date'] });
      try {
        renderCard(meetup());
        expect(screen.queryByTestId('meetup-rsvp')).toBeNull();
        expect(screen.queryByTestId('meetup-ics')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
      cleanup();
      renderCard(meeting());
      expect(screen.queryByTestId('meetup-rsvp')).toBeNull();
    });
  });
});
