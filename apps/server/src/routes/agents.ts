import { bearerToken } from '@bookclub/chat-core';
import { IdSchema, MAX_CHAT_TEXT, MAX_THREAD_REPLIES } from '@bookclub/shared';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../context';
import { HttpError, badRequest, notFound, parse, tooMany } from '../lib/errors';
import { sendFile } from '../lib/send';
import { blobById } from '../repos/blobs';
import { bookById } from '../repos/books';
import { type ChatMessageWithAuthor, chatMessageByClientId, chatMessageById, chatThreadReplies, editChatMessage, insertChatMessage } from '../repos/chat';
import { chatAttachmentById } from '../repos/chat-attachments';
import { clubById } from '../repos/clubs';
import { ChatViews, notifyMentions, publishChatMessage } from '../services/chat';
import { type ChatAgent } from '../services/chat-agents';

/**
 * The API an agent of another service answers through (D205), with the bearer token `CHAT_AGENTS`
 * gives it: never a session, never a person's. It may post in the clubs it is in (a reply in the
 * thread of the message it answers, or a message of its own in a channel), edit what it wrote, say
 * it is typing, and fetch the pictures a delivery gave it the addresses of. Nothing else: it reads
 * the conversation only as deliveries bring it, and it cannot touch a message it did not write.
 *
 * Its answer to a message is fenced as that conversation is for the person it answers: at the
 * furthest fence of anything in the thread they may read (the agent may have drawn on any of it),
 * opening for them as their own words do (D204's `spoiler_user_id`), so a friend behind them never
 * reads it early. General has no fences, so there nothing is.
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

/** The fence an agent's answer to `parent` carries, and whose place it is; null where nothing is fenced. */
export function answerFence(ctx: AppContext, parent: ChatMessageWithAuthor): { t: number; owner: string | null } | null {
  if (!parent.book_id) return null;
  // The person the conversation is for: who wrote what it answers, or whom an agent's message there answered.
  const owner = parent.author_agent === null ? (parent.spoiler_user_id ?? parent.user_id) : parent.spoiler_user_id;
  let t = parent.spoiler_t ?? 0;
  if (owner) {
    const rootId = parent.thread_id ?? parent.id;
    const root = chatMessageById(ctx.db, rootId);
    const rows = [...(root ? [root] : []), ...chatThreadReplies(ctx.db, rootId, MAX_THREAD_REPLIES).replies];
    const views = new ChatViews(ctx, owner).many(rows);
    rows.forEach((row, i) => {
      if (!views[i]!.hidden && !views[i]!.deleted && row.spoiler_t !== null) t = Math.max(t, row.spoiler_t);
    });
  }
  return t > 0 ? { t, owner } : null;
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
    if (body.parentId) {
      parent = chatMessageById(ctx.db, body.parentId);
      if (!parent || parent.club_id !== clubId || parent.deleted_at !== null) throw notFound('That message is gone.');
      if (body.bookId !== undefined && (body.bookId ?? null) !== parent.book_id) throw badRequest('A reply goes in the same channel as the message it answers.');
    }
    const bookId = parent ? parent.book_id : (body.bookId ?? null);
    if (bookId) {
      const book = bookById(ctx.db, bookId);
      if (!book || book.club_id !== clubId) throw notFound('Book not found.');
    }
    const fence = parent ? answerFence(ctx, parent) : null;
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
    editChatMessage(ctx.db, message.id, text);
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
    ctx.hub.publish(clubId, () => ({ type: 'chat:typing', clubId, bookId, userId: agent.userId, displayName: agent.displayName, until: Date.now() + TYPING_MS }));
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
