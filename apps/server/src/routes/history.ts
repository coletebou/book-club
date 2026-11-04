import { type HistoryList, IdSchema } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBook } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { notFound, parse } from '../lib/errors';
import { HISTORY_PAGE, forgetBookHistory, forgetSitting, historyFor } from '../services/history';

const QuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE).optional(),
});

/**
 * Your own reading and listening history (D191). Every route answers only for the person signed
 * in: nobody's history is ever another member's to read, whatever their role in the club.
 */
export function historyRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Across every book you can open, newest first. */
  app.get<{ Querystring: Record<string, string> }>('/api/history', async (request): Promise<HistoryList> => {
    const user = requireUser(request);
    const q = parse(QuerySchema, request.query);
    return historyFor(ctx.db, user.id, q);
  });

  /** In one book. */
  app.get<{ Params: { bookId: string }; Querystring: Record<string, string> }>('/api/books/:bookId/history', async (request): Promise<HistoryList> => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const q = parse(QuerySchema, request.query);
    return historyFor(ctx.db, user.id, { ...q, bookId: book.id });
  });

  /** Forget all of it, in one book. */
  app.delete<{ Params: { bookId: string } }>('/api/books/:bookId/history', async (request, reply) => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    forgetBookHistory(ctx.db, user.id, book.id);
    return reply.code(204).send();
  });

  /** Forget one line. */
  app.delete<{ Params: { id: string } }>('/api/history/:id', async (request, reply) => {
    const user = requireUser(request);
    if (!forgetSitting(ctx.db, user.id, parse(IdSchema, request.params.id))) throw notFound('No such entry in your history.');
    return reply.code(204).send();
  });
}
