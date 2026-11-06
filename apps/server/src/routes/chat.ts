import {
  type ChatAgentList,
  type ChatDnd,
  type ChatHistory,
  type ChatThread,
  type ChatUnread,
  ChatHistoryQuerySchema,
  CreateChatMessageBodySchema,
  EditChatMessageBodySchema,
  IdSchema,
  MAX_THREAD_REPLIES,
  MarkChatReadBodySchema,
  ReactToChatMessageBodySchema,
  SetChatDndBodySchema,
} from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireMember } from '../auth/access';
import { publicOrigin, requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors';
import { bookById } from '../repos/books';
import {
  type ChatMessageWithAuthor,
  chatDndFor,
  chatMessageByClientId,
  chatMessageById,
  chatMessagesForClub,
  chatThreadReplies,
  deleteChatMessage,
  editChatMessage,
  insertChatMessage,
  markChatRead,
  replyCounts,
  setChatDnd,
  setReaction,
  unreadChatCount,
} from '../repos/chat';
import { attachToMessage } from '../repos/chat-attachments';
import { ChatViews, notifyMentions, publishChatMessage } from '../services/chat';
import { toAgentView } from '../services/chat-agents';
import { askAgents } from '../services/chat-dispatch';
import { deleteAttachmentsOf } from '../services/chat-images';

/** Live replies under a root (D200): what keeps a deleted root on as a placeholder. */
function liveReplies(ctx: AppContext, rootId: string): number {
  return replyCounts(ctx.db, [rootId]).get(rootId) ?? 0;
}

/**
 * Live text chat (D150-D152): persisted; delivery to other members is the push over the existing
 * hub (`ctx.hub.publish`, below), exactly as comments already push — a message's creation is a
 * normal request-response, like a comment's, not a message sent over the socket (typing, read by
 * itself here). Every message is rendered per recipient through `ChatViews` (services/chat.ts):
 * its spoiler fence, its quote of what it answers (D200) and its mentions (D201) judged for them.
 */
export function chatRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Tell a club's subscribers about a message as each of them may see it. */
  const publishMessage = (type: 'chat:new' | 'chat:updated', message: ChatMessageWithAuthor) => publishChatMessage(ctx, type, message);

  app.get<{ Params: { clubId: string }; Querystring: Record<string, string> }>('/api/clubs/:clubId/chat', async (request): Promise<ChatHistory> => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const query = parse(ChatHistoryQuerySchema, request.query);
    const rows = chatMessagesForClub(ctx.db, clubId, { before: query.before, limit: query.limit + 1, channel: query.channel });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { messages: new ChatViews(ctx, user.id).many(page), hasMore };
  });

  /**
   * One conversation on its own (D200): its root and its newest replies, from any message in it,
   * with the channel it is in, for the thread view and for a link straight to a message (the
   * bell's mentions). A message that is gone, or a thread whose root is gone with nothing left
   * under it, answers 404, as does anything in a club the asker is not in.
   */
  app.get<{ Params: { messageId: string } }>('/api/chat/:messageId/thread', async (request): Promise<ChatThread> => {
    const user = requireUser(request);
    const message = chatMessageById(ctx.db, parse(IdSchema, request.params.messageId));
    if (!message) throw notFound('That message is gone.');
    requireMember(ctx.db, message.club_id, user.id);
    const root = message.thread_id ? chatMessageById(ctx.db, message.thread_id) ?? message : message;
    const gone = (message.deleted_at !== null && message.id !== root.id) || (root.deleted_at !== null && liveReplies(ctx, root.id) === 0);
    if (gone) throw notFound('That message is gone.');
    const { replies, hasMore } = chatThreadReplies(ctx.db, root.id, MAX_THREAD_REPLIES);
    const [rootView, ...replyViews] = new ChatViews(ctx, user.id).many([root, ...replies]);
    return { root: rootView!, replies: replyViews, hasMore, channel: root.book_id ?? 'general' };
  });

  /** Who besides its members can be @-mentioned in a club's chat (D204): the agents enabled there, for the composer to offer. */
  app.get<{ Params: { clubId: string } }>('/api/clubs/:clubId/chat/agents', async (request): Promise<ChatAgentList> => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    return { agents: ctx.agents.forClub(clubId).map(toAgentView) };
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
        return reply.code(200).send(new ChatViews(ctx, user.id).one(existing));
      }
    }
    // A reply (D200) answers a message of this club its writer can read, in that message's own
    // channel, and joins that message's thread.
    let parent: ChatMessageWithAuthor | undefined;
    if (body.parentId) {
      parent = chatMessageById(ctx.db, body.parentId);
      if (!parent || parent.club_id !== clubId || parent.deleted_at !== null) throw notFound('That message is gone.');
      if (body.bookId !== undefined && (body.bookId ?? null) !== parent.book_id) throw badRequest('A reply goes in the same channel as the message it answers.');
      const quote = new ChatViews(ctx, user.id).one(parent);
      if (quote.hidden) throw badRequest('You can reply to that once you have read as far as it.');
    }
    const bookId = parent ? parent.book_id : (body.bookId ?? null);
    const book = bookId ? bookById(ctx.db, bookId) : undefined;
    if (bookId && (!book || book.club_id !== clubId)) throw notFound('Book not found.');
    if (body.spoilerUpToT !== undefined && !book) throw notFound('A spoiler fence needs a book.');
    // The message and its pictures (D203) in one step: all of them claimed, or no message at all.
    const id = ctx.db.tx(() => {
      const created = insertChatMessage(ctx.db, {
        clubId,
        bookId,
        userId: user.id,
        // A picture alone has no words: an empty string, as a note with media only (D148).
        text: body.text,
        parentId: parent?.id ?? null,
        threadId: parent ? (parent.thread_id ?? parent.id) : null,
        clientId: body.clientId ?? null,
        spoilerT: body.spoilerUpToT ?? null,
        spoilerEditionId: null,
      });
      if (!attachToMessage(ctx.db, created, user.id, clubId, body.attachmentIds ?? [])) throw badRequest('Those pictures are no longer there to send. Attach them again.');
      return created;
    });
    const message = chatMessageById(ctx.db, id)!;
    notifyMentions(ctx, clubId, message);
    publishMessage('chat:new', message);
    // Any agent it asks (D204: @cal; D205: an agent of another service) answers after this, in its thread.
    askAgents(ctx, message, publicOrigin(ctx, request));
    return reply.code(201).send(new ChatViews(ctx, user.id).one(message));
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
    // Whoever the edit newly names hears about it; anyone already notified for it is not again.
    notifyMentions(ctx, updated.club_id, updated);
    publishMessage('chat:updated', updated);
    return new ChatViews(ctx, user.id).one(updated);
  });

  app.delete<{ Params: { messageId: string } }>('/api/chat/:messageId', async (request, reply) => {
    const user = requireUser(request);
    const message = chatMessageById(ctx.db, parse(IdSchema, request.params.messageId));
    if (!message || message.deleted_at !== null) throw notFound('That message is gone.');
    const access = requireMember(ctx.db, message.club_id, user.id);
    if (message.user_id !== user.id && access.membership.role !== 'owner') throw forbidden('You can only delete your own messages.');
    deleteChatMessage(ctx.db, message.id);
    // Its pictures go now, placeholder or not: a deleted message shows no words, so no pictures either (D147, D203).
    await deleteAttachmentsOf(ctx, message.id);
    const clubId = message.club_id;
    const removed = (id: string, threadId: string | null) => ctx.hub.publish(clubId, () => ({ type: 'chat:deleted', clubId, bookId: message.book_id, messageId: id, threadId }));
    // A root its replies still hang from stays as a placeholder (D200); anything else goes.
    if (message.thread_id === null && liveReplies(ctx, message.id) > 0) publishMessage('chat:updated', chatMessageById(ctx.db, message.id)!);
    else removed(message.id, message.thread_id);
    // The last live reply under a deleted root: the root's placeholder has nothing left to anchor.
    if (message.thread_id !== null) {
      const root = chatMessageById(ctx.db, message.thread_id);
      if (root && root.deleted_at !== null && liveReplies(ctx, root.id) === 0) removed(root.id, null);
    }
    return reply.code(204).send();
  });

  app.put<{ Params: { messageId: string } }>('/api/chat/:messageId/reactions', async (request) => {
    const user = requireUser(request);
    const message = chatMessageById(ctx.db, parse(IdSchema, request.params.messageId));
    if (!message || message.deleted_at !== null) throw notFound('That message is gone.');
    requireMember(ctx.db, message.club_id, user.id);
    const body = parse(ReactToChatMessageBodySchema, request.body);
    setReaction(ctx.db, message.id, user.id, body.emoji, true);
    publishMessage('chat:updated', message);
    return new ChatViews(ctx, user.id).one(message);
  });

  app.delete<{ Params: { messageId: string } }>('/api/chat/:messageId/reactions', async (request) => {
    const user = requireUser(request);
    const message = chatMessageById(ctx.db, parse(IdSchema, request.params.messageId));
    if (!message || message.deleted_at !== null) throw notFound('That message is gone.');
    requireMember(ctx.db, message.club_id, user.id);
    const body = parse(ReactToChatMessageBodySchema, request.body);
    setReaction(ctx.db, message.id, user.id, body.emoji, false);
    publishMessage('chat:updated', message);
    return new ChatViews(ctx, user.id).one(message);
  });
}
