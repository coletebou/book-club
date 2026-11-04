import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { BookSummary, MemberProgress } from '@bookclub/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIO_CONTROLS_STORAGE_KEY, chooseBookAudioControls, chooseAudioControlsDefault } from '../player/audio-controls';
import { BookCard, cardStep } from './BookCard';

afterEach(() => {
  cleanup();
  localStorage.removeItem(AUDIO_CONTROLS_STORAGE_KEY);
});

const member = (userId: string, over: Partial<MemberProgress> = {}): MemberProgress => ({
  userId,
  displayName: userId === 'user_fern' ? 'Fern' : 'Ana',
  color: '#D6B85E',
  t: 0,
  furthest: 0,
  coverage: 0,
  kind: null,
  label: '',
  updatedAt: null,
  finished: false,
  ...over,
});

const book = (kinds: BookSummary['kinds'], fern: Partial<MemberProgress> = {}): BookSummary => ({
  id: 'book_alice',
  clubId: 'club_1',
  title: "Alice's Adventures in Wonderland",
  author: 'Lewis Carroll',
  coverUrl: '/media/books/book_alice/cover',
  hasCover: true,
  kinds,
  createdAt: '2026-10-25T10:00:00.000Z',
  addedBy: 'user_ana',
  commentCount: 0,
  progress: [member('user_ana', { t: 0.4, furthest: 0.4, updatedAt: '2026-10-25T11:00:00.000Z', kind: 'epub' }), member('user_fern', fern)],
  meeting: null,
});

describe('a book card’s one step (D198)', () => {
  it('opens a book you have not started: Open into the text when it has one', () => {
    expect(cardStep(book(['epub', 'audio']), 'user_fern')).toEqual({ label: 'Open', to: '/books/book_alice/read', testId: 'card-start' });
    expect(cardStep(book(['audio', 'pdf']), 'user_fern')).toEqual({ label: 'Open', to: '/books/book_alice/read', testId: 'card-start' });
    expect(cardStep(book(['pdf']), 'user_fern')).toMatchObject({ label: 'Open', to: '/books/book_alice/read' });
  });

  it('opens an audiobook alone in the player', () => {
    expect(cardStep(book(['audio']), 'user_fern')).toEqual({ label: 'Open', to: '/books/book_alice/listen', testId: 'card-start' });
  });

  it('once you have a place, Continue into the text (audiobook along when you were listening)', () => {
    const reading = { t: 0.2, furthest: 0.2, updatedAt: '2026-10-25T12:00:00.000Z', kind: 'pdf' as const };
    expect(cardStep(book(['epub', 'pdf'], reading), 'user_fern')).toEqual({ label: 'Continue', to: '/books/book_alice/read', testId: 'card-continue' });
    expect(cardStep(book(['epub', 'audio'], { ...reading, kind: 'audio' }), 'user_fern')).toEqual({
      label: 'Continue',
      to: '/books/book_alice/read?along=1',
      testId: 'card-continue',
    });
    expect(cardStep(book(['epub'], { updatedAt: '2026-10-25T12:00:00.000Z', kind: 'epub' }), 'user_fern')).toMatchObject({ label: 'Continue' });
    expect(cardStep(book(['audio'], { ...reading, kind: 'audio' }), 'user_fern')).toEqual({
      label: 'Continue',
      to: '/books/book_alice/listen',
      testId: 'card-continue',
    });
  });


  it('skips along when the audiobook is hidden for this book or by default (D198)', async () => {
    const listening = { t: 0.2, furthest: 0.2, updatedAt: '2026-10-25T12:00:00.000Z', kind: 'audio' as const };
    await chooseBookAudioControls('user_fern', 'book_alice', true);
    expect(cardStep(book(['epub', 'audio'], listening), 'user_fern')).toEqual({
      label: 'Continue',
      to: '/books/book_alice/read',
      testId: 'card-continue',
    });
    localStorage.removeItem(AUDIO_CONTROLS_STORAGE_KEY);
    await chooseAudioControlsDefault('user_fern', true);
    expect(cardStep(book(['epub', 'audio'], listening), 'user_fern')).toEqual({
      label: 'Continue',
      to: '/books/book_alice/read',
      testId: 'card-continue',
    });
  });

  it('offers nothing for a book you have finished, or one with nothing ready yet', () => {
    expect(cardStep(book(['epub'], { t: 1, furthest: 1, updatedAt: '2026-10-25T12:00:00.000Z', kind: 'epub', finished: true }), 'user_fern')).toBeNull();
    expect(cardStep(book([]), 'user_fern')).toBeNull();
  });

  it('is on the card, a link into the book', () => {
    render(
      <MemoryRouter>
        <ul>
          <BookCard book={book(['epub', 'pdf', 'audio'])} presence={new Map()} selfId="user_fern" />
        </ul>
      </MemoryRouter>,
    );
    const start = screen.getByRole('link', { name: 'Open' });
    expect(start.getAttribute('href')).toBe('/books/book_alice/read');
    expect(start.getAttribute('data-testid')).toBe('card-start');
    expect(screen.queryByTestId('card-continue')).toBeNull();
    expect(screen.getByRole('link', { name: /Alice's Adventures in Wonderland/ }).getAttribute('href')).toBe('/books/book_alice');
  });
});
