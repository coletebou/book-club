import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { IdSchema, NoteMediaKindSchema, type UploadedNoteMedia } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireBook } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { badRequest, forbidden, notFound, parse } from '../lib/errors';
import { newId } from '../lib/crypto';
import { deleteUnusedBlobRow } from '../repos/blobs';
import { type CommentMediaRow, commentMediaById, deleteCommentMediaRow, insertCommentMedia } from '../repos/comment-media';
import { MAX_BYTES, processNoteMediaUpload } from '../services/note-media';

function toUploadedView(media: CommentMediaRow): UploadedNoteMedia {
  return { id: media.id, kind: media.kind, status: media.status, mime: media.mime, durationMs: media.duration_ms, width: media.width, height: media.height, error: media.error };
}

/**
 * Note media (D140): uploaded before the note that will carry it, so the composer knows at once
 * whether a recording came through (D142). A bounded multipart endpoint, not tus (D140): a voice
 * note, a photo or a short video is at most tens of megabytes, far under what one request can
 * carry comfortably, and tus's resumability is for the multi-hundred-megabyte audiobook uploads
 * it was built for (routes/imports.ts); these never need it.
 */
export function noteMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { bookId: string }; Querystring: { kind?: string } }>('/api/books/:bookId/media', async (request, reply) => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const kind = parse(NoteMediaKindSchema, request.query.kind);
    let part;
    try {
      part = await request.file({ limits: { fileSize: MAX_BYTES[kind] } });
    } catch {
      throw badRequest('Send one file, as multipart/form-data.');
    }
    if (!part) throw badRequest('No file was sent.');
    const media = insertCommentMedia(ctx.db, { userId: user.id, bookId: book.id, kind });
    const tmp = path.join(ctx.storage.tmpDir, `upload-media-${newId()}`);
    try {
      await pipeline(part.file, createWriteStream(tmp));
      if (part.file.truncated) {
        deleteCommentMediaRow(ctx.db, media.id);
        throw badRequest('That file is larger than this kind of note allows.');
      }
      const result = await processNoteMediaUpload(ctx, media, tmp);
      return reply.code(201).send(toUploadedView({ ...media, status: result.status, mime: result.mime, duration_ms: result.durationMs, width: result.width, height: result.height, error: result.error }));
    } finally {
      await rm(tmp, { force: true });
    }
  });

  /** Discard an upload before it is attached to a note (the composer was closed, or re-recorded). */
  app.delete<{ Params: { mediaId: string } }>('/api/notes-media/:mediaId', async (request, reply) => {
    const user = requireUser(request);
    const media = commentMediaById(ctx.db, parse(IdSchema, request.params.mediaId));
    if (!media || media.user_id !== user.id) throw notFound('Upload not found.');
    if (media.comment_id !== null) throw forbidden('That note has already been posted; delete the note instead.');
    deleteCommentMediaRow(ctx.db, media.id);
    for (const blobId of [media.original_blob_id, media.derived_blob_id, media.poster_blob_id]) {
      if (blobId && deleteUnusedBlobRow(ctx.db, blobId)) await ctx.storage.removeBlob(blobId);
    }
    return reply.code(204).send();
  });
}
