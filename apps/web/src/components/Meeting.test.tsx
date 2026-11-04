import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BookDetail, Meeting, MemberProgress } from '@bookclub/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ClubBar } from './ClubBar';
import { MeetingCard, MeetingLine, MeetingReachedCard, meetingHeadline, meetingReachedLine, meetingTally, showNotesLabel } from './Meeting';

afterEach(cleanup);

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  t: 0.25,
  label: 'the end of Chapter 2',
  on: null,
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
});
