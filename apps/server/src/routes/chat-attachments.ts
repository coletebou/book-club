import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ChatAttachmentKindSchema, IdSchema, LIMITS, type UploadedChatAttachment } from '@bookclub/shared';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { requireMember } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { newId } from '../lib/crypto';
import { HttpError, badRequest, forbidden, notFound, parse } from '../lib/errors';
import { sendFile } from '../lib/send';
import { blobById } from '../repos/blobs';
import { chatMessageById } from '../repos/chat';
import { type ChatAttachmentRow, type ProcessedChatAttachment, chatAttachmentById, deleteChatAttachmentRow, insertChatAttachment } from '../repos/chat-attachments';
import { mayReviewReportedMedia } from '../repos/moderation';
import { canReadMessage, canReadReportedMessage } from '../services/chat';
import { discardChatAttachment, processChatImage } from '../services/chat-images';
import { processChatVoice } from '../services/chat-voice';

/** Never cached, by the browser or the service worker: the message's gate is checked live, every time (D144, D203). */
const GATED = 'private, no-store';
/** Allow only playback or display when the file is opened directly. */
const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const MAX_VOICE_UPLOADS = 2;
const VOICE_UPLOAD_DEADLINE_MS = 120_000;

function uploaded(row: ChatAttachmentRow, result: ProcessedChatAttachment): UploadedChatAttachment {
  const base = { id: row.id, status: result.status, error: result.error };
  if (row.kind === 'voice') return { ...base, kind: 'voice', durationMs: result.durationMs ?? null };
  return { ...base, kind: 'image', width: result.width, height: result.height };
}

/**
 * Pictures (D203) and recordings (D276) upload in bounded multipart requests and are claimed when
 * a message is sent. Media requests recheck membership and the parent message's spoiler fence.
 */
export function chatAttachmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const voiceUploads = new Set<string>();
  app.post<{ Params: { clubId: string }; Querystring: { kind?: string } }>('/api/clubs/:clubId/chat/attachments', {
    onError: async (request, reply) => {
      if (!request.raw.complete) void reply.header('Connection', 'close');
    },
  }, async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const kind = parse(ChatAttachmentKindSchema, request.query.kind ?? 'image');
    const label = kind === 'voice' ? 'recording' : 'picture';
    const fileSize = kind === 'voice' ? LIMITS.voiceNoteBytes : LIMITS.photoNoteBytes;
    if (kind === 'voice') {
      if (voiceUploads.size >= MAX_VOICE_UPLOADS || voiceUploads.has(user.id)) {
        void reply.header('Retry-After', '5');
        throw new HttpError(503, 'voice_upload_busy', 'The recording service is busy. Try attaching this recording again shortly.');
      }
      voiceUploads.add(user.id);
    }
    const deadline = kind === 'voice' ? setTimeout(() => request.raw.destroy(), VOICE_UPLOAD_DEADLINE_MS).unref() : undefined;
    const tmp = path.join(ctx.storage.tmpDir, `upload-chat-${newId()}`);
    let row: ChatAttachmentRow | undefined;
    try {
      const part = await request.file({ limits: { fileSize } }).catch(() => {
        throw badRequest(`Send one ${label}, as multipart/form-data.`);
      });
      if (!part) throw badRequest(`No ${label} was sent.`);
      row = insertChatAttachment(ctx.db, { userId: user.id, clubId, kind });
      await pipeline(part.file, createWriteStream(tmp));
      clearTimeout(deadline);
      if (part.file.truncated) {
        throw badRequest(`That ${label} is larger than ${Math.round(fileSize / 1024 ** 2)} MB.`);
      }
      const result = await (kind === 'voice' ? processChatVoice(ctx, row, tmp) : processChatImage(ctx, row, tmp));
      return reply.code(201).send(uploaded(row, result));
    } catch (error) {
      if (row) deleteChatAttachmentRow(ctx.db, row.id);
      if (request.raw.destroyed && !request.raw.complete) return reply;
      throw error;
    } finally {
      clearTimeout(deadline);
      if (kind === 'voice') voiceUploads.delete(user.id);
      await rm(tmp, { force: true });
    }
  });

  /** Take back an attachment before its message is sent (removed from the composer). */
  app.delete<{ Params: { attachmentId: string } }>('/api/chat/attachments/:attachmentId', async (request, reply) => {
    const user = requireUser(request);
    const row = chatAttachmentById(ctx.db, parse(IdSchema, request.params.attachmentId));
    if (!row || row.user_id !== user.id) throw notFound('Attachment not found.');
    if (row.message_id !== null) throw forbidden('That attachment has been sent. Delete the message to remove it.');
    await discardChatAttachment(ctx, row);
    return reply.code(204).send();
  });

  /** An address grants no access of its own. */
  const openFor = (attachmentId: string, userId: string, reportId?: string): ChatAttachmentRow => {
    const row = chatAttachmentById(ctx.db, attachmentId);
    if (!row || row.status !== 'ready') throw notFound();
    if (row.message_id === null) {
      if (row.user_id !== userId) throw notFound();
      requireMember(ctx.db, row.club_id, userId);
      return row;
    }
    const message = chatMessageById(ctx.db, row.message_id);
    if (!message) throw notFound();
    requireMember(ctx.db, message.club_id, userId);
    // The report preview exception applies to pictures. Voice always uses the live chat gate (D276).
    const allowed = reportId && row.kind === 'image'
      ? mayReviewReportedMedia(ctx.db, message.club_id, reportId, userId, message.id, 'chat') && canReadReportedMessage(ctx.db, message, userId)
      : canReadMessage(ctx.db, message, userId);
    if (!allowed) throw notFound();
    return row;
  };

  type AttachmentRequest = { Params: { attachmentId: string }; Querystring: { report?: string } };
  const sendAttachment = async (request: FastifyRequest<AttachmentRequest>, reply: FastifyReply, which: 'blob_id' | 'thumb_blob_id') => {
    const user = requireUser(request);
    const row = openFor(parse(IdSchema, request.params.attachmentId), user.id, parse(IdSchema.optional(), request.query.report));
    const blobId = row[which];
    const blob = blobId ? blobById(ctx.db, blobId) : undefined;
    if (!blob) throw notFound();
    return sendFile(request, reply, {
      path: ctx.storage.blobPath(blob.id),
      contentType: which === 'blob_id' ? (row.mime ?? blob.mime) : blob.mime,
      etag: blob.sha256,
      cacheControl: GATED,
      headers: { 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': FILE_CSP },
    });
  };

  app.get<AttachmentRequest>('/media/chat/:attachmentId', (request, reply) => sendAttachment(request, reply, 'blob_id'));
  app.get<AttachmentRequest>('/media/chat/:attachmentId/thumb', (request, reply) => sendAttachment(request, reply, 'thumb_blob_id'));
}
