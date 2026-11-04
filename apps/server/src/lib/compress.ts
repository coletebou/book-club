import { randomBytes } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

export type Encoding = 'br' | 'gzip';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Below this, compressing saves less than a packet. */
export const MIN_COMPRESS_BYTES = 1024;

/** The file suffix of a precompressed copy, as nginx's gzip_static and the web build write them. */
export const ENCODING_SUFFIX: Record<Encoding, string> = { br: '.br', gzip: '.gz' };

/** Text-like media types worth compressing; images, audio, PDFs and archives already are. */
export function isCompressible(contentType: string): boolean {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/javascript' ||
    type === 'application/wasm' ||
    type === 'image/svg+xml' ||
    type.endsWith('+xml') ||
    type.endsWith('+json')
  );
}

/** The best encoding the client accepts (RFC 9110 §12.5.3): brotli, then gzip, else none. */
export function preferredEncoding(acceptEncoding: string | undefined): Encoding | null {
  if (!acceptEncoding) return null;
  const quality = new Map<string, number>();
  for (const part of acceptEncoding.toLowerCase().split(',')) {
    const [name = '', ...params] = part.split(';').map((s) => s.trim());
    if (!name) continue;
    const q = params.find((p) => p.startsWith('q='));
    quality.set(name, q ? Number(q.slice(2)) : 1);
  }
  const accepts = (name: string) => (quality.get(name) ?? quality.get('*') ?? 0) > 0;
  if (accepts('br')) return 'br';
  if (accepts('gzip')) return 'gzip';
  return null;
}

export async function compressBytes(data: Buffer | string, encoding: Encoding, effort: 'fast' | 'best' = 'fast'): Promise<Buffer> {
  if (encoding === 'br') {
    const quality = effort === 'best' ? 9 : 5;
    return brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  }
  return gzip(data, { level: effort === 'best' ? 9 : 6 });
}

const inflight = new Map<string, Promise<string | null>>();

/**
 * A compressed copy of `file` stored next to it (`file.br`, `file.gz`). Copies the web build
 * wrote are used as they are; otherwise one is made on first use and kept, so each immutable
 * file is compressed once. Returns null when no current copy exists and none can be written
 * (a read-only directory): the caller then sends the file as it is.
 */
export async function compressedCopy(file: string, encoding: Encoding): Promise<{ path: string; size: number } | null> {
  const copy = file + ENCODING_SUFFIX[encoding];
  const [original, existing] = await Promise.all([stat(file), stat(copy).catch(() => null)]);
  if (existing && existing.mtimeMs >= original.mtimeMs) return { path: copy, size: existing.size };
  let pending = inflight.get(copy);
  if (!pending) {
    pending = writeCopy(file, copy, encoding).finally(() => inflight.delete(copy));
    inflight.set(copy, pending);
  }
  const made = await pending;
  if (!made) return null;
  return { path: made, size: (await stat(made)).size };
}

async function writeCopy(file: string, copy: string, encoding: Encoding): Promise<string | null> {
  const tmp = `${copy}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const data = await compressBytes(await readFile(file), encoding, 'best');
    await writeFile(tmp, data);
    await rename(tmp, copy);
    return copy;
  } catch {
    await unlink(tmp).catch(() => undefined);
    return null;
  }
}
