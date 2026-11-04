import { type PartyState, IdSchema, PartyControlBodySchema, PartyDiagnosticsBodySchema, StartPartyBodySchema } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireBook, requireEdition } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { RateLimiter } from '../auth/ratelimit';
import { type AppContext } from '../context';
import { forbidden, notFound, parse, tooMany } from '../lib/errors';
import { members } from '../repos/clubs';
import { type PartyManager } from '../realtime/party';

/**
 * Listening together (D155-D158). Starting, joining and controlling a party are ordinary
 * request/response, like every other club resource (the party's own state then travels over the
 * hub, `party:state`); only the high-frequency "my mic just crossed the speaking threshold" goes
 * over the socket (`party:speaking`, hub.ts), the same way `reading` already does for position.
 */
export function partyRoutes(app: FastifyInstance, ctx: AppContext, parties: PartyManager): void {
  // Per authenticated user across books and diagnostic session ids: changing either cannot evade it.
  const diagnosticLimit = new RateLimiter(20, 60_000);

  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/party/diagnostics', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const user = requireUser(request);
    const { book, club } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const party = parties.get(club.id, book.id);
    if (!party?.members.some((m) => m.userId === user.id)) throw forbidden('Join the listening party before sending diagnostics.');
    if (!diagnosticLimit.attempt(user.id)) {
      reply.header('Retry-After', '60');
      throw tooMany('Listening diagnostics are being sent too often.');
    }
    const body = parse(PartyDiagnosticsBodySchema, request.body);
    if (body.partyId !== undefined && body.partyId !== party.partyId) throw forbidden('This listening party has ended.');
    // Intentionally no request body, member names, credentials, media addresses, or error strings.
    ctx.log.info({ event: 'party.client-diagnostics', partyId: party.partyId, revision: party.revision, clubId: club.id, bookId: book.id, userId: user.id, ...body }, 'party.client-diagnostics');
    return reply.code(204).send();
  });

  function selfOf(clubId: string, userId: string): { displayName: string; color: string } {
    const m = members(ctx.db, clubId).find((x) => x.userId === userId)!;
    return { displayName: m.displayName, color: m.color };
  }

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/party', async (request): Promise<PartyState | null> => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    return parties.get(book.club_id, book.id);
  });

  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/party/start', async (request): Promise<PartyState> => {
    const user = requireUser(request);
    const bookId = parse(IdSchema, request.params.bookId);
    const body = parse(StartPartyBodySchema, request.body);
    const { book, club } = requireEdition(ctx.db, body.editionId, user.id);
    if (book.id !== bookId) throw notFound('Book not found.');
    const self = selfOf(club.id, user.id);
    return parties.startParty(club.id, book.id, body.editionId, user.id, self.displayName, self.color, body.settings);
  });

  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/party/join', async (request): Promise<PartyState> => {
    const user = requireUser(request);
    const { book, club } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const self = selfOf(club.id, user.id);
    const state = parties.join(club.id, book.id, user.id, self.displayName, self.color);
    if (!state) throw notFound('No listening party is running for this book right now.');
    return state;
  });

  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/party/leave', async (request, reply) => {
    const user = requireUser(request);
    const { book, club } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    parties.leave(club.id, book.id, user.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/party/control', async (request): Promise<PartyState> => {
    const user = requireUser(request);
    const { book, club } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const body = parse(PartyControlBodySchema, request.body);
    const result = parties.control(club.id, book.id, user.id, body);
    if (!result.ok) {
      if (result.reason === 'not_found') throw notFound('No listening party is running for this book right now.');
      throw forbidden('Only the host controls this party.');
    }
    return result.state;
  });
}
