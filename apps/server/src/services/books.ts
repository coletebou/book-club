import {
  type BookDetail,
  type BookSummary,
  type Chapter,
  type Edition,
  type Member,
  type Meeting,
  type MeetupPlace,
  type MemberProgress,
  rangesFurthest,
  stopLabel,
} from '@bookclub/shared';
import { type Db } from '../db/db';
import { COVER_DRAWING } from '../ingest/covers';
import { iso, isoRequired } from '../lib/json';
import { type BookRow, type EditionForProgress, bookChapters, booksForClub, editionById, editionsForBook, editionsForClub, toEditionView } from '../repos/books';
import { colorInClub, members } from '../repos/clubs';
import { commentCountsForClub, countCommentsForBook } from '../repos/comments';
import { type MeetingRow, type RsvpRow, meetingFor, meetingsForClub, occasionOf, rsvpsFor, rsvpsForClub } from '../repos/meetings';
import { type ProgressRow, progressForBook, progressForClub, readRanges } from '../repos/progress';
import { savedPlaceLabel } from './labels';

export function coverUrl(book: BookRow): string {
  return `/media/books/${book.id}/cover?v=${book.cover_blob_id ? `${book.cover_blob_id}.${COVER_DRAWING}` : 'generated'}`;
}

export function memberProgressList(db: Db, book: BookRow): MemberProgress[] {
  return progressViews(book, members(db, book.club_id), progressForBook(db, book.id), (id) => editionById(db, id));
}

function progressViews(
  book: BookRow,
  clubMembers: readonly Member[],
  progress: readonly ProgressRow[],
  findEdition: (id: string) => EditionForProgress | undefined,
): MemberProgress[] {
  const rows = new Map(progress.map((row) => [row.user_id, row]));
  const chapters = bookChapters(book);
  return clubMembers.map((member) => {
    const row = rows.get(member.userId);
    if (!row) return emptyProgress(member.userId, member.displayName, member.color);
    const edition = row.edition_id ? findEdition(row.edition_id) : undefined;
    return progressView(row, member.displayName, chapters, member.color, edition);
  });
}

function emptyProgress(userId: string, displayName: string, color: string): MemberProgress {
  return {
    userId,
    displayName,
    color,
    t: 0,
    furthest: 0,
    coverage: 0,
    kind: null,
    label: 'Not started',
    updatedAt: null,
    finished: false,
  };
}

export function toMemberProgress(
  db: Db,
  book: BookRow,
  row: ProgressRow,
  displayName: string,
  chapters = bookChapters(book),
  color = colorInClub(db, book.club_id, row.user_id),
): MemberProgress {
  const edition = row.edition_id ? editionById(db, row.edition_id) : undefined;
  return progressView(row, displayName, chapters, color, edition);
}

function progressView(row: ProgressRow, displayName: string, chapters: readonly Chapter[], color: string, edition: EditionForProgress | undefined): MemberProgress {
  return {
    userId: row.user_id,
    displayName,
    color,
    t: row.t,
    furthest: rangesFurthest(readRanges(row)),
    coverage: row.coverage,
    kind: edition?.kind ?? null,
    label: savedPlaceLabel(chapters, row, edition),
    updatedAt: iso(row.updated_at),
    finished: row.finished_at !== null,
  };
}

/** Where a meet-up is (D224), as the form gave it. */
function placeOf(row: MeetingRow): MeetupPlace | null {
  if (row.place_kind === 'voice') return { kind: 'voice', value: '' };
  if (row.place_kind === 'place' || row.place_kind === 'link') return { kind: row.place_kind, value: row.place ?? '' };
  return null;
}

/**
 * Where the club will talk next about this book, named after the book's chapters (D53); as a
 * meet-up (D224), when and where, and who answered for it as it stands.
 */
export function meetingView(db: Db, book: BookRow): Meeting | null {
  const row = meetingFor(db, book.id);
  if (!row) return null;
  const occasion = occasionOf(row);
  return meetingFromRow(book, row, occasion ? rsvpsFor(db, book.id, occasion) : []);
}

function meetingFromRow(book: BookRow, row: MeetingRow, rsvps: readonly RsvpRow[]): Meeting {
  return {
    t: row.t,
    label: stopLabel(bookChapters(book), row.t),
    on: row.on_day,
    at: iso(row.starts_at),
    tz: row.tz,
    minutes: row.minutes,
    place: placeOf(row),
    rsvps: rsvps.map((r) => ({ userId: r.user_id, displayName: r.display_name, answer: r.answer })),
    setBy: { userId: row.set_by, displayName: row.set_by_name },
    setAt: isoRequired(row.set_at),
  };
}

export function toBookSummary(db: Db, book: BookRow, viewerId: string): BookSummary {
  return bookSummary(book, editionsForBook(db, book.id), {
    commentCount: countCommentsForBook(db, book.id, viewerId),
    progress: memberProgressList(db, book),
    meeting: meetingView(db, book),
  });
}

function bookSummary(
  book: BookRow,
  editions: readonly Pick<EditionForProgress, 'kind' | 'status'>[],
  activity: Pick<BookSummary, 'commentCount' | 'progress' | 'meeting'>,
): BookSummary {
  const kinds = [...new Set(editions.filter((e) => e.status === 'ready').map((e) => e.kind))];
  return {
    id: book.id,
    clubId: book.club_id,
    title: book.title,
    author: book.author,
    coverUrl: coverUrl(book),
    hasCover: book.cover_blob_id !== null,
    kinds,
    createdAt: isoRequired(book.created_at),
    addedBy: book.created_by,
    ...activity,
  };
}

function byBook<T extends { book_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bookRows = grouped.get(row.book_id) ?? [];
    bookRows.push(row);
    grouped.set(row.book_id, bookRows);
  }
  return grouped;
}

/** Read each part of the library in one query, scoped to active books in this club (D271). */
export function bookSummariesForClub(db: Db, clubId: string, viewerId: string): BookSummary[] {
  const books = booksForClub(db, clubId);
  if (books.length === 0) return [];

  const clubMembers = members(db, clubId);
  const editions = editionsForClub(db, clubId);
  const byEditionId = new Map(editions.map((edition) => [edition.id, edition]));
  const editionsByBook = byBook(editions);
  const progressByBook = byBook(progressForClub(db, clubId));
  const commentCounts = commentCountsForClub(db, clubId, viewerId);
  const meetings = new Map(meetingsForClub(db, clubId).map((row) => [row.book_id, row]));
  const rsvpsByBook = byBook(rsvpsForClub(db, clubId));

  return books.map((book) => {
    const meeting = meetings.get(book.id);
    const occasion = meeting ? occasionOf(meeting) : null;
    const rsvps = (rsvpsByBook.get(book.id) ?? []).filter((rsvp) => rsvp.occasion === occasion);
    return bookSummary(book, editionsByBook.get(book.id) ?? [], {
      commentCount: commentCounts.get(book.id) ?? 0,
      progress: progressViews(book, clubMembers, progressByBook.get(book.id) ?? [], (id) => byEditionId.get(id)),
      meeting: meeting ? meetingFromRow(book, meeting, rsvps) : null,
    });
  });
}

export function toBookDetail(
  db: Db,
  book: BookRow,
  viewerId: string,
  transcription?: (editionId: string) => Edition['transcription'],
): BookDetail {
  return {
    ...toBookSummary(db, book, viewerId),
    chapters: bookChapters(book),
    editions: editionsForBook(db, book.id).map((e) => {
      const view = toEditionView(db, e);
      if (!transcription) return view;
      return { ...view, transcription: transcription(e.id) ?? null };
    }),
    referenceEditionId: book.reference_edition_id,
  };
}
