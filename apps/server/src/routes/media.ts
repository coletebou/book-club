import { readFile } from 'node:fs/promises';
import { IdSchema } from '@bookclub/shared';
import { SERVED_MEDIA_TYPES, mediaTypeForPath } from '@bookclub/epub';
import { type FastifyInstance } from 'fastify';
import { requireBook, requireEdition } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { notFound, parse } from '../lib/errors';
import { sendFile } from '../lib/send';
import { COVER_DRAWING, coverThumbnail, generatedCoverWebp, pickCoverWidth, pickSquareSize, squareCover } from '../ingest/covers';
import { audioMimeForName, editionFile } from '../repos/books';
import { blobById } from '../repos/blobs';
import { type CommentMediaRow, commentMediaById } from '../repos/comment-media';
import { commentById } from '../repos/comments';
import { readingOf } from '../repos/progress';
import { gateFor } from '../services/gating';
import { sha256Hex } from '../lib/crypto';

/** Auth-gated, immutable content: private caching only (never `public`; v1 lesson). */
const IMMUTABLE_PRIVATE = 'private, max-age=31536000, immutable';
const PRIVATE_DAY = 'private, max-age=86400';

/** No scripts in book content, ever; framing only by our own pages. */
const EPUB_DOCUMENT_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

/**
 * Every other file of a book (a style sheet, a picture, a font) is never a page: opened on its
 * own, it is sandboxed with nothing allowed.
 */
const EPUB_RESOURCE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox";

/**
 * Covers, PDFs and tracks are fetched by the app, never shown as pages of it; opened on their own
 * (a tab, a link), they run nothing. Media and pictures stay allowed for the browser's own viewer.
 */
const FILE_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

/**
 * A note's media (D140), gated exactly as its comment's words are (D69, D80): until a member has
 * read its place, the bytes, its duration and its dimensions are refused, not just its words,
 * never cached by the service worker (`private, no-store`, below) so a gated file can never be
 * what offline reading finds in its cache. Unattached media (not yet posted) is its uploader's
 * alone, for the composer's own preview.
 */
function requireOpenMedia(ctx: AppContext, mediaId: string, userId: string): CommentMediaRow {
  const media = commentMediaById(ctx.db, mediaId);
  if (!media) throw notFound();
  if (media.comment_id === null) {
    if (media.user_id !== userId) throw notFound();
    return media;
  }
  const comment = commentById(ctx.db, media.comment_id);
  if (!comment) throw notFound();
  const { book } = requireBook(ctx.db, comment.book_id, userId);
  const gate = gateFor(ctx.db, book);
  if (!gate.isOpen(comment, userId, readingOf(ctx.db, userId, book.id))) throw notFound();
  return media;
}

/** Never cached (by the browser or the service worker): gating can only be checked live, every time. */
const GATED_MEDIA_CACHE = 'private, no-store';

export function mediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { mediaId: string } }>('/media/notes/:mediaId/file', async (request, reply) => {
    const user = requireUser(request);
    const media = requireOpenMedia(ctx, parse(IdSchema, request.params.mediaId), user.id);
    const blobId = media.status === 'ready' ? media.derived_blob_id ?? media.original_blob_id : null;
    const blob = blobId ? blobById(ctx.db, blobId) : undefined;
    if (!blob) throw notFound();
    return sendFile(request, reply, {
      path: ctx.storage.blobPath(blob.id),
      contentType: media.mime ?? blob.mime,
      etag: blob.sha256,
      cacheControl: GATED_MEDIA_CACHE,
      headers: { 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': FILE_CSP },
    });
  });

  app.get<{ Params: { mediaId: string } }>('/media/notes/:mediaId/poster', async (request, reply) => {
    const user = requireUser(request);
    const media = requireOpenMedia(ctx, parse(IdSchema, request.params.mediaId), user.id);
    const blob = media.poster_blob_id ? blobById(ctx.db, media.poster_blob_id) : undefined;
    if (!blob) throw notFound();
    return sendFile(request, reply, {
      path: ctx.storage.blobPath(blob.id),
      contentType: 'image/jpeg',
      etag: blob.sha256,
      cacheControl: GATED_MEDIA_CACHE,
      headers: { 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': FILE_CSP },
    });
  });


  const mediaTypesCache = new Map<string, Record<string, string>>();
  const mediaTypes = async (editionId: string): Promise<Record<string, string>> => {
    let types = mediaTypesCache.get(editionId);
    if (!types) {
      const file = ctx.storage.pubFile(editionId, '.media-types.json');
      types = file ? (JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, string>) : {};
      if (mediaTypesCache.size > 200) mediaTypesCache.clear();
      mediaTypesCache.set(editionId, types);
    }
    return types;
  };

  app.get<{ Params: { bookId: string }; Querystring: { w?: string; v?: string; shape?: string } }>('/media/books/:bookId/cover', async (request, reply) => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    // `shape=square`: the lock screen's artwork (D190), drawn from the largest 2:3 thumbnail.
    const square = request.query.shape === 'square' ? pickSquareSize(request.query.w) : null;
    const width = square ? 640 : pickCoverWidth(request.query.w);
    const cacheControl = request.query.v ? IMMUTABLE_PRIVATE : PRIVATE_DAY;
    const headers = { 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': FILE_CSP };
    if (book.cover_blob_id && blobById(ctx.db, book.cover_blob_id)) {
      const thumb = await coverThumbnail(ctx.storage.blobPath(book.cover_blob_id), ctx.storage.derivedDir, book.cover_blob_id, width);
      const file = square ? await squareCover(thumb, ctx.storage.derivedDir, book.cover_blob_id, square) : thumb;
      const etag = square ? `${book.cover_blob_id}-sq${square}-v${COVER_DRAWING}` : `${book.cover_blob_id}-${width}-v${COVER_DRAWING}`;
      return sendFile(request, reply, { path: file, contentType: 'image/webp', etag, cacheControl, headers });
    }
    const key = sha256Hex(`${book.title}\u0000${book.author}`).slice(0, 16);
    const thumb = await generatedCoverWebp(book.title, book.author, ctx.storage.derivedDir, key, width);
    const file = square ? await squareCover(thumb, ctx.storage.derivedDir, `gen-${key}`, square) : thumb;
    return sendFile(request, reply, { path: file, contentType: 'image/webp', etag: square ? `gen-${key}-sq${square}` : `gen-${key}-${width}`, cacheControl: PRIVATE_DAY, headers });
  });

  app.get<{ Params: { editionId: string; '*': string } }>('/media/editions/:editionId/epub/*', async (request, reply) => {
    const user = requireUser(request);
    const { edition } = requireEdition(ctx.db, parse(IdSchema, request.params.editionId), user.id);
    if (edition.kind !== 'epub' || edition.status !== 'ready') throw notFound();
    // Already decoded by the router: decoding again would break names with a % in them.
    const containerPath = request.params['*'];
    if (containerPath.startsWith('.') || containerPath.includes('/.')) throw notFound();
    const file = ctx.storage.pubFile(edition.id, containerPath);
    if (!file) throw notFound();
    // Ingest decides what each file is served as (D39); an edition ingested before that may list
    // types its EPUB declared, so anything outside the served set falls back to the extension.
    const listed = (await mediaTypes(edition.id))[containerPath];
    const type = listed && SERVED_MEDIA_TYPES.has(listed) ? listed : mediaTypeForPath(containerPath);
    if (!SERVED_MEDIA_TYPES.has(type)) throw notFound();
    const isDocument = type === 'application/xhtml+xml';
    return sendFile(request, reply, {
      path: file,
      contentType: isDocument ? 'application/xhtml+xml; charset=utf-8' : type,
      etag: `${edition.id}:${sha256Hex(containerPath).slice(0, 16)}`,
      cacheControl: IMMUTABLE_PRIVATE,
      headers: { 'Content-Security-Policy': isDocument ? EPUB_DOCUMENT_CSP : EPUB_RESOURCE_CSP, 'Cross-Origin-Resource-Policy': 'same-origin' },
    });
  });

  app.get<{ Params: { editionId: string } }>('/media/editions/:editionId/file', async (request, reply) => {
    const user = requireUser(request);
    const { edition } = requireEdition(ctx.db, parse(IdSchema, request.params.editionId), user.id);
    const file = editionFile(ctx.db, edition.id, 0);
    if (!file || edition.kind === 'audio') throw notFound();
    const blob = blobById(ctx.db, file.blob_id);
    if (!blob) throw notFound();
    return sendFile(request, reply, {
      path: ctx.storage.blobPath(blob.id),
      contentType: edition.kind === 'pdf' ? 'application/pdf' : 'application/epub+zip',
      etag: blob.sha256,
      cacheControl: IMMUTABLE_PRIVATE,
      headers: {
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': FILE_CSP,
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.original_name)}"`,
      },
    });
  });

  app.get<{ Params: { editionId: string; index: string } }>('/media/editions/:editionId/tracks/:index', async (request, reply) => {
    const user = requireUser(request);
    const { edition } = requireEdition(ctx.db, parse(IdSchema, request.params.editionId), user.id);
    const index = Number.parseInt(request.params.index, 10);
    if (edition.kind !== 'audio' || !Number.isInteger(index) || index < 0) throw notFound();
    const file = editionFile(ctx.db, edition.id, index);
    const blob = file ? blobById(ctx.db, file.blob_id) : undefined;
    if (!file || !blob) throw notFound();
    return sendFile(request, reply, {
      path: ctx.storage.blobPath(blob.id),
      contentType: audioMimeForName(file.original_name),
      etag: blob.sha256,
      cacheControl: IMMUTABLE_PRIVATE,
      headers: { 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': FILE_CSP },
    });
  });
}
