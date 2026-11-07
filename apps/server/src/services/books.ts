import {
  type BookDetail,
  type BookSummary,
  type Edition,
  type EditionKind,
  type Meeting,
  type MeetupPlace,
  type MemberProgress,
  rangesFurthest,
  stopLabel,
} from '@bookclub/shared';
import { type Db } from '../db/db';
import { COVER_DRAWING } from '../ingest/covers';
import { iso, isoRequired } from '../lib/json';
import { type BookRow, bookChapters, editionsForBook, toEditionView } from '../repos/books';
import { colorInClub, members } from '../repos/clubs';
import { countCommentsForBook } from '../repos/comments';
import { type MeetingRow, meetingFor, occasionOf, rsvpsFor } from '../repos/meetings';
import { type ProgressRow, progressForBook, readRanges } from '../repos/progress';
import { savedPlaceLabel } from './labels';

export function coverUrl(book: BookRow): string {
  return `/media/books/${book.id}/cover?v=${book.cover_blob_id ? `${book.cover_blob_id}.${COVER_DRAWING}` : 'generated'}`;
}

export function memberProgressList(db: Db, book: BookRow): MemberProgress[] {
  const rows = new Map<string, ProgressRow>(progressForBook(db, book.id).map((r) => [r.user_id, r]));
  const chapters = bookChapters(book);
  return members(db, book.club_id).map((m) => {
    const p = rows.get(m.userId);
    return p ? toMemberProgress(db, book, p, m.displayName, chapters, m.color) : emptyProgress(m.userId, m.displayName, m.color);
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
  const kind = row.edition_id ? (db.get<{ kind: EditionKind }>('SELECT kind FROM editions WHERE id = ?', [row.edition_id])?.kind ?? null) : null;
  return {
    userId: row.user_id,
    displayName,
    color,
    t: row.t,
    furthest: rangesFurthest(readRanges(row)),
    coverage: row.coverage,
    kind,
    label: savedPlaceLabel(db, chapters, row),
    updatedAt: iso(row.updated_at),
    finished: row.finished_at !== null,
  };
}

/** Where a meet-up is (D206), as the form gave it. */
function placeOf(row: MeetingRow): MeetupPlace | null {
  if (row.place_kind === 'voice') return { kind: 'voice', value: '' };
  if (row.place_kind === 'place' || row.place_kind === 'link') return { kind: row.place_kind, value: row.place ?? '' };
  return null;
}

/**
 * Where the club will talk next about this book, named after the book's chapters (D53); as a
 * meet-up (D206), when and where, and who answered for it as it stands.
 */
export function meetingView(db: Db, book: BookRow): Meeting | null {
  const row = meetingFor(db, book.id);
  if (!row) return null;
  const occasion = occasionOf(row);
  return {
    t: row.t,
    label: stopLabel(bookChapters(book), row.t),
    on: row.on_day,
    at: iso(row.starts_at),
    tz: row.tz,
    minutes: row.minutes,
    place: placeOf(row),
    rsvps: occasion ? rsvpsFor(db, book.id, occasion).map((r) => ({ userId: r.user_id, displayName: r.display_name, answer: r.answer })) : [],
    setBy: { userId: row.set_by, displayName: row.set_by_name },
    setAt: isoRequired(row.set_at),
  };
}

export function toBookSummary(db: Db, book: BookRow): BookSummary {
  const editions = editionsForBook(db, book.id);
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
    commentCount: countCommentsForBook(db, book.id),
    progress: memberProgressList(db, book),
    meeting: meetingView(db, book),
  };
}

export function toBookDetail(
  db: Db,
  book: BookRow,
  transcription?: (editionId: string) => Edition['transcription'],
): BookDetail {
  return {
    ...toBookSummary(db, book),
    chapters: bookChapters(book),
    editions: editionsForBook(db, book.id).map((e) => {
      const view = toEditionView(db, e);
      if (!transcription) return view;
      return { ...view, transcription: transcription(e.id) ?? null };
    }),
    referenceEditionId: book.reference_edition_id,
  };
}
