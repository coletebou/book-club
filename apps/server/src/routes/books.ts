import { readFile } from 'node:fs/promises';
import {
  AlignmentBodySchema,
  BookMatchQuerySchema,
  IdSchema,
  SetMeetingBodySchema,
  UpdateBookBodySchema,
  type BookMatch,
  type Publication,
  titleSimilarity,
} from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { canManage, requireBook, requireEdition, requireMember } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { forbidden, notFound, parse } from '../lib/errors';
import { realign } from '../ingest/pipeline';
import { booksForClub, deleteEdition, editionFiles, editionsForBook, toEditionView, updateBook, bookById } from '../repos/books';
import { clearMeeting, setMeeting } from '../repos/meetings';
import { realignIfTranscribed, transcriptionStatusOf } from '../services/readalong';
import { removeBook, removeFiles } from '../services/removal';
import { toBookDetail, toBookSummary } from '../services/books';

export function bookRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { clubId: string } }>('/api/clubs/:clubId/books', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    return booksForClub(ctx.db, clubId).map((b) => toBookSummary(ctx.db, b));
  });

  /** Books of the club that look like the one being uploaded (to add a format instead of a duplicate). */
  app.get<{ Params: { clubId: string }; Querystring: Record<string, string> }>('/api/clubs/:clubId/book-matches', async (request): Promise<BookMatch[]> => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const q = parse(BookMatchQuerySchema, request.query);
    return booksForClub(ctx.db, clubId)
      .map((b) => {
        const titleScore = titleSimilarity(q.title, b.title);
        const authorScore = q.author && b.author ? titleSimilarity(q.author, b.author) : 0.5;
        return { book: b, score: titleScore * 0.75 + authorScore * 0.25, titleScore };
      })
      .filter((m) => m.titleScore >= 0.6 && m.score >= 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ book, score }) => ({
        bookId: book.id,
        title: book.title,
        author: book.author,
        kinds: [...new Set(editionsForBook(ctx.db, book.id).map((e) => e.kind))],
        score,
      }));
  });

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId', async (request) => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    return toBookDetail(ctx.db, book, (id) => transcriptionStatusOf(ctx, id));
  });

  app.patch<{ Params: { bookId: string } }>('/api/books/:bookId', async (request) => {
    const user = requireUser(request);
    const access = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    if (!canManage(access, access.book.created_by, user.id)) throw forbidden('Only the club owner or whoever added the book can change it.');
    updateBook(ctx.db, access.book.id, parse(UpdateBookBodySchema, request.body));
    ctx.hub.publish(access.club.id, () => ({ type: 'book:changed', clubId: access.club.id, bookId: access.book.id }));
    return toBookDetail(ctx.db, bookById(ctx.db, access.book.id)!, (id) => transcriptionStatusOf(ctx, id));
  });

  /** Where the club will talk next (D53): any member may set it, move it or clear it. */
  app.put<{ Params: { bookId: string } }>('/api/books/:bookId/meeting', async (request) => {
    const user = requireUser(request);
    const access = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const body = parse(SetMeetingBodySchema, request.body);
    setMeeting(ctx.db, access.book.id, user.id, body.t, body.on ?? null);
    ctx.hub.publish(access.club.id, () => ({ type: 'book:changed', clubId: access.club.id, bookId: access.book.id }));
    return toBookDetail(ctx.db, bookById(ctx.db, access.book.id)!, (id) => transcriptionStatusOf(ctx, id));
  });

  app.delete<{ Params: { bookId: string } }>('/api/books/:bookId/meeting', async (request, reply) => {
    const user = requireUser(request);
    const access = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    if (clearMeeting(ctx.db, access.book.id)) ctx.hub.publish(access.club.id, () => ({ type: 'book:changed', clubId: access.club.id, bookId: access.book.id }));
    return reply.code(204).send();
  });

  app.delete<{ Params: { bookId: string } }>('/api/books/:bookId', async (request, reply) => {
    const user = requireUser(request);
    const access = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    if (!canManage(access, access.book.created_by, user.id)) throw forbidden('Only the club owner or whoever added the book can delete it.');
    // A soft delete (D179): gone from the club, kept on the server for its admin to bring back.
    removeBook(ctx, access.book.id, access.club.id, user.id);
    return reply.code(204).send();
  });

  app.delete<{ Params: { editionId: string } }>('/api/editions/:editionId', async (request, reply) => {
    const user = requireUser(request);
    const access = requireEdition(ctx.db, parse(IdSchema, request.params.editionId), user.id);
    if (!canManage(access, access.edition.created_by, user.id)) throw forbidden('Only the club owner or whoever added it can delete this format.');
    const blobIds = editionFiles(ctx.db, access.edition.id).map((f) => f.blob_id);
    deleteEdition(ctx.db, access.edition.id);
    await removeFiles(ctx, [access.edition.id], blobIds);
    ctx.hub.publish(access.club.id, () => ({ type: 'book:changed', clubId: access.club.id, bookId: access.book.id }));
    // Its read-along goes with it (or with its text): the other formats get their chapter maps back.
    realignIfTranscribed(ctx, access.book.id);
    return reply.code(204).send();
  });

  /** Manual alignment of an edition's tracks (or TOC entries) to the book's chapters. */
  app.put<{ Params: { editionId: string } }>('/api/editions/:editionId/alignment', async (request) => {
    const user = requireUser(request);
    const access = requireEdition(ctx.db, parse(IdSchema, request.params.editionId), user.id);
    // The club owner's alone: an alignment places every member's notes for every other member, so
    // whoever added a format must not be able to open friends' notes early with it.
    if (access.membership.role !== 'owner') throw forbidden('Only the club owner can change how a format lines up with the book.');
    const body = parse(AlignmentBodySchema, request.body);
    realign(ctx, access.edition, body.unitToChapter);
    ctx.hub.publish(access.club.id, () => ({ type: 'book:changed', clubId: access.club.id, bookId: access.book.id }));
    // Forced alignment rests on the chapter match where a track did not align: redo it.
    realignIfTranscribed(ctx, access.book.id);
    const edition = toEditionView(ctx.db, ctx.db.get('SELECT * FROM editions WHERE id = ?', [access.edition.id])!);
    return { ...edition, transcription: transcriptionStatusOf(ctx, edition.id) };

  });

  app.get<{ Params: { editionId: string } }>('/api/editions/:editionId/publication', async (request, reply): Promise<Publication> => {
    const user = requireUser(request);
    const { edition } = requireEdition(ctx.db, parse(IdSchema, request.params.editionId), user.id);
    if (edition.kind !== 'epub' || edition.status !== 'ready') throw notFound('Publication not found.');
    const file = ctx.storage.pubFile(edition.id, '.publication.json');
    if (!file) throw notFound();
    // The manifest never changes for an edition: let the browser (privately) keep it.
    void reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return JSON.parse(await readFile(file, 'utf8')) as Publication;
  });
}
