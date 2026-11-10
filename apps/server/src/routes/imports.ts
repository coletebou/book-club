import { type IncomingMessage } from 'node:http';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CreateImportBodySchema, FinalizeImportBodySchema, IdSchema, type Import } from '@bookclub/shared';
import { FileStore } from '@tus/file-store';
import { Server as TusServer } from '@tus/server';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { requireMember } from '../auth/access';
import { requireUser, userFromCookieHeader } from '../auth/plugin';
import { type AppContext } from '../context';
import { assertRoomToStore } from '../services/plans';
import { newId } from '../lib/crypto';
import { badRequest, notFound, parse } from '../lib/errors';
import { isoRequired } from '../lib/json';
import { finalizeImport } from '../ingest/pipeline';
import { membership } from '../repos/clubs';
import {
  type ImportRow,
  createImport,
  createUploadRow,
  declaredFiles,
  deleteUploadRow,
  importById,
  latestUploads,
  markUploadComplete,
  setImportStatus,
  staleImports,
  uploadById,
  uploadsForImport,
} from '../repos/imports';
import { type UserRow } from '../repos/users';

/** Users authenticated by Fastify for the request a tus hook is handling. */
const authed = new WeakMap<IncomingMessage, UserRow>();

/** tus answers a thrown value carrying `status_code` and `body` with that status and text. */
class TusRefusal extends Error {
  readonly status_code: number;
  readonly body: string;
  constructor(status: number, message: string) {
    super(message);
    this.status_code = status;
    this.body = message;
  }
}

function tusError(status: number, message: string): TusRefusal {
  return new TusRefusal(status, message);
}

type TusRequest = Request & { runtime?: { node?: { req?: IncomingMessage } } };

export function createTus(ctx: AppContext): TusServer {
  const userOf = (req: TusRequest): UserRow | null => {
    const raw = req.runtime?.node?.req;
    return (raw && authed.get(raw)) ?? userFromCookieHeader(ctx, req.headers.get('cookie'));
  };
  return new TusServer({
    path: '/api/uploads',
    datastore: new FileStore({
      directory: ctx.storage.uploadsDir,
      expirationPeriodInMilliseconds: ctx.config.UPLOAD_EXPIRY_HOURS * 3600_000,
    }),
    maxSize: ctx.config.MAX_UPLOAD_BYTES,
    relativeLocation: true,
    respectForwardedHeaders: ctx.config.TRUST_PROXY !== false,
    // Same-origin only: no CORS headers at all (tus defaults to `*`).
    allowedOrigins: () => false,
    namingFunction: () => newId(16),
    async onIncomingRequest(req, uploadId) {
      const user = userOf(req as TusRequest);
      if (!user) throw tusError(401, 'Sign in to continue.');
      if (req.method !== 'POST' && uploadId) {
        const row = uploadById(ctx.db, uploadId);
        const imp = row ? importById(ctx.db, row.import_id) : undefined;
        // Yours, for an import still open, in a club you are still in (a removed member's upload
        // stops taking bytes at once, rather than filling the disk it can never be finished on).
        if (!row || row.user_id !== user.id || !imp || imp.status !== 'uploading' || !membership(ctx.db, imp.club_id, user.id)) {
          throw tusError(404, 'Upload not found.');
        }
      }
    },
    async onUploadCreate(req, upload) {
      const user = userOf(req as TusRequest);
      if (!user) throw tusError(401, 'Sign in to continue.');
      const meta = upload.metadata ?? {};
      const imp = meta.importId ? importById(ctx.db, meta.importId) : undefined;
      if (!imp || imp.user_id !== user.id || imp.status !== 'uploading' || !membership(ctx.db, imp.club_id, user.id)) {
        throw tusError(404, 'Upload session not found.');
      }
      const files = declaredFiles(imp);
      const index = Number(meta.fileIndex);
      const declared = Number.isInteger(index) ? files[index] : undefined;
      if (!declared) throw tusError(400, 'Unknown file.');
      if (upload.size === undefined || upload.size !== declared.size) throw tusError(400, `Size of ${declared.name} does not match.`);
      // One upload per file: a file already received is never sent again, and a new attempt
      // replaces an unfinished one (whose client lost track of it) instead of piling up next to it.
      const earlier = uploadsForImport(ctx.db, imp.id).filter((u) => u.file_index === index);
      if (earlier.some((u) => u.completed_at !== null)) throw tusError(409, `${declared.name} is already uploaded.`);
      for (const u of earlier) {
        deleteUploadRow(ctx.db, u.id);
        await rm(path.join(ctx.storage.uploadsDir, u.id), { force: true });
        await rm(path.join(ctx.storage.uploadsDir, `${u.id}.json`), { force: true });
      }
      createUploadRow(ctx.db, { id: upload.id, importId: imp.id, fileIndex: index, userId: user.id, size: upload.size });
      return { metadata: upload.metadata };
    },
    async onUploadFinish(_req, upload) {
      markUploadComplete(ctx.db, upload.id);
      return {};
    },
  });
}

async function offsetOf(ctx: AppContext, uploadId: string, complete: boolean, size: number): Promise<number> {
  if (complete) return size;
  try {
    return (await stat(path.join(ctx.storage.uploadsDir, uploadId))).size;
  } catch {
    return 0;
  }
}

async function importView(ctx: AppContext, imp: ImportRow): Promise<Import> {
  const latest = latestUploads(ctx.db, imp.id);
  const files = await Promise.all(
    declaredFiles(imp).map(async (f, index) => {
      const u = latest.get(index);
      const complete = u?.completed_at != null;
      return {
        index,
        name: f.name,
        size: f.size,
        role: f.role,
        uploadId: u?.id ?? null,
        offset: u ? await offsetOf(ctx, u.id, complete, f.size) : 0,
        complete,
      };
    }),
  );
  return { id: imp.id, clubId: imp.club_id, kind: imp.kind, status: imp.status, files, createdAt: isoRequired(imp.created_at) };
}

function requireImport(ctx: AppContext, importId: string, user: UserRow): ImportRow {
  const imp = importById(ctx.db, importId);
  if (!imp || imp.user_id !== user.id || !membership(ctx.db, imp.club_id, user.id)) throw notFound('Upload session not found.');
  return imp;
}

async function discardUploads(ctx: AppContext, imp: ImportRow): Promise<void> {
  for (const u of uploadsForImport(ctx.db, imp.id)) {
    await rm(path.join(ctx.storage.uploadsDir, u.id), { force: true });
    await rm(path.join(ctx.storage.uploadsDir, `${u.id}.json`), { force: true });
  }
}

export function importRoutes(app: FastifyInstance, ctx: AppContext, tus: TusServer): void {
  app.addContentTypeParser('application/offset+octet-stream', (_request, _payload, done) => done(null));

  const tusHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    authed.set(request.raw, user);
    reply.hijack();
    await tus.handle(request.raw, reply.raw);
  };
  for (const url of ['/api/uploads', '/api/uploads/*']) {
    app.route({ method: ['POST', 'HEAD', 'PATCH', 'DELETE', 'OPTIONS'], url, handler: tusHandler });
  }

  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/imports', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const body = parse(CreateImportBodySchema, request.body);
    const content = body.files.filter((f) => f.role !== 'cover');
    if (body.kind !== 'audio' && content.length !== 1) throw badRequest(`Choose one ${body.kind.toUpperCase()} file.`);
    if (body.kind === 'audio' && content.some((f) => f.role !== 'track')) throw badRequest('Audiobook files must be tracks.');
    if (body.kind !== 'audio' && content.some((f) => f.role !== 'main')) throw badRequest('Ebook files must be the main file.');
    if (body.files.filter((f) => f.role === 'cover').length > 1) throw badRequest('Choose at most one cover image.');
    // Room on the club's plan for all of it (D208), said before a byte is sent; in one transaction
    // with the import, so two uploads at once cannot both take the last of the room.
    const imp = ctx.db.tx(() => {
      assertRoomToStore(ctx, clubId, body.files.reduce((sum, f) => sum + f.size, 0));
      return createImport(ctx.db, { clubId, userId: user.id, kind: body.kind, files: body.files });
    });
    return reply.code(201).send(await importView(ctx, imp));
  });

  app.get<{ Params: { importId: string } }>('/api/imports/:importId', async (request) => {
    const user = requireUser(request);
    return importView(ctx, requireImport(ctx, parse(IdSchema, request.params.importId), user));
  });

  app.post<{ Params: { importId: string } }>('/api/imports/:importId/finalize', async (request, reply) => {
    const user = requireUser(request);
    const imp = requireImport(ctx, parse(IdSchema, request.params.importId), user);
    const body = parse(FinalizeImportBodySchema, request.body);
    const result = await finalizeImport(ctx, user, imp, body);
    return reply.code(201).send(result);
  });

  app.delete<{ Params: { importId: string } }>('/api/imports/:importId', async (request, reply) => {
    const user = requireUser(request);
    const imp = requireImport(ctx, parse(IdSchema, request.params.importId), user);
    if (imp.status === 'uploading') {
      setImportStatus(ctx.db, imp.id, 'cancelled');
      await discardUploads(ctx, imp);
    }
    return reply.code(204).send();
  });
}

/** Delete expired partial uploads and the abandoned import sessions they belonged to. */
export async function cleanUpUploads(ctx: AppContext, tus: TusServer): Promise<void> {
  try {
    await tus.cleanUpExpiredUploads();
  } catch (err) {
    ctx.log.warn({ err }, 'tus cleanup failed');
  }
  const cutoff = Date.now() - ctx.config.UPLOAD_EXPIRY_HOURS * 3600_000;
  for (const imp of staleImports(ctx.db, cutoff)) {
    // One a finish took meanwhile (it committed while earlier ones were being discarded) is its own:
    // its files are on their way into the store.
    if (setImportStatus(ctx.db, imp.id, 'cancelled')) await discardUploads(ctx, imp);
  }
}
