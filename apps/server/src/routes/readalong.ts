import { IdSchema, type ReadAlongTrack } from '@bookclub/shared';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { requireEdition } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { RateLimiter } from '../auth/ratelimit';
import { queueIndexEdition } from '../cal/indexer';
import { type AppContext } from '../context';
import { HttpError, badRequest, forbidden, notFound, parse, tooMany } from '../lib/errors';
import { removeTranscript } from '../repos/readalong';
import {
  TRANSCRIPT_MAX_BYTES,
  checkTranscriptSize,
  importTranscriptBody,
  stopTranscriptionOf,
  readAlongTrack,
  requireTranscribable,
  scheduleAlignment,
  uploadDeadlineMs,
} from '../services/readalong';

/**
 * Transcripts one owner may upload in an hour: a few tries at one audiobook are plenty, and each is
 * read and lined up in full.
 */
const UPLOADS_PER_HOUR = 10;

/**
 * Transcripts being received or read at once on the whole server: each is held whole until it is
 * read. One of them at most is anyone's, so that nobody can keep everyone else waiting.
 */
const UPLOADS_AT_ONCE = 2;

/** An upload let in: its place among UPLOADS_AT_ONCE, held while its body comes in and while it is read. */
interface Place {
  /** Its body has all come in and is being read: the clock stops, and the place is kept until freed. */
  read(): void;
  /** Give the place back (only the first call does). */
  free(): void;
}

/**
 * Cut off an upload whose body did not come in time: told so (408) as Node tells a request that
 * runs out of its time, straight on the connection, which is then closed, so that the rest of the
 * body is never read.
 */
function cutOff(request: FastifyRequest, reply: FastifyReply): void {
  const socket = request.raw.socket;
  if (!reply.raw.headersSent && socket.writable) {
    const body = JSON.stringify({ error: { code: 'too_slow', message: 'The transcript took too long to arrive. Try again on a faster connection.' } });
    socket.write(`HTTP/1.1 408 Request Timeout\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  }
  socket.destroy();
}

export function readAlongRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * A transcript moves everyone's notes and places in the refined edition (D47), so only the club's
   * owner gives or removes one (a recogniser the server runs, TRANSCRIBE_COMMAND, needs nobody).
   */
  const ownerOfEdition = (request: FastifyRequest<{ Params: { editionId: string } }>) => {
    const user = requireUser(request);
    const access = requireEdition(ctx.db, parse(IdSchema, request.params.editionId), user.id);
    if (access.membership.role !== 'owner') throw forbidden('Only the club owner can give an audiobook a transcript, or take it away.');
    return { ...access, user };
  };
  const uploads = new RateLimiter(UPLOADS_PER_HOUR, 60 * 60_000);
  /** Whose transcripts are being received or read now: UPLOADS_AT_ONCE at most, one each. */
  const sending = new Set<string>();
  const places = new WeakMap<FastifyRequest, Place>();

  /**
   * Let a user's upload in. Its body must have come in within `deadlineMs`, or it is cut off. Its
   * place is given back once, however it ends: answered (read or refused), cut off, or its
   * connection gone (at once if that went while it was being signed in). One being read keeps its
   * place until it has been read, connection or not: its body is held until then.
   */
  const admit = (request: FastifyRequest, reply: FastifyReply, userId: string, deadlineMs: number) => {
    sending.add(userId);
    let reading = false;
    let freed = false;
    const timer = setTimeout(() => cutOff(request, reply), deadlineMs);
    timer.unref();
    const place: Place = {
      read: () => {
        reading = true;
        clearTimeout(timer);
      },
      free: () => {
        if (freed) return;
        freed = true;
        clearTimeout(timer);
        sending.delete(userId);
      },
    };
    places.set(request, place);
    reply.raw.once('close', () => {
      if (!reading) place.free();
    });
    if (reply.raw.destroyed) place.free();
  };

  // A scope of its own, where a JSON body arrives as bytes: a transcript is parsed in a worker
  // thread (importTranscriptBody), never on the server's thread.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    /** Give an audiobook what a speech recogniser heard in it; the book is then lined up in the background. */
    scope.put<{ Params: { editionId: string }; Body: Buffer | undefined }>(
      '/api/editions/:editionId/transcript',
      {
        // Tens of megabytes, not the 1 MB of other requests.
        bodyLimit: TRANSCRIPT_MAX_BYTES,
        // All that can be settled before the body is read is: who may, what for, how big a transcript
        // of this audiobook can be, whether they are sending one already, whether there is room, and
        // how often. Nobody else's megabytes, nor more than any transcript of the audiobook can
        // weigh, are read.
        preParsing: async (request, reply, payload) => {
          const { edition, user } = ownerOfEdition(request);
          requireTranscribable(edition);
          const length = request.headers['content-length'];
          if (length === undefined) throw new HttpError(411, 'length_required', 'Send the transcript with its length (a Content-Length header).');
          const bytes = Number(length);
          checkTranscriptSize(ctx, edition, bytes);
          if (sending.has(user.id)) throw new HttpError(429, 'already_sending', 'You are already sending a transcript. Try again once it is in.');
          if (sending.size >= UPLOADS_AT_ONCE) throw new HttpError(503, 'busy', 'The server is reading other transcripts. Try again in a minute.');
          if (!uploads.attempt(user.id)) throw tooMany('That is a lot of transcripts in an hour. Try again later.');
          admit(request, reply, user.id, uploadDeadlineMs(ctx, bytes));
          return payload;
        },
      },
      async (request, reply) => {
        const place = places.get(request);
        place?.read();
        try {
          const { edition, book } = ownerOfEdition(request);
          if (!Buffer.isBuffer(request.body)) throw badRequest('Send the transcript as JSON.');
          if (!(await importTranscriptBody(ctx, edition, request.body))) throw notFound('Edition not found.');
          scheduleAlignment(ctx, book.id);
          return reply.code(202).send({ status: 'aligning' });
        } finally {
          place?.free();
        }
      },
    );
  });

  /**
   * Forget an audiobook's transcript: it goes back to chapter-level sync, and the server's own
   * recogniser leaves it alone from then on, restarts included (the owner can upload another).
   */
  app.delete<{ Params: { editionId: string } }>('/api/editions/:editionId/transcript', async (request, reply) => {
    const access = ownerOfEdition(request);
    removeTranscript(ctx.db, access.edition.id);
    // A recogniser reading it now stops too: the owner wants none.
    stopTranscriptionOf(ctx, access.edition.id);
    scheduleAlignment(ctx, access.book.id);
    // Cal has nothing of this audiobook left to search until it has another transcript.
    queueIndexEdition(ctx, access.edition.id);
    return reply.code(204).send();
  });

  /** The sentences one track reads, with their place in the text, for reading along. */
  app.get<{ Params: { editionId: string }; Querystring: { track?: string } }>('/api/editions/:editionId/readalong', async (request, reply): Promise<ReadAlongTrack> => {
    const user = requireUser(request);
    const { edition } = requireEdition(ctx.db, parse(IdSchema, request.params.editionId), user.id);
    const track = Number.parseInt(request.query.track ?? '', 10);
    if (edition.kind !== 'audio' || !Number.isInteger(track) || track < 0) throw notFound('No read-along here.');
    const found = await readAlongTrack(ctx, edition, track);
    if (!found) throw notFound('No read-along here.');
    // It changes when the book is lined up again: always ask, privately.
    void reply.header('Cache-Control', 'private, no-cache');
    return found;
  });
}
