import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { IdSchema, LIMITS, type UploadedChatAttachment } from '@bookclub/shared';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { requireMember } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { newId } from '../lib/crypto';
import { badRequest, forbidden, notFound, parse } from '../lib/errors';
import { sendFile } from '../lib/send';
import { blobById } from '../repos/blobs';
import { chatMessageById } from '../repos/chat';
import { type ChatAttachmentRow, chatAttachmentById, deleteChatAttachmentRow, insertChatAttachment } from '../repos/chat-attachments';
import { canReadMessage } from '../services/chat';
import { discardChatAttachment, processChatImage } from '../services/chat-images';

/** Never cached, by the browser or the service worker: the message's gate is checked live, every time (D144, D203). */
const GATED = 'private, no-store';
/** A picture opened on its own runs nothing (as every other file this app serves). */
const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

function uploaded(row: ChatAttachmentRow, result: { status: 'ready' | 'failed'; width: number | null; height: number | null; error: string | null }): UploadedChatAttachment {
  return { id: row.id, kind: 'image', status: result.status, width: result.width, height: result.height, error: result.error };
}

/**
 * Pictures in chat (D203). Uploaded before the message that carries them, one per bounded
 * multipart request (as a note's media, D140, not tus: a picture is megabytes, not an audiobook),
 * made safe inline (services/chat-images.ts) and claimed when the message is sent (routes/chat.ts).
 * Served at two addresses per picture, its full size and its thumbnail, each answering only a
 * member of its club who may read its message right now (the message's own spoiler fence, D150),
 * or, before it is sent, only the person who uploaded it.
 */
export function chatAttachmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/chat/attachments', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    let part;
    try {
      part = await request.file({ limits: { fileSize: LIMITS.photoNoteBytes } });
    } catch {
      throw badRequest('Send one picture, as multipart/form-data.');
    }
    if (!part) throw badRequest('No picture was sent.');
    const row = insertChatAttachment(ctx.db, { userId: user.id, clubId });
    const tmp = path.join(ctx.storage.tmpDir, `upload-chat-${newId()}`);
    try {
      await pipeline(part.file, createWriteStream(tmp));
      if (part.file.truncated) {
        deleteChatAttachmentRow(ctx.db, row.id);
        throw badRequest(`That picture is larger than ${Math.round(LIMITS.photoNoteBytes / 1024 ** 2)} MB.`);
      }
      return reply.code(201).send(uploaded(row, await processChatImage(ctx, row, tmp)));
    } finally {
      await rm(tmp, { force: true });
    }
  });

  /** Take back a picture before its message is sent (removed from the composer). */
  app.delete<{ Params: { attachmentId: string } }>('/api/chat/attachments/:attachmentId', async (request, reply) => {
    const user = requireUser(request);
    const row = chatAttachmentById(ctx.db, parse(IdSchema, request.params.attachmentId));
    if (!row || row.user_id !== user.id) throw notFound('Picture not found.');
    if (row.message_id !== null) throw forbidden('That picture has been sent; delete the message instead.');
    await discardChatAttachment(ctx, row);
    return reply.code(204).send();
  });

  /** The picture behind an address, if this person may see it now; 404 otherwise, never saying why. */
  const openFor = (attachmentId: string, userId: string): ChatAttachmentRow => {
    const row = chatAttachmentById(ctx.db, attachmentId);
    if (!row || row.status !== 'ready') throw notFound();
    if (row.message_id === null) {
      if (row.user_id !== userId) throw notFound();
      return row;
    }
    const message = chatMessageById(ctx.db, row.message_id);
    if (!message) throw notFound();
    requireMember(ctx.db, message.club_id, userId);
    if (!canReadMessage(ctx.db, message, userId)) throw notFound();
    return row;
  };

  const sendPicture = async (request: FastifyRequest<{ Params: { attachmentId: string } }>, reply: FastifyReply, which: 'blob_id' | 'thumb_blob_id') => {
    const user = requireUser(request);
    const row = openFor(parse(IdSchema, request.params.attachmentId), user.id);
    const blobId = row[which];
    const blob = blobId ? blobById(ctx.db, blobId) : undefined;
    if (!blob) throw notFound();
    return sendFile(request, reply, {
      path: ctx.storage.blobPath(blob.id),
      contentType: blob.mime,
      etag: blob.sha256,
      cacheControl: GATED,
      headers: { 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': FILE_CSP },
    });
  };

  app.get<{ Params: { attachmentId: string } }>('/media/chat/:attachmentId', (request, reply) => sendPicture(request, reply, 'blob_id'));
  app.get<{ Params: { attachmentId: string } }>('/media/chat/:attachmentId/thumb', (request, reply) => sendPicture(request, reply, 'thumb_blob_id'));
}
