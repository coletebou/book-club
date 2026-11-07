import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { type AppContext } from '../context';
import { compressBytes, MIN_COMPRESS_BYTES, preferredEncoding } from '../lib/compress';
import { sendFile } from '../lib/send';
import { publicOrigin, requestOrigin } from '../auth/plugin';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  // pdf.js's character maps, standard fonts and colour profile (apps/web/pdfjs-resources.ts).
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/vnd.iccprofile',
};

/**
 * LiveKit's own origin, both as the browser's own client connects to it (D153): its websocket
 * (`wss`/`ws`, the signalling connection itself) and the plain `https`/`http` of the same host
 * (the preflight `GET .../rtc/v1/validate` its client library also makes). Without both, LiveKit
 * is reachable (a token mints fine) but every connection is silently blocked by the page's own
 * CSP — a club member sees "Join voice" never actually join, with no error of this app's own.
 */
function liveKitConnectSrc(livekitUrl: string | undefined): string[] {
  if (!livekitUrl) return [];
  const ws = livekitUrl.replace(/^http/, 'ws');
  const http = livekitUrl.replace(/^ws/, 'http');
  return [ws, http];
}

export function appCsp(request: FastifyRequest, livekitUrl?: string): string {
  const origin = requestOrigin(request);
  const ws = origin.replace(/^http/, 'ws');
  const connect = ["'self'", ws, ...liveKitConnectSrc(livekitUrl)].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Serve the built web app. Hashed assets are immutable; the shell and the service worker are
 * revalidated on every load so updates arrive. Unknown paths fall back to index.html (SPA).
 */
export function staticRoutes(app: FastifyInstance, ctx: AppContext): void {
  const root = path.resolve(ctx.config.WEB_DIST);

  const serve = async (request: FastifyRequest, reply: FastifyReply, rel: string) => {
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) return false;
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
    } catch {
      return false;
    }
    // The app shell carries share-card meta (D213: og:image, og:url) that needs an absolute
    // address, which only this request knows (PUBLIC_ORIGIN, or else the Host it arrived on).
    // The file is a few KB, so reading and templating it per request costs nothing worth naming.
    // It keeps its own compression (same encodings sendFile below would pick, recompressed each
    // time rather than cached next to the file, since its bytes are no longer the file's own)
    // and loses only the file-based ETag/Range support sendFile gives a file that never changes
    // per request — nothing before this read it conditionally, since it was always `no-cache`.
    if (rel === 'index.html') {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        return false;
      }
      const html = Buffer.from(raw.split('__PUBLIC_ORIGIN__').join(publicOrigin(ctx, request)), 'utf8');
      reply.header('Content-Type', TYPES['.html']!);
      reply.header('Cache-Control', 'no-cache');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', appCsp(request, ctx.config.livekit?.url));
      const encoding = html.byteLength >= MIN_COMPRESS_BYTES ? preferredEncoding(request.headers['accept-encoding']) : null;
      if (encoding) {
        reply.header('Vary', 'Accept-Encoding');
        reply.header('Content-Encoding', encoding);
        await reply.send(await compressBytes(html, encoding));
      } else {
        await reply.send(html);
      }
      return true;
    }
    const ext = path.extname(file).toLowerCase();
    const immutable = rel.startsWith('assets/');
    const headers: Record<string, string> = {};
    if (ext === '.html') headers['Content-Security-Policy'] = appCsp(request, ctx.config.livekit?.url);
    if (rel === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    await sendFile(request, reply, {
      path: file,
      contentType: TYPES[ext] ?? 'application/octet-stream',
      cacheControl: immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      headers,
    });
    return true;
  };

  app.get('/*', async (request, reply) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((request.url.split('?')[0] ?? '/').replace(/^\/+/, ''));
    } catch {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'That address is not valid.' } });
    }
    if (urlPath.startsWith('api/') || urlPath.startsWith('media/') || urlPath === 'ws') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    }
    if (urlPath && (await serve(request, reply, urlPath))) return reply;
    // Missing files with an extension are real 404s; everything else is an app route.
    if (/\.[a-z0-9]{1,8}$/i.test(urlPath)) return reply.code(404).send('Not found');
    await serve(request, reply, 'index.html');
    return reply;
  });
}
