import {
  type CommentView,
  CreateCommentBodySchema,
  CreateReplyBodySchema,
  type Locator,
  IdSchema,
  ProgressUpdateBodySchema,
  MAX_PAGE_CHARS,
  type Places,
  PlacesQuerySchema,
  ReadUpToBodySchema,
  type MemberProgress,
  locatorToM,
  mToT,
} from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireBook, requireComment } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors';
import { fromJson, toJson } from '../lib/json';
import { type BookRow, bookById, editionById, editionTimeline } from '../repos/books';
import { members } from '../repos/clubs';
import { blobById, deleteUnusedBlobRow } from '../repos/blobs';
import { type CommentMediaRow, attachMedia, mediaForComment, mediaForComments, takeMediaForComment } from '../repos/comment-media';
import { commentByClientId, commentById, commentsForBook, insertComment, softDeleteComment } from '../repos/comments';
import { progressFor, readingOf } from '../repos/progress';
import { toMemberProgress } from '../services/books';
import { gateFor, toCommentView, writerHorizon } from '../services/gating';
import { transcribeVoiceNote } from '../services/note-media';
import { notifyReached, notifyReply } from '../services/notifications';
import { applyProgress, bookProgress, readUpTo, tFor } from '../services/progress';
import { deviceOf, recordHistory } from '../services/history';

/**
 * Claim uploaded media (D140) for a freshly posted note or reply: every id named must be theirs
 * and still unattached, or the whole attachment fails (never a note left with only some of what
 * its writer meant). A voice note already transcoding gets its transcript in the background
 * (D143): queued here, once there is a comment id to republish when it is ready.
 */
function claimMedia(ctx: AppContext, bookId: string, userId: string, commentId: string, mediaIds: readonly string[] | undefined): void {
  if (!mediaIds || mediaIds.length === 0) return;
  if (!attachMedia(ctx.db, commentId, userId, bookId, mediaIds)) throw conflict('That media was already used, or is not yours.', 'media_gone');
  for (const m of mediaForComment(ctx.db, commentId)) {
    if (m.kind === 'voice' && m.transcript_status === 'queued') scheduleVoiceTranscription(ctx, bookId, m);
  }
}

/** Run a voice note's transcription in the background, then republish its comment with it (D143). */
function scheduleVoiceTranscription(ctx: AppContext, bookId: string, media: CommentMediaRow): void {
  if (!media.comment_id) return;
  ctx.slowJobs.enqueue(`note-transcribe:${media.id}`, async () => {
    const blob = media.original_blob_id ? blobById(ctx.db, media.original_blob_id) : undefined;
    if (!blob) return;
    await transcribeVoiceNote(ctx, media.id, ctx.storage.blobPath(blob.id));
    const comment = commentById(ctx.db, media.comment_id!);
    const book = comment ? bookById(ctx.db, bookId) : undefined;
    if (!comment || !book) return;
    const gate = gateFor(ctx.db, book);
    const freshMedia = mediaForComment(ctx.db, comment.id);
    ctx.hub.publish(book.club_id, (recipientId) => ({
      type: 'comment:new',
      clubId: book.club_id,
      bookId: book.id,
      comment: gate.view(comment, recipientId, readingOf(ctx.db, recipientId, book.id), freshMedia),
    }));
  });
}

/** Media is deleted with its note (D140): its rows, and the blobs nothing else still refers to. */
async function deleteMediaOf(ctx: AppContext, commentId: string): Promise<void> {
  for (const m of takeMediaForComment(ctx.db, commentId)) {
    for (const blobId of [m.original_blob_id, m.derived_blob_id, m.poster_blob_id]) {
      if (blobId && deleteUnusedBlobRow(ctx.db, blobId)) await ctx.storage.removeBlob(blobId);
    }
  }
}

function requireReadyEdition(book: BookRow, editionId: string, ctx: AppContext) {
  const edition = editionById(ctx.db, editionId);
  if (!edition || edition.book_id !== book.id) throw badRequest('That edition does not belong to this book.');
  if (edition.status !== 'ready') throw badRequest('That edition is not ready yet.');
  return edition;
}

export function readingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const broadcastProgress = (book: BookRow, userId: string) => {
    const row = progressFor(ctx.db, userId, book.id);
    const member = members(ctx.db, book.club_id).find((m) => m.userId === userId);
    if (!row || !member) return;
    const progress: MemberProgress = toMemberProgress(ctx.db, book, row, member.displayName);
    ctx.hub.publish(book.club_id, () => ({ type: 'progress', clubId: book.club_id, bookId: book.id, progress }));
  };

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/progress', async (request) => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    return bookProgress(ctx.db, user.id, book);
  });

  app.put<{ Params: { bookId: string } }>('/api/books/:bookId/progress', async (request) => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const body = parse(ProgressUpdateBodySchema, request.body);
    const edition = requireReadyEdition(book, body.editionId, ctx);
    const outcome = applyProgress(ctx.db, user.id, book, edition, body);
    recordHistory(ctx.db, user.id, book, edition, deviceOf(request.headers['user-agent']), body);
    if (outcome.changed) broadcastProgress(book, user.id);
    notifyReached(ctx, book, user.id, outcome.revealed);
    return { mine: outcome.mine, revealed: outcome.revealed };
  });

  /** Progress sent with navigator.sendBeacon when the page is hidden (text/plain body). */
  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/progress/beacon', async (request, reply) => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    let raw: unknown = request.body;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        throw badRequest('The progress report is not valid JSON.');
      }
    }
    const body = parse(ProgressUpdateBodySchema, raw);
    const edition = requireReadyEdition(book, body.editionId, ctx);
    const outcome = applyProgress(ctx.db, user.id, book, edition, body);
    recordHistory(ctx.db, user.id, book, edition, deviceOf(request.headers['user-agent']), body);
    if (outcome.changed) broadcastProgress(book, user.id);
    notifyReached(ctx, book, user.id, outcome.revealed);
    return reply.code(204).send();
  });

  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/progress/read-up-to', async (request) => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const body = parse(ReadUpToBodySchema, request.body);
    const edition = requireReadyEdition(book, body.editionId, ctx);
    const outcome = readUpTo(ctx.db, user.id, book, edition, body.locator);
    broadcastProgress(book, user.id);
    notifyReached(ctx, book, user.id, outcome.revealed);
    return { mine: outcome.mine, revealed: outcome.revealed };
  });

  /**
   * The exact places of the closed notes on the page in front of you (D80). The list gives a note
   * at a place you have not read only roughly; on the page you look at, the reader marks it on its
   * line, as on any page (D72): what is on screen, and no more than a page of it at a time.
   */
  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/places', async (request): Promise<Places> => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const query = parse(PlacesQuerySchema, request.query);
    const edition = editionById(ctx.db, query.edition);
    const timeline = edition && edition.book_id === book.id ? editionTimeline(edition) : null;
    if (!edition || !timeline) throw notFound('Edition not found.');
    const { geometry, sync } = timeline;
    let span: [number, number];
    if (geometry.kind === 'epub') {
      const { section, from, to } = query;
      if (section === undefined || from === undefined || to === undefined || section >= geometry.sectionLengths.length) throw badRequest('Say which characters of which section.');
      const at = (offset: number) => locatorToM(geometry, { kind: 'epub', section, offset: Math.min(offset, geometry.sectionLengths[section]!) });
      span = [at(from), at(Math.min(Math.max(to, from), from + MAX_PAGE_CHARS))];
    } else if (geometry.kind === 'pdf') {
      if (query.page === undefined || query.page >= geometry.pageCount) throw badRequest('Say which page.');
      span = [query.page, query.page + 1];
    } else {
      throw badRequest('An audiobook has no pages.');
    }
    const [t0, t1] = [mToT(sync, span[0]), mToT(sync, span[1])];
    const gate = gateFor(ctx.db, book);
    const reading = readingOf(ctx.db, user.id, book.id);
    const places: Places['places'] = [];
    for (const c of commentsForBook(ctx.db, book.id)) {
      if (c.t < t0 - 1e-9 || c.t > t1 + 1e-9) continue;
      const view = gate.view(c, user.id, reading);
      if (view.hidden && view.approx) places.push({ id: c.id, t: c.t, locator: fromJson<Locator>(c.locator_json, view.locator) });
    }
    return { places };
  });

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/comments', async (request): Promise<CommentView[]> => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const gate = gateFor(ctx.db, book);
    const reading = readingOf(ctx.db, user.id, book.id);
    const comments = commentsForBook(ctx.db, book.id);
    const media = mediaForComments(ctx.db, comments.map((c) => c.id));
    // In the order of the places each friend is given (a note ahead of them only roughly placed, D80).
    return comments.map((c) => gate.view(c, user.id, reading, media.get(c.id) ?? [])).sort((a, b) => a.t - b.t);
  });

  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/comments', async (request, reply) => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const body = parse(CreateCommentBodySchema, request.body);
    if (body.clientId) {
      const existing = commentByClientId(ctx.db, user.id, body.clientId);
      if (existing) {
        // A retry returns the comment it created; it never brings a deleted one back or makes a second.
        if (existing.deleted_at !== null) throw conflict('That comment was deleted.');
        if (existing.book_id !== book.id) throw conflict('That client id belongs to a comment on another book.');
        return reply.code(200).send(toCommentView(existing, true, null, null, mediaForComment(ctx.db, existing.id)));
      }
    }
    const edition = requireReadyEdition(book, body.editionId, ctx);
    if (body.endLocator && body.endLocator.kind !== body.locator.kind) throw badRequest('A comment range must stay in one format.');
    const t = tFor(edition, body.locator);
    const rawEndT = body.endLocator ? tFor(edition, body.endLocator) : null;
    const endT = rawEndT !== null && rawEndT >= t ? rawEndT : null;
    const hasMedia = (body.mediaIds?.length ?? 0) > 0;
    // Media alone still needs a non-null `text` for the database's own invariant (CHECK: text or
    // reaction); never shown, since hasText and the UI both read an empty string as none (D140).
    const text = body.text && body.text.length > 0 ? body.text : hasMedia ? '' : null;
    const gate = gateFor(ctx.db, book);
    const place = { user_id: user.id, edition_id: edition.id, locator_json: toJson(body.locator), end_locator_json: body.endLocator ? toJson(body.endLocator) : null, t, end_t: endT };
    // One step: a note claiming media that turns out to be someone else's, or already spent,
    // must never leave a media-less note behind it.
    const id = ctx.db.tx(() => {
      const created = insertComment(ctx.db, {
        bookId: book.id,
        userId: user.id,
        editionId: edition.id,
        kind: edition.kind,
        locator: body.locator,
        endLocator: body.endLocator ?? null,
        t,
        endT,
        quote: body.quote?.trim() ? body.quote.trim() : null,
        text,
        reaction: body.reaction ?? null,
        clientId: body.clientId ?? null,
        // Words or media written from further on wait for it too (D69), unless their writer says
        // they are only about this passage; a reaction alone says nothing more.
        horizon: (!body.text && !hasMedia) || body.aboutHere ? null : writerHorizon(ctx.db, gate, book, user.id, place),
      });
      claimMedia(ctx, book.id, user.id, created, body.mediaIds);
      return created;
    });
    const comment = commentById(ctx.db, id)!;
    const media = mediaForComment(ctx.db, id);
    // Each member gets the version they are allowed to see.
    ctx.hub.publish(book.club_id, (recipientId) => ({
      type: 'comment:new',
      clubId: book.club_id,
      bookId: book.id,
      comment: gate.view(comment, recipientId, readingOf(ctx.db, recipientId, book.id), media),
    }));
    // The writer's own view: with where friends must have read to before its words reach them.
    return reply.code(201).send(gate.view(comment, user.id, readingOf(ctx.db, user.id, book.id), media));
  });

  /**
   * Answer a note (D48). A reply sits at the note's place, and waits as well for where its writer
   * had read to (D69): a friend far ahead answers an early note without the later chapters
   * reaching those who have read only that far. You can only answer a note you can read, and
   * answering a reply answers its note.
   */
  app.post<{ Params: { commentId: string } }>('/api/comments/:commentId/replies', async (request, reply) => {
    const user = requireUser(request);
    const access = requireComment(ctx.db, parse(IdSchema, request.params.commentId), user.id);
    const body = parse(CreateReplyBodySchema, request.body);
    const book = access.book;
    if (body.clientId) {
      const existing = commentByClientId(ctx.db, user.id, body.clientId);
      if (existing) {
        if (existing.deleted_at !== null) throw conflict('That reply was deleted.');
        if (existing.book_id !== book.id) throw conflict('That client id belongs to a comment on another book.');
        return reply.code(200).send(toCommentView(existing, true, null, null, mediaForComment(ctx.db, existing.id)));
      }
    }
    const root = access.comment.parent_id ? commentById(ctx.db, access.comment.parent_id) : access.comment;
    if (!root) throw notFound('That note is gone.');
    const gate = gateFor(ctx.db, book);
    if (!gate.isOpen(root, user.id, readingOf(ctx.db, user.id, book.id))) throw forbidden('Read this far first: the note is ahead of you.');
    const hasMedia = (body.mediaIds?.length ?? 0) > 0;
    const text = body.text && body.text.length > 0 ? body.text : hasMedia ? '' : null;
    const id = ctx.db.tx(() => {
      const created = insertComment(ctx.db, {
        bookId: book.id,
        userId: user.id,
        editionId: root.edition_id,
        kind: root.kind,
        locator: fromJson<Locator>(root.locator_json, { kind: 'epub', section: 0, offset: 0 }),
        endLocator: root.end_locator_json ? fromJson<Locator>(root.end_locator_json, { kind: 'epub', section: 0, offset: 0 }) : null,
        t: root.t,
        endT: root.end_t,
        quote: null,
        text,
        reaction: body.reaction ?? null,
        clientId: body.clientId ?? null,
        parentId: root.id,
        // Only about the note's passage, its writer says: it opens with the note (D69).
        horizon: body.aboutHere ? null : writerHorizon(ctx.db, gate, book, user.id, root),
      });
      claimMedia(ctx, book.id, user.id, created, body.mediaIds);
      return created;
    });
    const created = commentById(ctx.db, id)!;
    const media = mediaForComment(ctx.db, id);
    ctx.hub.publish(book.club_id, (recipientId) => ({
      type: 'comment:new',
      clubId: book.club_id,
      bookId: book.id,
      comment: gate.view(created, recipientId, readingOf(ctx.db, recipientId, book.id), media),
    }));
    notifyReply(ctx, book, root, created);
    return reply.code(201).send(gate.view(created, user.id, readingOf(ctx.db, user.id, book.id), media));
  });

  app.delete<{ Params: { commentId: string } }>('/api/comments/:commentId', async (request, reply) => {
    const user = requireUser(request);
    const access = requireComment(ctx.db, parse(IdSchema, request.params.commentId), user.id);
    if (access.comment.user_id !== user.id && access.membership.role !== 'owner') throw forbidden('You can only delete your own comments.');
    softDeleteComment(ctx.db, access.comment.id);
    // Its media goes with it (D140): a deleted note keeps no bytes, even as a placeholder.
    await deleteMediaOf(ctx, access.comment.id);
    const book = access.book;
    const gone = (commentId: string) => ctx.hub.publish(book.club_id, () => ({ type: 'comment:deleted', clubId: book.club_id, bookId: book.id, commentId }));
    const placeholder = (id: string) => {
      const kept = commentsForBook(ctx.db, book.id).find((c) => c.id === id);
      if (!kept) return false;
      const gate = gateFor(ctx.db, book);
      ctx.hub.publish(book.club_id, (recipientId) => ({
        type: 'comment:new',
        clubId: book.club_id,
        bookId: book.id,
        comment: gate.view(kept, recipientId, readingOf(ctx.db, recipientId, book.id), []),
      }));
      return true;
    };
    const parentId = access.comment.parent_id;
    // A note with replies stays for them, without its words; a reply that was the last one under a
    // deleted note takes the note's placeholder with it.
    if (parentId === null) {
      if (!placeholder(access.comment.id)) gone(access.comment.id);
    } else {
      gone(access.comment.id);
      if (!commentsForBook(ctx.db, book.id).some((c) => c.id === parentId)) gone(parentId);
    }
    return reply.code(204).send();
  });
}
