import { type Db } from '../db/db';
import { forbidden, notFound } from '../lib/errors';
import { type BookRow, type EditionRow, bookById, editionById } from '../repos/books';
import { type ClubRow, type MembershipRow, clubById, membership } from '../repos/clubs';
import { type CommentWithAuthor, commentById } from '../repos/comments';
import { type BareNomination, type RoundRow, bareNomination, roundById } from '../repos/nominations';

/*
 * Authorisation lives here and only here. One rule: a user reaches a club's books, editions,
 * files, comments, progress and presence only as a member of that club. Anything outside the
 * user's clubs is reported as not found, so ids in other clubs cannot even be confirmed.
 */

export interface ClubAccess {
  readonly club: ClubRow;
  readonly membership: MembershipRow;
}

export function requireMember(db: Db, clubId: string, userId: string): ClubAccess {
  const club = clubById(db, clubId);
  const m = club ? membership(db, clubId, userId) : undefined;
  if (!club || !m) throw notFound('Club not found.');
  return { club, membership: m };
}

export function requireOwner(db: Db, clubId: string, userId: string): ClubAccess {
  const access = requireMember(db, clubId, userId);
  if (access.membership.role !== 'owner') throw forbidden('Only the club owner can do that.');
  return access;
}

export interface BookAccess extends ClubAccess {
  readonly book: BookRow;
}

export function requireBook(db: Db, bookId: string, userId: string): BookAccess {
  const book = bookById(db, bookId);
  if (!book) throw notFound('Book not found.');
  const club = clubById(db, book.club_id);
  const m = club ? membership(db, book.club_id, userId) : undefined;
  if (!club || !m) throw notFound('Book not found.');
  return { club, membership: m, book };
}

export interface EditionAccess extends BookAccess {
  readonly edition: EditionRow;
}

export function requireEdition(db: Db, editionId: string, userId: string): EditionAccess {
  const edition = editionById(db, editionId);
  if (!edition) throw notFound('Edition not found.');
  try {
    return { ...requireBook(db, edition.book_id, userId), edition };
  } catch {
    throw notFound('Edition not found.');
  }
}

export interface CommentAccess extends BookAccess {
  readonly comment: CommentWithAuthor;
}

export function requireComment(db: Db, commentId: string, userId: string): CommentAccess {
  const comment = commentById(db, commentId);
  if (!comment) throw notFound('Comment not found.');
  try {
    return { ...requireBook(db, comment.book_id, userId), comment };
  } catch {
    throw notFound('Comment not found.');
  }
}

/** Owners moderate everything in their club; members manage what they added. */
export function canManage(access: ClubAccess, createdBy: string, userId: string): boolean {
  return access.membership.role === 'owner' || createdBy === userId;
}

export interface RoundAccess extends ClubAccess {
  readonly round: RoundRow;
}

/** Picking the next book (D214): a round belongs to its club, found only through membership. */
export function requireRound(db: Db, roundId: string, userId: string): RoundAccess {
  const round = roundById(db, roundId);
  if (!round) throw notFound('Round not found.');
  const access = requireMember(db, round.club_id, userId);
  return { ...access, round };
}

export interface NominationAccess extends RoundAccess {
  readonly nomination: BareNomination;
}

/** A nomination (D214), found only through the membership of the club it belongs to. */
export function requireNomination(db: Db, nominationId: string, userId: string): NominationAccess {
  const nomination = bareNomination(db, nominationId);
  if (!nomination) throw notFound('Nomination not found.');
  const access = requireRound(db, nomination.round_id, userId);
  return { ...access, nomination };
}
