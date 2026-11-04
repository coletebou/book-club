import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { contentRangeHeader, parseRangeHeader, unsatisfiedRangeHeader } from '@bookclub/shared';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { MIN_COMPRESS_BYTES, compressedCopy, isCompressible, preferredEncoding } from './compress';
import { notFound } from './errors';

export interface SendFileOptions {
  readonly path: string;
  readonly contentType: string;
  /** Strong validator, e.g. the content hash; by default one made of the file's size and mtime. */
  readonly etag?: string;
  readonly cacheControl: string;
  readonly headers?: Record<string, string>;
}

/**
 * The body of a HEAD reply. Fastify's automatic HEAD route sets `Content-Length: 0` when a reply
 * has no payload; given an (empty) stream it drains it and keeps the length sendFile set.
 */
const headBody = () => Readable.from([]);

/**
 * Send a file with byte-range support (RFC 9110): `Accept-Ranges`, `206` + `Content-Range` for a
 * single range, `416` for an unsatisfiable one, `If-Range` and `If-None-Match`. Media elements
 * cannot seek without this (v1 lesson). Text-like files go brotli- or gzip-compressed to clients
 * that accept it (from a copy kept next to the file); a range request always gets the file as it
 * is, because byte ranges address the file itself.
 */
export async function sendFile(request: FastifyRequest, reply: FastifyReply, options: SendFileOptions): Promise<FastifyReply> {
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = await stat(options.path));
  } catch {
    throw notFound();
  }
  const tag = options.etag ?? `${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}`;
  reply.header('Content-Type', options.contentType);
  reply.header('Cache-Control', options.cacheControl);
  reply.header('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(options.headers ?? {})) reply.header(k, v);

  if (size >= MIN_COMPRESS_BYTES && isCompressible(options.contentType)) {
    reply.header('Vary', 'Accept-Encoding');
    const encoding = request.headers.range ? null : preferredEncoding(request.headers['accept-encoding']);
    const copy = encoding ? await compressedCopy(options.path, encoding) : null;
    if (encoding && copy && copy.size < size) {
      const etag = `"${tag}-${encoding === 'br' ? 'br' : 'gz'}"`;
      reply.header('ETag', etag);
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      reply.code(200);
      reply.header('Content-Encoding', encoding);
      reply.header('Content-Length', String(copy.size));
      if (request.method === 'HEAD') return reply.send(headBody());
      return reply.send(createReadStream(copy.path));
    }
  }

  const etag = `"${tag}"`;
  reply.header('Accept-Ranges', 'bytes');
  reply.header('ETag', etag);
  if (request.headers['if-none-match'] === etag && !request.headers.range) {
    return reply.code(304).send();
  }

  let rangeHeader = request.headers.range;
  const ifRange = request.headers['if-range'];
  if (rangeHeader && ifRange && ifRange !== etag) rangeHeader = undefined;
  const range = parseRangeHeader(rangeHeader, size);

  if (range.type === 'unsatisfiable') {
    reply.header('Content-Range', unsatisfiedRangeHeader(size));
    return reply.code(416).send();
  }
  if (range.type === 'range') {
    const length = range.end - range.start + 1;
    reply.code(206);
    reply.header('Content-Range', contentRangeHeader(range.start, range.end, size));
    reply.header('Content-Length', String(length));
    if (request.method === 'HEAD') return reply.send(headBody());
    return reply.send(createReadStream(options.path, { start: range.start, end: range.end }));
  }
  reply.code(200);
  reply.header('Content-Length', String(size));
  if (request.method === 'HEAD') return reply.send(headBody());
  if (size === 0) return reply.send();
  return reply.send(createReadStream(options.path));
}
