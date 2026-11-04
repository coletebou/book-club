import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import type { BookDetail, CommentView, NotificationView, SessionInfo } from '@bookclub/shared';
import { afterEach, describe as group, expect, it } from 'vitest';
import type { AnswerOpen } from '../lib/answer-open';
import { useNoteOpener } from '../lib/note-opener';
import { keys } from '../lib/queries';
import { NotificationToasts, describe } from './Notifications';
import { ToastProvider } from './Toasts';

afterEach(cleanup);

const reply: NotificationView = {
  id: 'n_1',
  kind: 'reply',
  bookId: 'book_1',
  bookTitle: 'Alice',
  commentId: 'reply_1',
  noteId: 'note_1',
  clubId: null,
  clubName: null,
  chatMessageId: null,
  actorName: 'Cleo',
  actorColor: '#D6B85E',
  where: 'Chapter 1 · 2%',
  text: null,
  horizon: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  read: false,
};

group('what the bell and the toasts say', () => {
  it('a reply you may read, with its first words', () => {
    expect(describe({ ...reply, text: 'In chapter 9 the Mock Turtle tells his story' })).toBe('Cleo replied: “In chapter 9 the Mock Turtle tells his story”');
  });

  it('a reply from further on than you have read: where it was written from, without its words (D69)', () => {
    expect(describe({ ...reply, horizon: 'Chapter 9' })).toBe('Cleo replied from Chapter 9 · it opens when you get there');
    // One whose note's place you have not read yet: only who.
    expect(describe(reply)).toBe('Cleo replied');
  });

  it('a friend reaching your note: who, never anything else', () => {
    expect(describe({ ...reply, kind: 'reached', text: null, horizon: null, actorName: 'Ben' })).toBe('Ben got to your note');
  });

  it('a mention (D152): its words once open, else where it waits', () => {
    const mention: NotificationView = { ...reply, kind: 'mention', bookId: null, bookTitle: null, commentId: null, noteId: null, clubId: 'club_1', clubName: 'Thursday Readers', chatMessageId: 'msg_1', actorName: 'Ana' };
    expect(describe({ ...mention, text: 'check this out' })).toBe('Ana mentioned you: “check this out”');
    expect(describe({ ...mention, text: null, horizon: 'Chapter 9' })).toBe('Ana mentioned you from Chapter 9 · it opens when you get there');
    expect(describe({ ...mention, text: null, horizon: null })).toBe('Ana mentioned you');
  });
});

/** Where the app is: the address, and what the link said of the answer in it. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.hash} ${JSON.stringify(location.state)}`}</output>;
}

/** A reader of the book, open: it shows its notes in its sheet. */
function Reader({ opened }: { opened: string[] }) {
  useNoteOpener('book_1', (id) => {
    opened.push(id);
    return true;
  });
  return null;
}

function app(options: { reading?: string[] } = {}) {
  const qc = new QueryClient();
  qc.setQueryData<SessionInfo>(keys.session, { user: { id: 'user_cole', displayName: 'Cole', email: null, color: '#000', source: 'local' }, setupRequired: false, upstream: null });
  // Only its chapters matter here.
  qc.setQueryData<Pick<BookDetail, 'chapters'>>(keys.book('book_1'), {
    chapters: [
      { index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0 },
      { index: 1, title: 'CHAPTER II. The Pool of Tears', t: 0.25 },
    ],
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/clubs/club_1']}>
          <NotificationToasts />
          <Where />
          {options.reading ? <Reader opened={options.reading} /> : null}
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const note: CommentView = {
  id: 'note_1',
  bookId: 'book_1',
  userId: 'user_cole',
  authorName: 'Cole',
  color: '#D6B85E',
  t: 0.3,
  editionId: 'ed_1',
  kind: 'epub',
  locator: { kind: 'epub', section: 4, offset: 0 },
  reaction: null,
  createdAt: '2026-10-25T10:00:00.000Z',
  hidden: false,
  endLocator: null,
  endT: null,
  quote: null,
  text: 'Curiouser and curiouser',
};
const answer: CommentView = { ...note, id: 'reply_2', userId: 'user_ana', authorName: 'Ana', parentId: 'note_1', text: 'Telescopes!' };
const tell = <T,>(type: string, detail: T) => act(() => void window.dispatchEvent(new CustomEvent<T>(type, { detail })));

group('the toasts of notifications', () => {
  it('show the conversation from anywhere: the note on the book page, the answer in it named', () => {
    app();
    tell<NotificationView>('bc-notification', { ...reply, text: 'Me too' });
    expect(screen.getByTestId('toast').querySelector('.toast-text')!.textContent).toBe('Cleo replied: “Me too” · Alice');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByTestId('where').textContent).toBe('/books/book_1#note-note_1 {"comment":"reply_1"}');
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
  });

  it('in the reader of its book, open the note’s sheet there, and leave the book’s title unsaid', () => {
    const opened: string[] = [];
    app({ reading: opened });
    tell<NotificationView>('bc-notification', { ...reply, kind: 'reached', actorName: 'Ben' });
    expect(screen.getByTestId('toast').querySelector('.toast-text')!.textContent).toBe('Ben got to your note');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(opened).toEqual(['note_1']);
    expect(screen.getByTestId('where').textContent).toBe('/clubs/club_1 null');
  });

  it('name an answer that opened as you read on: whose note, and where, with a way to it', () => {
    app();
    tell<AnswerOpen>('bc-answer-open', { answer, note });
    expect(screen.getByTestId('toast').querySelector('.toast-text')!.textContent).toBe('Ana’s answer to your note in Chapter 2 is open now.');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByTestId('where').textContent).toBe('/books/book_1#note-note_1 {"comment":"reply_2"}');
  });
});
