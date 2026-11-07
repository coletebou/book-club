import { type ClubSummary, type NextBookState, type Nomination, type Round, type UpNext, titleSimilarity } from '@bookclub/shared';
import { type AppContext } from '../context';
import { type Db } from '../db/db';
import { isoRequired } from '../lib/json';
import { colorInClub } from '../repos/clubs';
import {
  type NominationRow,
  type RoundRow,
  closedRoundsFor,
  nominationsForRound,
  openRoundFor,
  upNextFor,
  votersFor,
  clearUpNext as clearUpNextRow,
} from '../repos/nominations';

/**
 * Picking the next book (D214): nominate, approval-vote, one open round at a time, Up next on the
 * library page. Pitches describe a book nobody in the club has read yet, so none of this is
 * spoiler-gated (docs/DECISIONS.md D214) — every view here is the same for every member.
 */

function toNomination(db: Db, clubId: string, row: NominationRow): Nomination {
  return {
    id: row.id,
    roundId: row.round_id,
    title: row.title,
    author: row.author,
    link: row.link,
    pitch: row.pitch,
    createdBy: { userId: row.created_by, displayName: row.created_by_name, color: colorInClub(db, clubId, row.created_by) },
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    votes: row.votes,
    voters: votersFor(db, row.id).map((v) => ({ userId: v.user_id, displayName: v.display_name, color: colorInClub(db, clubId, v.user_id) })),
    votedByMe: Boolean(row.voted_by_me),
  };
}

export function toRound(db: Db, round: RoundRow, selfId: string): Round {
  return {
    id: round.id,
    clubId: round.club_id,
    status: round.status,
    openedBy: { userId: round.opened_by, displayName: round.opened_by_name, color: colorInClub(db, round.club_id, round.opened_by) },
    openedAt: isoRequired(round.opened_at),
    closedBy: round.closed_by ? { userId: round.closed_by, displayName: round.closed_by_name ?? '', color: colorInClub(db, round.club_id, round.closed_by) } : null,
    closedAt: round.closed_at === null ? null : isoRequired(round.closed_at),
    winnerNominationId: round.winner_nomination_id,
    nominations: nominationsForRound(db, round.id, selfId).map((n) => toNomination(db, round.club_id, n)),
  };
}

export function toUpNext(up: { nomination_id: string; round_id: string; set_at: number; title: string; author: string | null; link: string | null; pitch: string | null }): UpNext {
  return { nominationId: up.nomination_id, roundId: up.round_id, title: up.title, author: up.author, link: up.link, pitch: up.pitch, setAt: isoRequired(up.set_at) };
}

export function upNextView(db: Db, clubId: string): UpNext | null {
  const row = upNextFor(db, clubId);
  return row ? toUpNext(row) : null;
}

/** Fills in `upNext` on a list of club summaries (`repos/clubs.ts` leaves it out: one query per club keeps that one simple). */
export function withUpNext<T extends Omit<ClubSummary, 'upNext'>>(db: Db, clubs: readonly T[]): (T & { upNext: UpNext | null })[] {
  return clubs.map((c) => ({ ...c, upNext: upNextView(db, c.id) }));
}

export function nextBookState(db: Db, clubId: string, selfId: string): NextBookState {
  const open = openRoundFor(db, clubId);
  return {
    upNext: upNextView(db, clubId),
    round: open ? toRound(db, open, selfId) : null,
    history: closedRoundsFor(db, clubId).map((r) => toRound(db, r, selfId)),
  };
}

/** A new book looks enough like the club's Up next (D214): close title match, same threshold `routes/books.ts`'s book-matches uses. */
const TITLE_MATCH_THRESHOLD = 0.6;

/**
 * Up next is cleared automatically when a book whose title matches it is added to the club
 * (D214/D215): the club just brought in the book it voted for, so there is nothing left to point
 * at. An exact manual "mark as done" stays available (DELETE /api/clubs/:clubId/up-next) for a
 * book added under a different title.
 */
export function clearUpNextIfMatches(ctx: AppContext, clubId: string, newBookTitle: string): void {
  const up = upNextFor(ctx.db, clubId);
  if (!up || titleSimilarity(up.title, newBookTitle) < TITLE_MATCH_THRESHOLD) return;
  if (clearUpNextRow(ctx.db, clubId)) ctx.hub.publish(clubId, () => ({ type: 'club:changed', clubId }));
}
