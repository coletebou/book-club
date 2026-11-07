import { bearerToken } from '@bookclub/chat-core';
import { IdSchema, MAX_CHAT_TEXT } from '@bookclub/shared';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../context';
import { HttpError, badRequest, notFound, parse, tooMany } from '../lib/errors';
import { sendFile } from '../lib/send';
import { type AgentDeliveryRow, agentDeliveryOf, furthestAgentFence } from '../repos/agent-deliveries';
import { blobById } from '../repos/blobs';
import { bookById } from '../repos/books';
import { type ChatMessageWithAuthor, chatMessageByClientId, chatMessageById, editChatMessage, insertChatMessage, setChatMessageFence } from '../repos/chat';
import { chatAttachmentById } from '../repos/chat-attachments';
import { clubById } from '../repos/clubs';
import { notifyMentions, publishChatMessage } from '../services/chat';
import { type ChatAgent } from '../services/chat-agents';

/**
 * The API an agent of another service answers through (D205), with the bearer token `CHAT_AGENTS`
 * gives it: never a session, never a person's. It may post in the clubs it is in (a reply in the
 * thread of a message delivered to it, or a message of its own in a channel), edit what it wrote,
 * say it is typing, and fetch the pictures a delivery gave it the addresses of. Nothing else: it
 * reads the conversation only as deliveries bring it, it answers only what was delivered to it, and
 * it cannot touch a message it did not write.
 *
 * What it writes is fenced by what it was given (agent_deliveries, migration 025), never by the
 * conversation as it is when its words arrive (`agentFence`), so a friend behind never reads early
 * what a delivery carried. General has no fences, so there nothing is.
 */

const AgentPostSchema = z
  .object({
    text: z.string().max(MAX_CHAT_TEXT * 2),
    /** The message it answers: its reply goes in that message's thread and channel. */
    parentId: IdSchema.optional(),
    /** A message of its own (no parentId): the channel, a book of the club, or General (null or absent). */
    bookId: IdSchema.nullable().optional(),
    /** Its own id for this message (a delivery's id will do): the same twice posts it once. */
    clientId: z.string().min(8).max(64).optional(),
  })
  .strict();
const AgentEditSchema = z.object({ text: z.string().max(MAX_CHAT_TEXT * 2) }).strict();
const AgentTypingSchema = z.object({ bookId: IdSchema.nullable().optional() }).strict();
const MediaQuerySchema = z.object({ expires: z.coerce.number().int(), signature: z.string().min(1).max(128) });

/** Requests an agent may make a minute, across its whole API (a token that leaked cannot flood a club). */
const API_PER_MINUTE = 120;
/** How long one "is typing" lasts, as a member's (the hub's 5 s). */
const TYPING_MS = 5000;

/**
 * What an agent writes, as it is kept: line breaks made plain, and control characters and the
 * bidirectional overrides and isolates (which can make a message read as something else) taken out.
 */
export function cleanAgentText(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
}

/** A fence, and whose place it is (D204's `spoiler_user_id`: null, the writer's own). */
export interface AgentFence {
  readonly t: number;
  readonly owner: string | null;
}

/**
 * The fence of what an agent writes (D205), from what it was given:
 * - an answer to a message delivered to it: that delivery's fence, the furthest of everything it
 *   carried, at its asker's place. Every word it carried was theirs to read, so it opens for them as
 *   their own words do; a friend behind them sees only where it opens.
 * - a message of its own in a book's channel: the furthest fence ever delivered to it there, at no
 *   one's place. Which of its deliveries it draws on, Book Club cannot tell, so it is fenced as the
 *   most it could have drawn on.
 * - anything in General: none, as nothing there is fenced.
 */
export function agentFence(ctx: AppContext, agent: ChatAgent, at: { readonly answering: AgentDeliveryRow } | { readonly clubId: string; readonly bookId: string | null }): AgentFence | null {
  if ('answering' in at) {
    const { book_id, fence_t, asker_id } = at.answering;
    return book_id !== null && fence_t !== null ? { t: fence_t, owner: asker_id } : null;
  }
  if (!at.bookId) return null;
  const t = furthestAgentFence(ctx.db, agent.handle, at.clubId, at.bookId);
  return t === null ? null : { t, owner: null };
}

/** A message as the API answers with it: what the agent needs to refer to it again. */
function agentMessage(row: ChatMessageWithAuthor) {
  return {
    id: row.id,
    clubId: row.club_id,
    bookId: row.book_id,
    parentId: row.parent_id,
    threadId: row.thread_id,
    text: row.text,
    createdAt: new Date(row.created_at).toISOString(),
    editedAt: row.edited_at === null ? null : new Date(row.edited_at).toISOString(),
  };
}

export function agentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireAgent = (request: FastifyRequest, reply: FastifyReply): ChatAgent => {
    const token = bearerToken(request.headers.authorization);
    const agent = token ? ctx.agents.byToken(token) : undefined;
    if (!agent) {
      void reply.header('WWW-Authenticate', 'Bearer');
      throw new HttpError(401, 'unauthorized', 'This needs an agent’s token.');
    }
    if (!ctx.agents.limiter(`${agent.handle}:api`, API_PER_MINUTE).attempt('api')) throw tooMany('Too many requests this minute. Try again shortly.');
    return agent;
  };

  /** A club it is in, or a 404 that says no more (as for a club a person is not in). */
  const requireClub = (agent: ChatAgent, clubId: string) => {
    const club = clubById(ctx.db, clubId);
    if (!club || !ctx.agents.enabledIn(agent, clubId)) throw notFound('Club not found.');
    return club;
  };

  const cleaned = (text: string) => {
    const clean = cleanAgentText(text);
    if (!clean) throw badRequest('Write something.', { text: 'Write something' });
    if (clean.length > MAX_CHAT_TEXT) throw badRequest(`At most ${MAX_CHAT_TEXT} characters.`, { text: 'Too long' });
    return clean;
  };

  app.get('/api/agents/v1/me', async (request, reply) => {
    const agent = requireAgent(request, reply);
    const clubs = ctx.agents.webhookOf(agent)?.clubs;
    return {
      handle: agent.handle,
      name: agent.displayName,
      clubs: clubs === '*' ? '*' : [...(clubs ?? [])].flatMap((id) => {
        const club = clubById(ctx.db, id);
        return club ? [{ id: club.id, name: club.name }] : [];
      }),
    };
  });

  app.post<{ Params: { clubId: string } }>('/api/agents/v1/clubs/:clubId/messages', async (request, reply) => {
    const agent = requireAgent(request, reply);
    const clubId = parse(IdSchema, request.params.clubId);
    requireClub(agent, clubId);
    const body = parse(AgentPostSchema, request.body);
    if (body.clientId) {
      const existing = chatMessageByClientId(ctx.db, agent.userId, body.clientId);
      if (existing) {
        if (existing.club_id !== clubId) throw badRequest('That clientId is a message in another club.');
        return reply.code(200).send({ message: agentMessage(existing) });
      }
    }
    const text = cleaned(body.text);
    let parent: ChatMessageWithAuthor | undefined;
    let answering: AgentDeliveryRow | undefined;
    if (body.parentId) {
      // Only a message delivered to it: one it was never given, it cannot be answering, and an answer
      // to it would have no fence to carry. Whether such a message exists is not said either.
      answering = agentDeliveryOf(ctx.db, agent.handle, body.parentId);
      parent = answering ? chatMessageById(ctx.db, body.parentId) : undefined;
      if (!parent || parent.club_id !== clubId || parent.deleted_at !== null) throw notFound('No message delivered to you is there to answer.');
      if (body.bookId !== undefined && (body.bookId ?? null) !== parent.book_id) throw badRequest('A reply goes in the same channel as the message it answers.');
    }
    const bookId = parent ? parent.book_id : (body.bookId ?? null);
    if (bookId) {
      const book = bookById(ctx.db, bookId);
      if (!book || book.club_id !== clubId) throw notFound('Book not found.');
    }
    const fence = agentFence(ctx, agent, answering ? { answering } : { clubId, bookId });
    const id = insertChatMessage(ctx.db, {
      clubId,
      bookId,
      userId: agent.userId,
      text,
      parentId: parent?.id ?? null,
      threadId: parent ? (parent.thread_id ?? parent.id) : null,
      clientId: body.clientId ?? null,
      spoilerT: fence?.t ?? null,
      spoilerEditionId: null,
      spoilerUserId: fence?.owner ?? null,
    });
    const message = chatMessageById(ctx.db, id)!;
    // Whom it names hears of it; it asks no agent (services/chat.ts agentsAsked never reads an agent's message).
    notifyMentions(ctx, clubId, message);
    publishChatMessage(ctx, 'chat:new', message);
    return reply.code(201).send({ message: agentMessage(message) });
  });

  app.patch<{ Params: { messageId: string } }>('/api/agents/v1/messages/:messageId', async (request, reply) => {
    const agent = requireAgent(request, reply);
    const message = chatMessageById(ctx.db, parse(IdSchema, request.params.messageId));
    // Only its own messages, in a club it is still in; anyone else's is as good as not there.
    if (!message || message.deleted_at !== null || message.user_id !== agent.userId || !ctx.agents.enabledIn(agent, message.club_id)) throw notFound('That message is gone.');
    const text = cleaned(parse(AgentEditSchema, request.body).text);
    // Fenced again as the message would be now, and never lower than it was: an edit may draw on
    // whatever has been delivered since (a message of its own: the channel's furthest fence).
    const answering = message.parent_id ? agentDeliveryOf(ctx.db, agent.handle, message.parent_id) : undefined;
    const fence = agentFence(ctx, agent, answering ? { answering } : { clubId: message.club_id, bookId: message.book_id });
    editChatMessage(ctx.db, message.id, text);
    if (fence && (message.spoiler_t === null || fence.t > message.spoiler_t)) setChatMessageFence(ctx.db, message.id, fence.t, fence.owner);
    const updated = chatMessageById(ctx.db, message.id)!;
    notifyMentions(ctx, updated.club_id, updated);
    publishChatMessage(ctx, 'chat:updated', updated);
    return { message: agentMessage(updated) };
  });

  app.post<{ Params: { clubId: string } }>('/api/agents/v1/clubs/:clubId/typing', async (request, reply) => {
    const agent = requireAgent(request, reply);
    const clubId = parse(IdSchema, request.params.clubId);
    requireClub(agent, clubId);
    const bookId = parse(AgentTypingSchema, request.body ?? {}).bookId ?? null;
    if (bookId) {
      const book = bookById(ctx.db, bookId);
      if (!book || book.club_id !== clubId) throw notFound('Book not found.');
    }
    // In that channel alone, as Cal's is (D204): an agent at work answers in one channel.
    ctx.hub.publish(clubId, () => ({ type: 'chat:typing', clubId, bookId, userId: agent.userId, displayName: agent.displayName, until: Date.now() + TYPING_MS, channel: bookId ?? 'general' }));
    return reply.code(204).send();
  });

  /** A picture of a message delivered to it, by the address the delivery gave (signed for this agent, good for an hour). */
  app.get<{ Params: { attachmentId: string }; Querystring: Record<string, string> }>('/api/agents/v1/media/:attachmentId', async (request, reply) => {
    const agent = requireAgent(request, reply);
    const attachmentId = parse(IdSchema, request.params.attachmentId);
    const query = MediaQuerySchema.safeParse(request.query);
    if (!query.success || !ctx.agents.mediaSignatureValid(agent.handle, attachmentId, query.data.expires, query.data.signature)) throw notFound();
    const row = chatAttachmentById(ctx.db, attachmentId);
    if (!row || row.status !== 'ready' || !row.message_id || !row.blob_id) throw notFound();
    const message = chatMessageById(ctx.db, row.message_id);
    if (!message || message.deleted_at !== null || !ctx.agents.enabledIn(agent, message.club_id)) throw notFound();
    const blob = blobById(ctx.db, row.blob_id);
    if (!blob) throw notFound();
    return sendFile(request, reply, {
      path: ctx.storage.blobPath(blob.id),
      contentType: blob.mime,
      etag: blob.sha256,
      cacheControl: 'private, no-store',
      headers: { 'Content-Security-Policy': "default-src 'none'; sandbox" },
    });
  });
}
