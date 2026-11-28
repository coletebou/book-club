import { CreateReportBodySchema, IdSchema, type BlockedMember, type ContentReports, type ReportedContent } from '@bookclub/shared';
import type { FastifyInstance } from 'fastify';
import { requireComment, requireMember, requireOwner } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { RateLimiter } from '../auth/ratelimit';
import type { AppContext } from '../context';
import { badRequest, notFound, parse, tooMany } from '../lib/errors';
import { chatMessageById } from '../repos/chat';
import { attachmentsForMessages } from '../repos/chat-attachments';
import { mediaForComment } from '../repos/comment-media';
import { commentBlocked } from '../repos/comments';
import { blockedMembers, contentReports, reportTarget, setMemberBlock } from '../repos/moderation';
import { readingOf } from '../repos/progress';
import { canReadMessage, canReadReportedMessage } from '../services/chat';
import { gateFor } from '../services/gating';
import { fileContentReport } from '../services/notifications';

export function moderationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const limits = new RateLimiter(20, 60_000);
  const publishBlocks = (userId: string) => {
    const members = blockedMembers(db, userId);
    ctx.hub.sendToUser(userId, { type: 'moderation:blocks', userId, blockedUserIds: members.map((member) => member.userId) });
    return members;
  };
  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/reports', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(db, clubId, user.id);
    const body = parse(CreateReportBodySchema, request.body);
    if (!limits.attempt(user.id)) throw tooMany('Too many reports. Try again in a minute.');
    if (body.kind === 'chat') {
      const message = chatMessageById(db, body.targetId);
      if (!message || message.club_id !== clubId || message.user_id === user.id || !canReadMessage(db, message, user.id)) throw notFound('That message is unavailable.');
      fileContentReport(ctx, body, user.id, { clubId, bookId: message.book_id, authorId: message.user_id });
    } else {
      const { book, comment } = requireComment(db, body.targetId, user.id);
      const view = gateFor(db, book).view(comment, user.id, readingOf(db, user.id, book.id));
      if (book.club_id !== clubId || comment.user_id === user.id || commentBlocked(db, comment, user.id)
        || (body.kind === 'reaction' ? view.reaction === null : view.hidden)) {
        throw notFound('That note is unavailable.');
      }
      fileContentReport(ctx, body, user.id, { clubId, bookId: book.id, authorId: comment.user_id });
    }
    return reply.code(204).send();
  });

  app.get<{ Params: { clubId: string }; Querystring: { before?: string } }>('/api/clubs/:clubId/reports', async (request, reply): Promise<ContentReports> => {
    reply.header('Cache-Control', 'private, no-store');
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireOwner(db, clubId, user.id);
    const before = parse(IdSchema.optional(), request.query.before);
    return contentReports(db, clubId, before, user.id);
  });

  app.get<{ Params: { clubId: string; reportId: string } }>('/api/clubs/:clubId/reports/:reportId/target', async (request, reply): Promise<ReportedContent> => {
    reply.header('Cache-Control', 'private, no-store');
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    const reportId = parse(IdSchema, request.params.reportId);
    requireOwner(db, clubId, user.id);
    const target = reportTarget(db, clubId, reportId);
    const unavailable = () => notFound('The reported item is unavailable at your reading place.');
    if (!target) throw unavailable();
    if (target.kind === 'chat') {
      const message = chatMessageById(db, target.targetId);
      if (!message || message.club_id !== clubId || !canReadReportedMessage(db, message, user.id)) throw unavailable();
      const attachments = attachmentsForMessages(db, [message.id]).get(message.id) ?? [];
      const pictures = attachments.filter(({ kind }) => kind === 'image');
      const hasVoiceMessage = attachments.some(({ kind }) => kind === 'voice');
      return {
        text: message.text,
        reaction: null,
        ...(hasVoiceMessage ? { hasVoiceMessage } : {}),
        media: pictures.map(({ id }) => ({ id, kind: 'photo', url: `/media/chat/${id}?report=${reportId}` })),
      };
    }
    const { book, comment } = requireComment(db, target.targetId, user.id);
    if (book.club_id !== clubId || comment.deleted_at !== null) throw unavailable();
    const view = gateFor(db, book).view(comment, user.id, readingOf(db, user.id, book.id));
    if (target.kind === 'reaction') {
      if (!view.reaction) throw unavailable();
      return { text: null, reaction: view.reaction, media: [] };
    }
    if (view.hidden) throw unavailable();
    const media = mediaForComment(db, comment.id).filter(({ status }) => status === 'ready');
    return { text: view.text, reaction: view.reaction, media: media.map(({ id, kind }) => ({ id, kind, url: `/media/notes/${id}/file?report=${reportId}` })) };
  });

  app.get('/api/settings/blocks', async (request, reply): Promise<BlockedMember[]> => {
    reply.header('Cache-Control', 'private, no-store');
    return blockedMembers(db, requireUser(request).id);
  });

  app.put<{ Params: { clubId: string; userId: string } }>('/api/clubs/:clubId/blocks/:userId', async (request, reply): Promise<BlockedMember[]> => {
    reply.header('Cache-Control', 'private, no-store');
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    const targetId = parse(IdSchema, request.params.userId);
    requireMember(db, clubId, user.id);
    requireMember(db, clubId, targetId);
    if (user.id === targetId) throw badRequest('You cannot block yourself.');
    setMemberBlock(db, user.id, targetId, true);
    return publishBlocks(user.id);
  });

  app.delete<{ Params: { userId: string } }>('/api/settings/blocks/:userId', async (request, reply): Promise<BlockedMember[]> => {
    reply.header('Cache-Control', 'private, no-store');
    const user = requireUser(request);
    setMemberBlock(db, user.id, parse(IdSchema, request.params.userId), false);
    return publishBlocks(user.id);
  });
}
