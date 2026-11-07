import { CloseRoundBodySchema, CreateNominationBodySchema, IdSchema, UpdateNominationBodySchema, topVoted } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { canManage, requireMember, requireNomination, requireRound } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { badRequest, conflict, forbidden, parse } from '../lib/errors';
import {
  clearUpNext as clearUpNextRow,
  clearVote,
  closeRound,
  createNomination,
  deleteNomination,
  nominationById,
  nominationsForRound,
  openOrReuseRound,
  openRoundFor,
  setUpNext,
  setVote,
  updateNomination,
} from '../repos/nominations';
import { nextBookState } from '../services/next-book';

/** A freshly created nomination: not provided at all is no author, no link, no pitch. */
const orNull = (v: string | undefined): string | null => (v ? v : null);

/** Editing one (PATCH semantics): omitted leaves `current`; '' clears it; anything else replaces it. */
const resolveField = (provided: string | undefined, current: string | null): string | null => (provided === undefined ? current : provided === '' ? null : provided);

/**
 * Picking the next book (D214): nominate, approval-vote, one open round at a time, and the
 * club's Up next on the library page. Every route requires membership of the club a nomination,
 * round or Up next belongs to (`auth/access.ts`); none of it is spoiler-gated (D214: a pitch is
 * about a book nobody has read yet).
 */
export function nominationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { clubId: string } }>('/api/clubs/:clubId/next-book', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    return nextBookState(ctx.db, clubId, user.id);
  });

  /** Anyone may open a round (D214); nominating opens one too, so this is mostly for "start the vote" with nothing nominated yet. */
  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/rounds/open', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const already = openRoundFor(ctx.db, clubId);
    openOrReuseRound(ctx.db, clubId, user.id);
    if (!already) ctx.hub.publish(clubId, () => ({ type: 'club:changed', clubId }));
    return reply.code(already ? 200 : 201).send(nextBookState(ctx.db, clubId, user.id));
  });

  /** Closing picks the most-voted nomination; a tie is broken by whoever closes, among the tied (D214). */
  app.post<{ Params: { clubId: string; roundId: string } }>('/api/clubs/:clubId/rounds/:roundId/close', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    const access = requireRound(ctx.db, parse(IdSchema, request.params.roundId), user.id);
    if (access.round.club_id !== clubId) throw badRequest('That round belongs to another club.');
    if (access.round.status !== 'open') throw conflict('This round is already closed.', 'round_closed');
    if (!canManage(access, access.round.opened_by, user.id)) throw forbidden('Only the club owner or whoever opened the round can close it.');
    const body = parse(CloseRoundBodySchema, request.body ?? {});
    const nominations = nominationsForRound(ctx.db, access.round.id, user.id);
    const tied = topVoted(nominations.map((n) => ({ id: n.id, votes: n.votes })));
    let winnerId: string | null = null;
    if (tied.length === 1) winnerId = tied[0]!;
    else if (tied.length > 1) {
      if (!body.winnerNominationId || !tied.includes(body.winnerNominationId)) {
        throw badRequest('Two or more nominations are tied for the most votes. Choose one to close the round.', { winnerNominationId: 'Choose one of the tied nominations' });
      }
      winnerId = body.winnerNominationId;
    }
    closeRound(ctx.db, access.round.id, user.id, winnerId);
    if (winnerId) setUpNext(ctx.db, clubId, winnerId, access.round.id);
    ctx.hub.publish(clubId, () => ({ type: 'club:changed', clubId }));
    return nextBookState(ctx.db, clubId, user.id);
  });

  /** The owner (or whoever added the matching book, automatically) marks Up next as done. */
  app.delete<{ Params: { clubId: string } }>('/api/clubs/:clubId/up-next', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    const access = requireMember(ctx.db, clubId, user.id);
    if (access.membership.role !== 'owner') throw forbidden('Only the club owner can clear Up next.');
    if (clearUpNextRow(ctx.db, clubId)) ctx.hub.publish(clubId, () => ({ type: 'club:changed', clubId }));
    return reply.code(204).send();
  });

  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/nominations', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const body = parse(CreateNominationBodySchema, request.body);
    const round = openOrReuseRound(ctx.db, clubId, user.id);
    createNomination(ctx.db, {
      roundId: round.id,
      clubId,
      title: body.title,
      author: orNull(body.author),
      link: orNull(body.link),
      pitch: orNull(body.pitch),
      createdBy: user.id,
    });
    ctx.hub.publish(clubId, () => ({ type: 'club:changed', clubId }));
    return reply.code(201).send(nextBookState(ctx.db, clubId, user.id));
  });

  /** The nominator edits their own; only while the round is still open (its history is kept as it closed). */
  app.patch<{ Params: { id: string } }>('/api/nominations/:id', async (request) => {
    const user = requireUser(request);
    const access = requireNomination(ctx.db, parse(IdSchema, request.params.id), user.id);
    if (access.nomination.created_by !== user.id) throw forbidden('Only the member who nominated it can edit it.');
    if (access.round.status !== 'open') throw conflict('This round is already closed.', 'round_closed');
    const current = nominationById(ctx.db, access.nomination.id, user.id)!;
    const body = parse(UpdateNominationBodySchema, request.body);
    updateNomination(ctx.db, access.nomination.id, {
      title: body.title ?? current.title,
      author: resolveField(body.author, current.author),
      link: resolveField(body.link, current.link),
      pitch: resolveField(body.pitch, current.pitch),
    });
    ctx.hub.publish(access.club.id, () => ({ type: 'club:changed', clubId: access.club.id }));
    return nextBookState(ctx.db, access.club.id, user.id);
  });

  /** The nominator withdraws their own; the owner may remove any (D214); only while open. */
  app.delete<{ Params: { id: string } }>('/api/nominations/:id', async (request, reply) => {
    const user = requireUser(request);
    const access = requireNomination(ctx.db, parse(IdSchema, request.params.id), user.id);
    if (!canManage(access, access.nomination.created_by, user.id)) throw forbidden('Only the member who nominated it, or the club owner, can remove it.');
    if (access.round.status !== 'open') throw conflict('This round is already closed.', 'round_closed');
    deleteNomination(ctx.db, access.nomination.id);
    ctx.hub.publish(access.club.id, () => ({ type: 'club:changed', clubId: access.club.id }));
    return reply.code(204).send();
  });

  /** Approval voting (D214): any member may back any number of nominations, changing their mind until the round closes. */
  app.put<{ Params: { id: string } }>('/api/nominations/:id/vote', async (request) => {
    const user = requireUser(request);
    const access = requireNomination(ctx.db, parse(IdSchema, request.params.id), user.id);
    if (access.round.status !== 'open') throw conflict('This round is already closed.', 'round_closed');
    setVote(ctx.db, access.nomination.id, user.id);
    ctx.hub.publish(access.club.id, () => ({ type: 'club:changed', clubId: access.club.id }));
    return nextBookState(ctx.db, access.club.id, user.id);
  });

  app.delete<{ Params: { id: string } }>('/api/nominations/:id/vote', async (request) => {
    const user = requireUser(request);
    const access = requireNomination(ctx.db, parse(IdSchema, request.params.id), user.id);
    if (access.round.status !== 'open') throw conflict('This round is already closed.', 'round_closed');
    clearVote(ctx.db, access.nomination.id, user.id);
    ctx.hub.publish(access.club.id, () => ({ type: 'club:changed', clubId: access.club.id }));
    return nextBookState(ctx.db, access.club.id, user.id);
  });
}
