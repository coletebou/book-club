import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
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
const MAX_VOICE_ENCODERS = 2;
const MAX_VOICE_WAITERS = 4;
const MAX_VOICE_TEMP_BYTES = (MAX_VOICE_ENCODERS + MAX_VOICE_WAITERS + 2) * LIMITS.voiceNoteBytes;
const VOICE_UPLOAD_DEADLINE_MS = 120_000;
// One maximum-size `encodeVoice` call allows 180 s to encode and 15 s to read the result's duration.
const VOICE_ENCODER_RETRY_SECONDS = 195;

function uploaded(row: ChatAttachmentRow, result: ProcessedChatAttachment): UploadedChatAttachment {
  const base = { id: row.id, status: result.status, error: result.error };
  if (row.kind === 'voice') return { ...base, kind: 'voice', durationMs: result.durationMs ?? null };
  return { ...base, kind: 'image', width: result.width, height: result.height };
}

/** Keep the receive deadline in force until the complete one-file form is validated. */
async function receiveVoiceUpload(request: FastifyRequest, tmp: string, claimBytes: (bytes: number) => boolean): Promise<void> {
  const fileSize = LIMITS.voiceNoteBytes;
  const parts = request.parts({ limits: { fileSize, files: 1, fields: 0 } });
  const invalid = () => badRequest('Send one recording, as multipart/form-data.');
  const next = () => parts.next().catch(() => { throw invalid(); });
  const first = await next();
  if (first.done) throw badRequest('No recording was sent.');
  if (first.value.type !== 'file') throw invalid();
  const budget = new Transform({ transform(chunk: Buffer, _encoding, done) {
    if (claimBytes(chunk.length)) done(null, chunk);
    else done(new HttpError(429, 'voice_upload_storage_busy', 'Temporary recording space is busy. Try attaching this recording again shortly.'));
  } });
  await pipeline(first.value.file, budget, createWriteStream(tmp));
  if (first.value.file.truncated) {
    throw badRequest(`That recording is larger than ${Math.round(fileSize / 1024 ** 2)} MB.`);
  }
  if (!(await next()).done || !request.raw.complete) throw invalid();
}

/**
 * Pictures (D203) and recordings (D276) upload in bounded multipart requests and are claimed when
 * a message is sent. Media requests recheck membership and the parent message's spoiler fence.
 */
export function chatAttachmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const voiceUploads = new Set<string>();
  let temporaryVoiceBytes = 0;
  let activeEncoders = 0;
  const waiting: ((granted: boolean) => void)[] = [];
  // D276: only complete uploads wait here. Hand an occupied slot directly to the next waiter.
  function acquireEncoder(signal: AbortSignal): Promise<boolean> | null {
    if (signal.aborted) return Promise.resolve(false);
    if (activeEncoders < MAX_VOICE_ENCODERS) {
      activeEncoders++;
      return Promise.resolve(true);
    }
    if (waiting.length >= MAX_VOICE_WAITERS) return null;
    return new Promise((resolve) => {
      const finish = (granted: boolean) => {
        signal.removeEventListener('abort', abort);
        resolve(granted);
      };
      const abort = () => {
        const index = waiting.indexOf(finish);
        if (index !== -1) waiting.splice(index, 1);
        finish(false);
      };
      waiting.push(finish);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  function releaseEncoder(): void {
    const next = waiting.shift();
    if (next) next(true);
    else activeEncoders--;
  }

  app.post<{ Params: { clubId: string }; Querystring: { kind?: string } }>('/api/clubs/:clubId/chat/attachments', {
    onError: async (request, reply) => {
      if (!request.raw.complete) void reply.header('Connection', 'close');
    },
  }, async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const kind = parse(ChatAttachmentKindSchema, request.query.kind ?? 'image');
    const disconnected = kind === 'voice' ? new AbortController() : null;
    const onClose = () => { if (!reply.raw.writableFinished) disconnected?.abort(); };
    if (disconnected) {
      if (voiceUploads.has(user.id)) {
        throw new HttpError(409, 'voice_upload_in_progress', 'Your previous recording is still being attached.');
      }
      voiceUploads.add(user.id);
      reply.raw.once('close', onClose);
    }
    const deadline = kind === 'voice' ? setTimeout(() => request.raw.destroy(), VOICE_UPLOAD_DEADLINE_MS).unref() : undefined;
    const tmp = path.join(ctx.storage.tmpDir, `upload-chat-${newId()}`);
    let row: ChatAttachmentRow | undefined;
    let reservedEncoder = false;
    let receivedVoiceBytes = 0;
    try {
      if (kind === 'voice') {
        await receiveVoiceUpload(request, tmp, (bytes) => {
          if (temporaryVoiceBytes + bytes > MAX_VOICE_TEMP_BYTES) return false;
          temporaryVoiceBytes += bytes;
          receivedVoiceBytes += bytes;
          return true;
        });
      } else {
        const fileSize = LIMITS.photoNoteBytes;
        const part = await request.file({ limits: { fileSize } }).catch(() => {
          throw badRequest('Send one picture, as multipart/form-data.');
        });
        if (!part) throw badRequest('No picture was sent.');
        await pipeline(part.file, createWriteStream(tmp));
        if (part.file.truncated) throw badRequest(`That picture is larger than ${Math.round(fileSize / 1024 ** 2)} MB.`);
      }
      clearTimeout(deadline);
      if (disconnected) {
        const encoder = acquireEncoder(disconnected.signal);
        if (!encoder) {
          void reply.header('Retry-After', String(VOICE_ENCODER_RETRY_SECONDS));
          throw new HttpError(503, 'voice_upload_busy', 'The recording service is busy. Try attaching this recording again in a few minutes.');
        }
        reservedEncoder = await encoder;
        if (!reservedEncoder || disconnected.signal.aborted) return reply;
        requireMember(ctx.db, clubId, user.id);
      }
      row = insertChatAttachment(ctx.db, { userId: user.id, clubId, kind });
      const result = await (disconnected ? processChatVoice(ctx, row, tmp, disconnected.signal) : processChatImage(ctx, row, tmp));
      if (disconnected?.signal.aborted) {
        await discardChatAttachment(ctx, row.id);
        return reply;
      }
      return reply.code(201).send(uploaded(row, result));
    } catch (error) {
      if (row) deleteChatAttachmentRow(ctx.db, row.id);
      if (disconnected?.signal.aborted || (request.raw.destroyed && !request.raw.complete)) return reply;
      throw error;
    } finally {
      clearTimeout(deadline);
      if (reservedEncoder) releaseEncoder();
      if (disconnected) {
        reply.raw.off('close', onClose);
        voiceUploads.delete(user.id);
      }
      try {
        await rm(tmp, { force: true });
      } finally {
        temporaryVoiceBytes -= receivedVoiceBytes;
      }
    }
  });

  /** Take back an attachment before its message is sent (removed from the composer). */
  app.delete<{ Params: { attachmentId: string } }>('/api/chat/attachments/:attachmentId', async (request, reply) => {
    const user = requireUser(request);
    const row = chatAttachmentById(ctx.db, parse(IdSchema, request.params.attachmentId));
    if (!row || row.user_id !== user.id) throw notFound('Attachment not found.');
    if (row.message_id !== null) throw forbidden('That attachment has been sent. Delete the message to remove it.');
    await discardChatAttachment(ctx, row.id);
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
