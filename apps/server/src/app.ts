import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { LIMITS } from '@bookclub/shared';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { registerAuth } from './auth/plugin';
import { proxyKeyGuard } from './auth/proxy-key';
import { calRoutes } from './routes/cal';
import { calVoiceRoutes } from './routes/cal-voice';
import { resumeCalIndexing } from './cal/indexer';
import { resumeShelfIndexing } from './cal/shelf';
import { closeVectorSearchPool } from './cal/vector-search';
import { type Config } from './config';
import { type AppContext } from './context';
import { type Db, openDb } from './db/db';
import { resumeIngest } from './ingest/pipeline';
import { realignOldReadAlongs, resumeTranscriptions, stopTranscriptions } from './services/readalong';
import { MIN_COMPRESS_BYTES, compressBytes, preferredEncoding } from './lib/compress';
import { setScryptCost } from './lib/crypto';
import { HttpError, ZodError, zodFields } from './lib/errors';
import { Hub } from './realtime/hub';
import { PartyManager } from './realtime/party';
import { removeOrphanBlobs } from './repos/blobs';
import { purgeExpiredSessions } from './repos/sessions';
import { removeOrphanNoteMedia } from './services/note-media-cleanup';
import { authRoutes } from './routes/auth';
import { bookRoutes } from './routes/books';
import { chatRoutes } from './routes/chat';
import { clubRoutes } from './routes/clubs';
import { cleanUpUploads, createTus, importRoutes } from './routes/imports';
import { listeningRoutes } from './routes/listening';
import { livekitRoutes } from './routes/livekit';
import { livekitWebhookRoutes } from './routes/livekit-webhook';
import { mediaRoutes } from './routes/media';
import { noteMediaRoutes } from './routes/note-media';
import { nominationRoutes } from './routes/nominations';
import { partyRoutes } from './routes/party';
import { pushRoutes } from './routes/push';
import { readingRoutes } from './routes/reading';
import { readAlongRoutes } from './routes/readalong';
import { notificationRoutes } from './routes/notifications';
import { historyRoutes } from './routes/history';
import { widgetRoutes } from './routes/widget';
import { staticRoutes } from './routes/static';
import { wsRoutes } from './routes/ws';
import { createApnsClient } from './push/apns';
import { Jobs } from './services/jobs';
import { Storage } from './storage/storage';

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly ctx: AppContext;
  readonly close: () => Promise<void>;
}

export interface BuildOptions {
  readonly config: Config;
  readonly logger?: FastifyServerOptions['logger'];
  /** Re-queue interrupted ingest jobs and start periodic housekeeping (off in unit tests). */
  readonly background?: boolean;
}

/**
 * `camera=(self), microphone=(self)`: this app's own pages, never a framed page of someone else's
 * (an EPUB document, sandboxed with its own CSP besides, routes/media.ts). Media notes (D140) need
 * both for voice recording and photo/video capture; voice channels and listening together (D153)
 * and talking to Cal (D167) need the microphone. A browser enforces Permissions-Policy ahead of any
 * getUserMedia prompt, so `()` here made every recording and every "Join voice" fail silently,
 * with no error from MediaRecorder or LiveKit's client at all (as this app's own CSP once did too:
 * see appCsp, routes/static.ts). It stays on whether or not LiveKit is configured: media notes and
 * Cal's voice need it either way.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
};

/**
 * Where a secret travels in an address: an invite code after `/join/` (the web app's page) or
 * `/invites/` (`/api/invites/:code`), a password reset token after `/reset/` (the web app's page).
 * The slashes may be percent-encoded, once or more, as in a `next` that carries one of those pages
 * (`/signin?next=%2Fjoin%2F…`, `/api/auth/upstream?next=…`).
 */
const SECRET_IN_URL = /((?:\/|%(?:25)*2f)(?:join|invites|reset)(?:\/|%(?:25)*2f))[^/?#&]+/gi;

/** The upstream's one-time code, and the state it comes back with, on the way back from it (D116). */
const UPSTREAM_CALLBACK = /^\/api\/auth\/upstream\/callback\?/i;
const GRANT_IN_QUERY = /([?&](?:code|state)=)[^&#]*/gi;

/** An address as the log keeps it: with every invite code, reset token and upstream code in it cut out. */
export function redactUrl(url: string): string {
  const cut = url.replace(SECRET_IN_URL, '$1[redacted]');
  return UPSTREAM_CALLBACK.test(cut) ? cut.replace(GRANT_IN_QUERY, '$1[redacted]') : cut;
}

/** A request in the log: its method, its address (redacted), the host it asked for and who asked. */
function requestForLog(request: FastifyRequest) {
  return { method: request.method, url: redactUrl(request.url), host: request.host, remoteAddress: request.ip, remotePort: request.socket?.remotePort };
}

export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const { config } = options;
  setScryptCost(config.SCRYPT_LOG_N);
  const storage = new Storage(config.dataDir);
  await storage.init();
  const db: Db = openDb(storage.dbFile);

  const app = Fastify({
    // Whichever logger is asked for, requests are written to it by requestForLog.
    logger:
      options.logger === false
        ? false
        : { level: config.LOG_LEVEL, ...(typeof options.logger === 'object' ? options.logger : {}), serializers: { req: requestForLog } },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    // A request must have come in whole within ten minutes (Fastify's default is never, so one that
    // sent a byte and waited held its connection for good). An upload chunk of 8 MiB (the web app's
    // uploader.ts) takes 67 s at 1 Mbit/s, which leaves it minutes. The clock is on receiving the
    // request, not answering it: media streamed for hours, and WebSockets, are not cut. Transcripts
    // have a tighter deadline of their own (READ_ALONG_LIMITS.upload).
    requestTimeout: 10 * 60_000,
    // Shut down promptly: do not wait out idle keep-alive connections.
    forceCloseConnections: true,
  });
  // Ahead of Fastify on every request and WebSocket upgrade: forwarded headers count only from the
  // proxy that holds the key, when there is one (TRUST_PROXY_KEY).
  if (config.TRUST_PROXY_KEY) {
    const guard = proxyKeyGuard(config.TRUST_PROXY_KEY);
    app.server.prependListener('request', guard);
    app.server.prependListener('upgrade', guard);
  }
  const hub = new Hub(db, app.log);
  // Built after the hub so it can broadcast through it (publish/sendToUser); the hub only needs
  // it back to route one ws message ('party:speaking') to it, wired below with setParties.
  const parties = new PartyManager(hub, app.log);
  hub.setParties(parties);
  // Unlike the hub's heartbeat (dead-connection detection, skipped in tests), the auto-resume
  // countdown is product correctness: it runs in every mode, including `background: false`.
  parties.start();
  const jobs = new Jobs(app.log);
  const slowJobs = new Jobs(app.log);
  const calJobs = new Jobs(app.log);
  const push = config.apns ? createApnsClient(config.apns) : null;
  const ctx: AppContext = { config, db, storage, hub, parties, jobs, slowJobs, calJobs, push, log: app.log };

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  // Note media (D140): streamed straight to disk by busboy, never buffered whole by Fastify's own
  // body parser (whose bodyLimit above is for JSON bodies); one file per request, the largest a
  // video allows, since the exact per-kind cap (voice, photo) is checked once its kind is known.
  await app.register(multipart, { limits: { fileSize: LIMITS.videoNoteBytes, files: 1, fields: 0 } });
  // LiveKit signs its webhook body and posts it as this content type (routes/livekit-webhook.ts);
  // the raw string, not a re-serialised copy, is what its signature was computed over.
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  registerAuth(app, ctx);

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    if (request.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    if (!reply.hasHeader('Cross-Origin-Resource-Policy')) reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    return payload;
  });
  // JSON answers of a kilobyte or more go compressed (files are compressed by sendFile).
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string' || payload.length < MIN_COMPRESS_BYTES || reply.hasHeader('Content-Encoding')) return payload;
    if (!String(reply.getHeader('Content-Type') ?? '').startsWith('application/json')) return payload;
    reply.header('Vary', 'Accept-Encoding');
    const encoding = preferredEncoding(request.headers['accept-encoding']);
    if (!encoding) return payload;
    reply.header('Content-Encoding', encoding);
    reply.removeHeader('Content-Length');
    return compressBytes(payload, encoding);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid request.', fields: zodFields(error) } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'bad_request', message: (error as Error).message } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: `No route for ${request.method} ${request.url.split('?')[0]}` } }),
  );

  app.get('/healthz', async () => ({ ok: true }));

  const tus = createTus(ctx);
  authRoutes(app, ctx);
  clubRoutes(app, ctx);
  bookRoutes(app, ctx);
  nominationRoutes(app, ctx);
  importRoutes(app, ctx, tus);
  readingRoutes(app, ctx);
  listeningRoutes(app, ctx);
  readAlongRoutes(app, ctx);
  notificationRoutes(app, ctx);
  historyRoutes(app, ctx);
  widgetRoutes(app, ctx);
  chatRoutes(app, ctx);
  livekitRoutes(app, ctx);
  livekitWebhookRoutes(app, ctx);
  partyRoutes(app, ctx, parties);
  mediaRoutes(app, ctx);
  noteMediaRoutes(app, ctx);
  pushRoutes(app, ctx);
  wsRoutes(app, ctx);
  calRoutes(app, ctx);
  calVoiceRoutes(app, ctx);
  if (config.WEB_DIST) staticRoutes(app, ctx);

  const timers: NodeJS.Timeout[] = [];
  if (options.background !== false) {
    hub.start();
    resumeIngest(ctx);
    resumeTranscriptions(ctx);
    realignOldReadAlongs(ctx);
    resumeCalIndexing(ctx);
    resumeShelfIndexing(ctx);
    const housekeeping = () => {
      purgeExpiredSessions(db);
      void cleanUpUploads(ctx, tus);
      void removeOrphanBlobs(ctx);
      void removeOrphanNoteMedia(ctx);
    };
    const t = setInterval(housekeeping, 3600_000);
    t.unref();
    timers.push(t);
  }

  return {
    app,
    ctx,
    close: async () => {
      for (const t of timers) clearInterval(t);
      hub.stop();
      parties.stop();
      // First, so that nothing a last request or ingest queues starts a recogniser: the one
      // running stops, those queued are left for the next start, and their queue empties at once.
      stopTranscriptions(ctx);
      await app.close();
      await jobs.idle();
      await slowJobs.idle();
      await calJobs.idle();
      await closeVectorSearchPool();
      push?.close();
      db.close();
    },
  };
}
