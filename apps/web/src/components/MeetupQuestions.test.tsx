import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { MeetupQuestionList } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { calApi } from '../lib/cal-api';
import { MeetupQuestions } from './MeetupQuestions';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const listOf = (over: Partial<MeetupQuestionList> = {}): MeetupQuestionList => ({
  stop: { t: 0.25, label: 'the end of Chapter 2' },
  questions: [
    { id: 'q_1aaaaa', text: 'Why does Alice keep changing size?', author: { userId: 'user_ana', displayName: 'Ana' }, askedBy: null, votes: 2, voted: true, removable: false, createdAt: '2026-11-07T10:00:00.000Z' },
    { id: 'q_2bbbbb', text: 'Is the Mouse ever kind?', author: null, askedBy: { userId: 'user_me', displayName: 'Me' }, votes: 0, voted: false, removable: true, createdAt: '2026-11-07T10:05:00.000Z' },
  ],
  held: { count: 3, opensAt: 'the end of Chapter 2' },
  ...over,
});

function show(list: MeetupQuestionList, calEnabled = false) {
  vi.spyOn(api, 'questions').mockResolvedValue(list);
  vi.spyOn(calApi, 'status').mockResolvedValue({ enabled: calEnabled, webSearch: false });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MeetupQuestions bookId="book_1" clubId="club_1" selfId="user_me" />
    </QueryClientProvider>,
  );
}

describe('questions for the meet-up (D209)', () => {
  it('lists the open ones with their votes and who asked, and counts the rest without a word of them', async () => {
    show(listOf());
    const items = await screen.findAllByTestId('meetup-question');
    expect(items.map((i) => i.querySelector('.question-text')!.textContent)).toEqual(['Why does Alice keep changing size?', 'Is the Mouse ever kind?']);
    expect(items[0]!.textContent).toContain('Ana');
    expect(items[1]!.textContent).toContain('Cal, asked by you');
    const votes = screen.getAllByTestId('question-vote');
    expect(votes[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(votes[0]!.textContent).toContain('2');
    // Only what is yours to remove offers it.
    expect(screen.getAllByTestId('question-remove')).toHaveLength(1);
    expect(screen.getByTestId('questions-held').textContent).toBe(' 3 more questions open for you at the end of Chapter 2.');
  });

  it('offers Cal only where he is set up', async () => {
    show(listOf(), true);
    expect(await screen.findByTestId('questions-ask-cal')).toBeTruthy();
    cleanup();
    show(listOf(), false);
    await screen.findAllByTestId('meetup-question');
    expect(screen.queryByTestId('questions-ask-cal')).toBeNull();
  });

  it('with nothing open yet, says so; with no stop, shows nothing at all', async () => {
    show(listOf({ questions: [], held: { count: 1, opensAt: 'the end of Chapter 2' } }));
    expect((await screen.findByTestId('questions-empty')).textContent).toBe('None for you yet.');
    expect(screen.getByTestId('questions-held').textContent).toBe(' One more question opens for you at the end of Chapter 2.');
    cleanup();
    show({ stop: null, questions: [], held: { count: 0, opensAt: null } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('meetup-questions')).toBeNull();
  });
});
