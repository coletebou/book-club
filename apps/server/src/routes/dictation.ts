import { IdSchema } from '@bookclub/shared';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { requireMember } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { calBudgetSpent } from '../cal/store';
import { sttProviderFor } from '../cal/voice';
import { decodeDictationAudio } from '../cal/voice/dictation-audio';
import { transcribeAndLog, voiceRateLimiterFor } from '../cal/voice/transcription';
import { type AppContext } from '../context';
import { HttpError, badRequest, notFound, parse, tooMany } from '../lib/errors';
import { ffmpegAvailable } from '../services/note-media';

const MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_DEADLINE_MS = 10_000;

async function readRecording(request: FastifyRequest): Promise<{ audio: Buffer; mimeType: string }> {
  if (!request.isMultipart()) throw badRequest('Send one recording as multipart/form-data.');
  let recording: { audio: Buffer; mimeType: string } | undefined;
  // D233: an absolute deadline covers both the first multipart boundary and the final bytes.
  // Destroying the incoming request also tears down the parser and any open part stream.
  const timer = setTimeout(() => request.raw.destroy(), UPLOAD_DEADLINE_MS).unref();
  try {
    for await (const part of request.files({ limits: { fileSize: MAX_BYTES } })) {
      const audio = await part.toBuffer();
      if (part.fieldname !== 'file' || audio.length === 0) throw badRequest('Send one recording in the file field.');
      recording = { audio, mimeType: part.mimetype.toLowerCase() };
    }
  } finally {
    clearTimeout(timer);
  }
  if (!recording) throw badRequest('No recording was sent.');
  return recording;
}

function requireBudget(ctx: AppContext, clubId: string): void {
  const spent = calBudgetSpent(ctx.db, clubId, { club: ctx.config.CAL_MONTHLY_SPEND_CAP_USD, instance: ctx.config.CAL_INSTANCE_MONTHLY_SPEND_CAP_USD });
  if (spent === 'club') throw new HttpError(402, 'spend_cap', 'This club has reached its Cal budget for this month.');
  if (spent === 'instance') throw new HttpError(402, 'spend_cap', "Cal has reached this month's budget for every club here.");
}

/** D233: turn a member's recording into an editable draft, with no conversation or saved clip. */
export function dictationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const stt = sttProviderFor(ctx.config);
  const limiter = voiceRateLimiterFor(ctx);
  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/dictation', {
    onError: async (request, reply) => {
      // A refusal can happen before the body is read or halfway through multipart parsing.
      if (!request.raw.complete) void reply.header('Connection', 'close');
    },
  }, async (request, reply) => {
    void reply.header('Cache-Control', 'private, no-store');
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    if (!stt) throw notFound('Dictation is unavailable on this server.');
    if (!ffmpegAvailable()) throw new HttpError(503, 'unavailable', 'Dictation is unavailable on this server.');
    if (!limiter.attempt(user.id)) throw tooMany('Too many voice requests. Try again in a minute.');
    requireBudget(ctx, clubId);

    const disconnected = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) disconnected.abort();
    });
    const recording = await readRecording(request).catch((err: unknown) => {
      if (request.raw.destroyed && !request.raw.complete) return null;
      throw err;
    });
    if (!recording || disconnected.signal.aborted) return reply;
    const decoded = await decodeDictationAudio(recording.audio, recording.mimeType, disconnected.signal).catch((err: unknown) => {
      if (disconnected.signal.aborted) return null;
      if (err instanceof HttpError && err.code === 'decoder_busy') void reply.header('Retry-After', '5');
      throw err;
    });
    if (!decoded || disconnected.signal.aborted) return reply;
    requireBudget(ctx, clubId);

    try {
      const text = await transcribeAndLog(ctx, { clubId, userId: user.id }, stt, decoded.audio, 'audio/wav', {
        durationSeconds: decoded.durationSeconds,
        // A clip already sent to the provider may incur a charge after the client leaves.
        // Let the call settle under its deadline so a successful result is still logged.
        signal: AbortSignal.timeout(20_000),
      });
      return disconnected.signal.aborted ? reply : { text: text.trim() };
    } catch {
      if (disconnected.signal.aborted) return reply;
      request.log.warn({ provider: stt.name }, 'dictation transcription failed');
      throw new HttpError(502, 'transcription_failed', 'Could not transcribe that recording. Try again.');
    }
  });
}
