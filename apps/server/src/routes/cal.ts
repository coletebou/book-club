import { IdSchema } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBook, requireMember } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { RateLimiter } from '../auth/ratelimit';
import { runChatTurn } from '../cal/anthropic';
import { embeddingsProviderFor } from '../cal/embeddings';
import { DeterministicFakeChatModel } from '../cal/fake-model';
import { seriesProgress } from '../cal/gating';
import { MAX_SHELF_UPLOAD_BYTES, queueIndexShelfItem } from '../cal/shelf';
import {
  booksInSeries,
  conversationById,
  conversationsForUser,
  createConversation,
  createSeries,
  createShelfItem,
  deleteConversation,
  deleteShelfItem,
  insertMessage,
  messageContent,
  messagesForConversation,
  calBudgetSpent,
  renameConversation,
  seriesById,
  seriesForClub,
  setBookSeries,
  setConversationShared,
  setWholeSeries,
  settingsFor,
  shelfItemById,
  shelfItemsForClub,
  threadTitle,
} from '../cal/store';
import { type CalContentPart, type CalMessageRow } from '../cal/types';
import { type AppContext } from '../context';
import { HttpError, badRequest, forbidden, notFound, parse, tooMany } from '../lib/errors';
import { insertBlob } from '../repos/blobs';
import { bookById, bookChapters } from '../repos/books';
import { progressFor } from '../repos/progress';
import { chapterNameAt, formatPercent } from '@bookclub/shared';

// No per-question spoiler scope (D183): a turn always uses the asker's standing setting, set in
// Cal's settings. A `wholeSeries` field an older client still sends is dropped by zod, not obeyed.
const SendMessageSchema = z.object({ text: z.string().trim().min(1).max(4000) });
const CreateConversationSchema = z.object({ bookId: IdSchema.nullable().optional(), title: z.string().trim().max(120).optional() });
const RenameSchema = z.object({ title: z.string().trim().min(1).max(120) });
const ShareSchema = z.object({ shared: z.boolean() });
const WholeSeriesSchema = z.object({ wholeSeries: z.boolean() });
const CreateSeriesSchema = z.object({ title: z.string().trim().min(1).max(200) });
const BookSeriesSchema = z.object({ seriesId: z.string().nullable(), order: z.number().finite().nullable().optional() });
const ShelfUrlSchema = z.object({ url: z.string().url().max(2000), title: z.string().trim().max(200).optional() });

/** A stored message's content, flattened to plain text for replaying conversation history to Claude (no tool scaffolding is persisted). */
function plainText(content: readonly CalContentPart[]): string {
  return content
    .filter((p): p is Extract<CalContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function messageView(row: CalMessageRow) {
  return { id: row.id, role: row.role, content: messageContent(row), wholeSeries: row.whole_series === 1, createdAt: new Date(row.created_at).toISOString() };
}

export function calRoutes(app: FastifyInstance, ctx: AppContext): void {
  const rateLimiter = new RateLimiter(ctx.config.CAL_RATE_LIMIT_PER_MINUTE, 60_000);

  const calEnabled = () => Boolean(ctx.config.ANTHROPIC_API_KEY) || ctx.config.CAL_TEST_FAKE_MODEL;
  const requireCal = () => {
    if (!calEnabled()) throw notFound('Cal is not set up on this server.');
  };

  app.get<{ Params: { clubId: string } }>('/api/clubs/:clubId/cal/status', async (request) => {
    const user = requireUser(request);
    requireMember(ctx.db, parse(IdSchema, request.params.clubId), user.id);
    return { enabled: calEnabled(), webSearch: ctx.config.CAL_WEB_SEARCH };
  });

  /* Settings ----------------------------------------------------------------------------- */

  app.get('/api/cal/settings', async (request) => {
    const user = requireUser(request);
    const row = settingsFor(ctx.db, user.id);
    return { wholeSeries: row.whole_series === 1 };
  });

  app.put('/api/cal/settings', async (request) => {
    const user = requireUser(request);
    const body = parse(WholeSeriesSchema, request.body);
    setWholeSeries(ctx.db, user.id, body.wholeSeries);
    return { wholeSeries: body.wholeSeries };
  });

  /* Series --------------------------------------------------------------------------------- */

  app.get<{ Params: { clubId: string } }>('/api/clubs/:clubId/series', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    return seriesForClub(ctx.db, clubId).map((s) => ({ id: s.id, title: s.title, books: booksInSeries(ctx.db, s.id) }));
  });

  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/series', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    const access = requireMember(ctx.db, clubId, user.id);
    if (access.membership.role !== 'owner') throw forbidden('Only the club owner can add a series.');
    const body = parse(CreateSeriesSchema, request.body);
    const series = createSeries(ctx.db, { clubId, title: body.title, createdBy: user.id });
    return reply.code(201).send({ id: series.id, title: series.title, books: [] });
  });

  app.put<{ Params: { bookId: string } }>('/api/books/:bookId/series', async (request) => {
    const user = requireUser(request);
    const { book, membership } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    if (membership.role !== 'owner') throw forbidden('Only the club owner can set a book’s series.');
    const body = parse(BookSeriesSchema, request.body);
    // A series belongs to one club (PR #13 security review): without this, an owner could point
    // their own book at any series id — including one from a club they are not even in — and have
    // it show up in that other club's `GET /series` and Cal's `seriesProgress` context, with no
    // consent from that club at all.
    if (body.seriesId !== null) {
      const series = seriesById(ctx.db, body.seriesId);
      if (!series || series.club_id !== book.club_id) throw notFound('Series not found.');
    }
    setBookSeries(ctx.db, book.id, body.seriesId, body.order ?? null);
    return { seriesId: body.seriesId, order: body.order ?? null };
  });

  /* Conversations -------------------------------------------------------------------------- */

  app.get<{ Params: { clubId: string } }>('/api/clubs/:clubId/cal/conversations', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    return conversationsForUser(ctx.db, user.id, clubId).map((c) => ({
      id: c.id,
      title: c.title,
      bookId: c.book_id,
      bookTitle: c.book_title,
      shared: c.shared_to_club === 1,
      createdAt: new Date(c.created_at).toISOString(),
      updatedAt: new Date(c.updated_at).toISOString(),
    }));
  });

  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/cal/conversations', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const body = parse(CreateConversationSchema, request.body);
    // A thread is about one of this club's own books, or none (D183): a book of another club the
    // asker is also in would give Cal that club's context line in this club's thread.
    const book = body.bookId ? requireBook(ctx.db, body.bookId, user.id).book : null;
    if (book && book.club_id !== clubId) throw notFound('Book not found.');
    const conversation = createConversation(ctx.db, { userId: user.id, clubId, bookId: book?.id ?? null, title: body.title ? threadTitle(body.title) : '' });
    return reply.code(201).send({
      id: conversation.id,
      title: conversation.title,
      bookId: conversation.book_id,
      bookTitle: book?.title ?? null,
      shared: conversation.shared_to_club === 1,
      createdAt: new Date(conversation.created_at).toISOString(),
      updatedAt: new Date(conversation.updated_at).toISOString(),
    });
  });

  const requireConversation = (request: { params: { id: string } }, userId: string) => {
    const conversation = conversationById(ctx.db, parse(IdSchema, request.params.id));
    if (!conversation || conversation.user_id !== userId) throw notFound('Conversation not found.');
    return conversation;
  };

  app.get<{ Params: { id: string } }>('/api/cal/conversations/:id', async (request) => {
    const user = requireUser(request);
    const conversation = requireConversation(request, user.id);
    return { id: conversation.id, title: conversation.title, bookId: conversation.book_id, shared: conversation.shared_to_club === 1, messages: messagesForConversation(ctx.db, conversation.id).map(messageView) };
  });

  app.patch<{ Params: { id: string } }>('/api/cal/conversations/:id', async (request) => {
    const user = requireUser(request);
    const conversation = requireConversation(request, user.id);
    const body = request.body as Record<string, unknown>;
    if ('title' in body) renameConversation(ctx.db, conversation.id, parse(RenameSchema, body).title);
    if ('shared' in body) setConversationShared(ctx.db, conversation.id, parse(ShareSchema, body).shared);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/cal/conversations/:id', async (request, reply) => {
    const user = requireUser(request);
    const conversation = requireConversation(request, user.id);
    deleteConversation(ctx.db, conversation.id);
    return reply.code(204).send();
  });

  /** Where the asker stands, for Cal's dynamic (never-cached) system context (D162). */
  function contextLine(userId: string, bookId: string | null): string {
    if (!bookId) return "This conversation isn't tied to one of the club's books.";
    const book = bookById(ctx.db, bookId);
    if (!book) return "This conversation isn't tied to one of the club's books.";
    const progress = progressFor(ctx.db, userId, bookId);
    const place = progress ? (chapterNameAt(bookChapters(book), progress.t) ?? `before ${formatPercent(progress.t)}`) : 'the asker has not started it';
    const settings = settingsFor(ctx.db, userId);
    const series = book.series_id ? seriesProgress(ctx.db, userId, book.series_id) : null;
    const wholeNote = settings.whole_series === 1 ? ' The asker has turned on "Cal may use the whole series" as a standing setting.' : '';
    return `This conversation is about "${book.title}". The asker's own place in it: ${place}.${series ? ` In its series, they have read furthest in "${series.title}".` : ''}${wholeNote}`;
  }

  /* Chat (SSE) ------------------------------------------------------------------------------ */

  app.post<{ Params: { id: string } }>('/api/cal/conversations/:id/messages', async (request, reply) => {
    requireCal();
    const user = requireUser(request);
    const conversation = requireConversation(request, user.id);
    requireMember(ctx.db, conversation.club_id, user.id);
    const body = parse(SendMessageSchema, request.body);
    if (!rateLimiter.attempt(user.id)) throw tooMany("You've asked Cal a lot in the last minute. Try again shortly.");
    const spent = calBudgetSpent(ctx.db, conversation.club_id, { club: ctx.config.CAL_MONTHLY_SPEND_CAP_USD, instance: ctx.config.CAL_INSTANCE_MONTHLY_SPEND_CAP_USD });
    if (spent === 'club') throw new HttpError(402, 'spend_cap', "This club has reached its Cal budget for this month. Ask the club owner to raise CAL_MONTHLY_SPEND_CAP_USD.");
    if (spent === 'instance') throw new HttpError(402, 'spend_cap', "Cal has reached this month's budget for every club here. It resets on the 1st.");

    const wholeSeries = settingsFor(ctx.db, user.id).whole_series === 1;
    const history = messagesForConversation(ctx.db, conversation.id).map((m) => ({ role: m.role, text: plainText(messageContent(m)) }));
    insertMessage(ctx.db, { conversationId: conversation.id, role: 'user', content: [{ type: 'text', text: body.text }], wholeSeries });
    if (conversation.title === '') renameConversation(ctx.db, conversation.id, threadTitle(body.text));

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.hijack();
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      const result = await runChatTurn(
        { ctx, embeddings: embeddingsProviderFor(ctx.config), model: ctx.config.CAL_TEST_FAKE_MODEL ? new DeterministicFakeChatModel() : undefined },
        {
          clubId: conversation.club_id,
          userId: user.id,
          wholeSeries,
          contextLine: contextLine(user.id, conversation.book_id),
          history,
          message: body.text,
          onDelta: (text) => send('delta', { text }),
        },
      );
      const saved = insertMessage(ctx.db, {
        conversationId: conversation.id,
        role: 'assistant',
        content: result.content,
        wholeSeries,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      send('done', messageView(saved));
    } catch (err) {
      ctx.log.error({ err, conversationId: conversation.id }, 'cal chat turn failed');
      send('error', { message: 'Cal ran into a problem answering that. Try again in a moment.' });
    } finally {
      reply.raw.end();
    }
  });

  /* Cal's shelf ------------------------------------------------------------------------------ */

  app.get<{ Params: { clubId: string } }>('/api/clubs/:clubId/cal/shelf', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    return shelfItemsForClub(ctx.db, clubId).map((i) => ({ id: i.id, kind: i.kind, title: i.title, sourceUrl: i.source_url, status: i.status, error: i.error, createdAt: new Date(i.created_at).toISOString() }));
  });

  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/cal/shelf/url', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const body = parse(ShelfUrlSchema, request.body);
    const item = createShelfItem(ctx.db, { clubId, userId: user.id, kind: 'url', title: body.title ?? body.url, sourceUrl: body.url, blobId: null });
    queueIndexShelfItem(ctx, item.id);
    return reply.code(201).send({ id: item.id, kind: item.kind, title: item.title, status: item.status });
  });

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    scope.post<{ Params: { clubId: string }; Body: Buffer; Querystring: { kind?: string; title?: string } }>(
      '/api/clubs/:clubId/cal/shelf/upload',
      { bodyLimit: MAX_SHELF_UPLOAD_BYTES },
      async (request, reply) => {
        const user = requireUser(request);
        const clubId = parse(IdSchema, request.params.clubId);
        requireMember(ctx.db, clubId, user.id);
        const kind = request.query.kind;
        if (kind !== 'pdf' && kind !== 'epub' && kind !== 'txt' && kind !== 'md') throw badRequest('Say what kind of file this is (pdf, epub, txt or md).');
        if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) throw badRequest('Send the file as the request body.');
        const { id: blobId, size, sha256 } = await ctx.storage.putBytes(request.body);
        insertBlob(ctx.db, { id: blobId, sha256, size, mime: mimeFor(kind) });
        const title = request.query.title?.slice(0, 200) || `Untitled ${kind.toUpperCase()}`;
        const item = createShelfItem(ctx.db, { clubId, userId: user.id, kind, title, sourceUrl: null, blobId });
        queueIndexShelfItem(ctx, item.id);
        return reply.code(201).send({ id: item.id, kind: item.kind, title: item.title, status: item.status });
      },
    );
  });

  app.delete<{ Params: { id: string } }>('/api/cal/shelf/:id', async (request, reply) => {
    const user = requireUser(request);
    const item = shelfItemById(ctx.db, parse(IdSchema, request.params.id));
    if (!item) throw notFound('Not found.');
    const access = requireMember(ctx.db, item.club_id, user.id);
    if (item.user_id !== user.id && access.membership.role !== 'owner') throw forbidden('Only its owner or the club owner can remove this.');
    deleteShelfItem(ctx.db, item.id);
    return reply.code(204).send();
  });
}

function mimeFor(kind: 'pdf' | 'epub' | 'txt' | 'md'): string {
  return kind === 'pdf' ? 'application/pdf' : kind === 'epub' ? 'application/epub+zip' : kind === 'md' ? 'text/markdown' : 'text/plain';
}
