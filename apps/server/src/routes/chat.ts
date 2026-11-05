import {
  type ChatDnd,
  type ChatHistory,
  type ChatMessageView,
  type ChatUnread,
  ChatHistoryQuerySchema,
  CreateChatMessageBodySchema,
  EditChatMessageBodySchema,
  IdSchema,
  MarkChatReadBodySchema,
  ReactToChatMessageBodySchema,
  SetChatDndBodySchema,
} from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireMember } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { conflict, forbidden, notFound, parse } from '../lib/errors';
import { bookById } from '../repos/books';
import {
  chatDndFor,
  chatMessageByClientId,
  chatMessageById,
  chatMessagesForClub,
  deleteChatMessage,
  editChatMessage,
  insertChatMessage,
  markChatRead,
  reactionsFor,
  setChatDnd,
  setReaction,
  unreadChatCount,
} from '../repos/chat';
import { bookFor, chatGateFor, notifyMentions, toChatView } from '../services/chat';

/**
 * Live text chat (D150-D152): persisted; delivery to other members is the push over the existing
 * hub (`ctx.hub.publish`, below), exactly as comments already push — a message's creation is a
 * normal request-response, like a comment's, not a message sent over the socket (typing, read by
 * itself here).
 */
export function chatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { clubId: string }; Querystring: Record<string, string> }>('/api/clubs/:clubId/chat', async (request): Promise<ChatHistory> => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const query = parse(ChatHistoryQuerySchema, request.query);
    const book = bookFor(ctx.db, query.bookId ?? (query.channel && query.channel !== 'general' ? query.channel : null));
    const gateCtx = chatGateFor(ctx.db, book, user.id);
    const rows = chatMessagesForClub(ctx.db, clubId, { before: query.before, limit: query.limit + 1, channel: query.channel });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const reactions = reactionsFor(ctx.db, page.map((r) => r.id));
    const messages: ChatMessageView[] = page.map((row) => toChatView(row, book && row.book_id === book.id ? gateCtx : chatGateFor(ctx.db, bookFor(ctx.db, row.book_id), user.id), user.id, reactions.get(row.id) ?? []));
    return { messages, hasMore };
  });

  app.get<{ Params: { clubId: string } }>('/api/clubs/:clubId/chat/unread', async (request): Promise<ChatUnread> => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    return { clubId, unread: unreadChatCount(ctx.db, clubId, user.id) };
  });

  // Do Not Disturb (D173): one switch per person, read and set from wherever the chat/voice
  // screen is open (ChatPage, or the sheet opened from the reader/player header).
  app.get('/api/chat/dnd', async (request): Promise<ChatDnd> => {
    const user = requireUser(request);
    return { enabled: chatDndFor(ctx.db, user.id) };
  });

  app.put('/api/chat/dnd', async (request): Promise<ChatDnd> => {
    const user = requireUser(request);
    const body = parse(SetChatDndBodySchema, request.body);
    setChatDnd(ctx.db, user.id, body.enabled);
    return { enabled: body.enabled };
  });

  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/chat/read', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const body = parse(MarkChatReadBodySchema, request.body ?? {});
    markChatRead(ctx.db, clubId, user.id, body.messageId ?? null);
    return reply.code(204).send();
  });

  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/chat', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const body = parse(CreateChatMessageBodySchema, request.body);
    if (body.clientId) {
      const existing = chatMessageByClientId(ctx.db, user.id, body.clientId);
      if (existing) {
        if (existing.club_id !== clubId) throw conflict('That client id belongs to a message in another club.');
        const gateCtx = chatGateFor(ctx.db, bookFor(ctx.db, existing.book_id), user.id);
        return reply.code(200).send(toChatView(existing, gateCtx, user.id, reactionsFor(ctx.db, [existing.id]).get(existing.id) ?? []));
      }
    }
    const book = body.bookId ? bookById(ctx.db, body.bookId) : undefined;
    if (body.bookId && (!book || book.club_id !== clubId)) throw notFound('Book not found.');
    if (body.spoilerUpToT !== undefined && !book) throw notFound('A spoiler fence needs a book.');
    if (body.parentId) {
      const parent = chatMessageById(ctx.db, body.parentId);
      if (!parent || parent.club_id !== clubId) throw notFound('That message is gone.');
    }
    const id = insertChatMessage(ctx.db, {
      clubId,
      bookId: body.bookId ?? null,
      userId: user.id,
      text: body.text,
      parentId: body.parentId ?? null,
      clientId: body.clientId ?? null,
      spoilerT: body.spoilerUpToT ?? null,
      spoilerEditionId: null,
    });
    const message = chatMessageById(ctx.db, id)!;
    notifyMentions(ctx, clubId, message);
    const gateCtx = chatGateFor(ctx.db, book, user.id);
    ctx.hub.publish(clubId, (recipientId) => {
      const viewerCtx = recipientId === user.id ? gateCtx : chatGateFor(ctx.db, book, recipientId);
      return { type: 'chat:new', clubId, bookId: body.bookId ?? null, message: toChatView(message, viewerCtx, recipientId, []) };
    });
    return reply.code(201).send(toChatView(message, gateCtx, user.id, []));
  });

  app.patch<{ Params: { messageId: string } }>('/api/chat/:messageId', async (request) => {
    const user = requireUser(request);
    const message = chatMessageById(ctx.db, parse(IdSchema, request.params.messageId));
    if (!message || message.deleted_at !== null) throw notFound('That message is gone.');
    requireMember(ctx.db, message.club_id, user.id);
    if (message.user_id !== user.id) throw forbidden('You can only edit your own messages.');
    const body = parse(EditChatMessageBodySchema, request.body);
    editChatMessage(ctx.db, message.id, body.text);
    const updated = chatMessageById(ctx.db, message.id)!;
    const book = bookFor(ctx.db, updated.book_id);
    const reactions = reactionsFor(ctx.db, [updated.id]).get(updated.id) ?? [];
    ctx.hub.publish(message.club_id, (recipientId) => ({
      type: 'chat:updated',
      clubId: message.club_id,
      bookId: updated.book_id,
      message: toChatView(updated, chatGateFor(ctx.db, book, recipientId), recipientId, reactions),
    }));
    return toChatView(updated, chatGateFor(ctx.db, book, user.id), user.id, reactions);
  });

  app.delete<{ Params: { messageId: string } }>('/api/chat/:messageId', async (request, reply) => {
    const user = requireUser(request);
    const message = chatMessageById(ctx.db, parse(IdSchema, request.params.messageId));
    if (!message || message.deleted_at !== null) throw notFound('That message is gone.');
    const access = requireMember(ctx.db, message.club_id, user.id);
    if (message.user_id !== user.id && access.membership.role !== 'owner') throw forbidden('You can only delete your own messages.');
    deleteChatMessage(ctx.db, message.id);
    ctx.hub.publish(message.club_id, () => ({ type: 'chat:deleted', clubId: message.club_id, bookId: message.book_id, messageId: message.id }));
    return reply.code(204).send();
  });

  app.put<{ Params: { messageId: string } }>('/api/chat/:messageId/reactions', async (request) => {
    const user = requireUser(request);
    const message = chatMessageById(ctx.db, parse(IdSchema, request.params.messageId));
    if (!message || message.deleted_at !== null) throw notFound('That message is gone.');
    requireMember(ctx.db, message.club_id, user.id);
    const body = parse(ReactToChatMessageBodySchema, request.body);
    setReaction(ctx.db, message.id, user.id, body.emoji, true);
    return pushReactionUpdate(ctx, message.club_id, message.id, user.id);
  });

  app.delete<{ Params: { messageId: string } }>('/api/chat/:messageId/reactions', async (request) => {
    const user = requireUser(request);
    const message = chatMessageById(ctx.db, parse(IdSchema, request.params.messageId));
    if (!message || message.deleted_at !== null) throw notFound('That message is gone.');
    requireMember(ctx.db, message.club_id, user.id);
    const body = parse(ReactToChatMessageBodySchema, request.body);
    setReaction(ctx.db, message.id, user.id, body.emoji, false);
    return pushReactionUpdate(ctx, message.club_id, message.id, user.id);
  });

  function pushReactionUpdate(appCtx: AppContext, clubId: string, messageId: string, requesterId: string): ChatMessageView {
    const message = chatMessageById(appCtx.db, messageId)!;
    const book = bookFor(appCtx.db, message.book_id);
    const reactions = reactionsFor(appCtx.db, [messageId]).get(messageId) ?? [];
    appCtx.hub.publish(clubId, (recipientId) => ({
      type: 'chat:updated',
      clubId,
      bookId: message.book_id,
      message: toChatView(message, chatGateFor(appCtx.db, book, recipientId), recipientId, reactions),
    }));
    return toChatView(message, chatGateFor(appCtx.db, book, requesterId), requesterId, reactions);
  }
}
