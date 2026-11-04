import type { BookSummary, MemberProgress } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { lastRead, orderBooks, readingOn } from './LibraryPage';

const progress = (userId: string, updatedAt: string | null): MemberProgress => ({
  userId,
  displayName: userId,
  color: '#4ECDC4',
  t: 0.3,
  furthest: 0.3,
  coverage: 0.3,
  kind: 'epub',
  label: '30%',
  updatedAt,
  finished: false,
});

function book(id: string, createdAt: string, readAt: (string | null)[] = []): BookSummary {
  return {
    id,
    clubId: 'club_123',
    title: id,
    author: 'Someone',
    coverUrl: `/api/books/${id}/cover?v=1`,
    hasCover: false,
    kinds: ['epub'],
    createdAt,
    addedBy: 'user_ana',
    commentCount: 0, meeting: null,
    progress: readAt.map((at, i) => progress(`user_${i}`, at)),
  };
}

const ids = (books: readonly BookSummary[]) => books.map((b) => b.id);

describe('orderBooks', () => {
  it('puts the book someone read most recently first', () => {
    const books = [
      book('book_old_but_read_today', '2026-01-01T00:00:00.000Z', ['2026-10-23T09:00:00.000Z']),
      book('book_read_last_week', '2026-05-01T00:00:00.000Z', [null, '2026-10-16T09:00:00.000Z']),
      book('book_read_yesterday', '2026-03-01T00:00:00.000Z', ['2026-10-10T09:00:00.000Z', '2026-10-22T09:00:00.000Z']),
    ];
    expect(ids(orderBooks(books))).toEqual(['book_old_but_read_today', 'book_read_yesterday', 'book_read_last_week']);
  });

  it('counts a book nobody has opened from when it was added', () => {
    const books = [
      book('book_read_in_june', '2026-01-01T00:00:00.000Z', ['2026-06-01T00:00:00.000Z']),
      book('book_added_today', '2026-10-23T08:00:00.000Z', [null, null]),
      book('book_added_in_march', '2026-03-01T00:00:00.000Z'),
    ];
    expect(ids(orderBooks(books))).toEqual(['book_added_today', 'book_read_in_june', 'book_added_in_march']);
  });

  it('never ranks a book below when it was added because of an old reading time', () => {
    // A progress time older than the book itself (a clock off on some device) does not hold it back.
    const books = [book('book_a', '2026-10-20T00:00:00.000Z', ['2020-01-01T00:00:00.000Z']), book('book_b', '2026-10-10T00:00:00.000Z')];
    expect(ids(orderBooks(books))).toEqual(['book_a', 'book_b']);
  });

  it('returns a new list and leaves the one it was given alone', () => {
    const books = [book('book_1', '2026-01-01T00:00:00.000Z'), book('book_2', '2026-02-01T00:00:00.000Z')];
    const ordered = orderBooks(books);
    expect(ids(ordered)).toEqual(['book_2', 'book_1']);
    expect(ids(books)).toEqual(['book_1', 'book_2']);
    expect(ordered).not.toBe(books);
  });

  it('handles an empty library', () => {
    expect(orderBooks([])).toEqual([]);
  });

  it('puts the books you are reading first, the one you read last at the top, whatever was added since', () => {
    const books = [
      book('book_added_today', '2026-10-23T08:00:00.000Z', [null]),
      book('book_you_read_yesterday', '2026-01-01T00:00:00.000Z', ['2026-10-22T09:00:00.000Z']),
      book('book_a_friend_read_today', '2026-02-01T00:00:00.000Z', [null, '2026-10-23T09:00:00.000Z']),
    ];
    // user_0 is the first reader of each book.
    expect(ids(orderBooks(books, 'user_0'))).toEqual(['book_you_read_yesterday', 'book_a_friend_read_today', 'book_added_today']);
    // Without you, as before.
    expect(ids(orderBooks(books))).toEqual(['book_a_friend_read_today', 'book_added_today', 'book_you_read_yesterday']);
  });
});

describe('the book you read last', () => {
  const mine = (over: Partial<MemberProgress>): MemberProgress => ({ ...progress('user_0', '2026-10-22T09:00:00.000Z'), ...over });
  const withMine = (id: string, me: MemberProgress | null, clubId = 'club_123'): BookSummary => ({ ...book(id, '2026-01-01T00:00:00.000Z'), clubId, progress: me ? [me] : [] });

  it('is a book you have begun and not finished', () => {
    expect(readingOn(withMine('book_a', mine({})), 'user_0')?.label).toBe('30%');
    expect(readingOn(withMine('book_a', mine({ finished: true })), 'user_0')).toBeNull();
    expect(readingOn(withMine('book_a', mine({ updatedAt: null })), 'user_0')).toBeNull();
    // Someone else's place is not yours; nobody signed in has none.
    expect(readingOn(withMine('book_a', mine({})), 'user_1')).toBeNull();
    expect(readingOn(withMine('book_a', mine({})), undefined)).toBeNull();
  });

  it('is the one you were in last, whichever club it is in, finished books aside', () => {
    const books = [
      withMine('book_thursday', mine({ updatedAt: '2026-10-20T09:00:00.000Z' }), 'club_thursday'),
      withMine('book_poetry', mine({ updatedAt: '2026-10-23T21:00:00.000Z', kind: 'audio' }), 'club_poetry'),
      withMine('book_done', mine({ updatedAt: '2026-10-24T09:00:00.000Z', finished: true }), 'club_poetry'),
      withMine('book_untouched', null, 'club_thursday'),
    ];
    const last = lastRead(books, 'user_0');
    expect(last?.book.id).toBe('book_poetry');
    expect(last?.mine.kind).toBe('audio');
    expect(lastRead(books.slice(2), 'user_0')).toBeNull();
    expect(lastRead([], 'user_0')).toBeNull();
  });

  it('is the first of the library’s order (the banner and the first card agree)', () => {
    const books = [
      book('book_added_today', '2026-10-23T08:00:00.000Z', [null]),
      book('book_you_read_yesterday', '2026-01-01T00:00:00.000Z', ['2026-10-22T09:00:00.000Z']),
      book('book_you_read_today', '2026-02-01T00:00:00.000Z', ['2026-10-23T09:00:00.000Z']),
    ];
    expect(lastRead(books, 'user_0')?.book.id).toBe(orderBooks(books, 'user_0')[0]!.id);
  });
});
