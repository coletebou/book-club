import { unzipSync } from 'fflate';
import { UnsafePathError, normalizePath } from './paths';

export class EpubError extends Error {
  override name = 'EpubError';
  constructor(
    message: string,
    readonly code: 'not-zip' | 'not-epub' | 'too-large' | 'malformed' | 'encrypted' = 'malformed',
  ) {
    super(message);
  }
}

export interface UnzipLimits {
  /** Maximum total uncompressed size. */
  readonly maxTotalBytes: number;
  /** Maximum number of entries. */
  readonly maxEntries: number;
  /**
   * Maximum compression ratio of any entry larger than 1 MiB, and of the whole archive once it
   * unpacks to more than that (zip bomb guard).
   */
  readonly maxRatio: number;
}

/** Below this, an entry's or the archive's compression is not judged. */
const RATIO_FLOOR = 1024 * 1024;

/**
 * A book's archive unpacked is held in memory while it is read, and the files kept of it once more
 * as they are stored: half a gibibyte is several times the largest illustrated books.
 */
export const DEFAULT_LIMITS: UnzipLimits = {
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
  maxRatio: 200,
};

export type Container = ReadonlyMap<string, Uint8Array>;

export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
}

/**
 * Unzip an EPUB into a map of normalised container paths. Entries with unsafe paths are dropped
 * (never written anywhere), sizes and ratios are bounded before inflating.
 */
export function unzipEpub(bytes: Uint8Array, limits: UnzipLimits = DEFAULT_LIMITS, filter?: (path: string) => boolean): Container {
  if (!looksLikeZip(bytes)) throw new EpubError('This file is not a ZIP archive, so it cannot be an EPUB.', 'not-zip');
  let total = 0;
  let entries = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        entries++;
        if (entries > limits.maxEntries) throw new EpubError('The EPUB has too many files.', 'too-large');
        if (file.name.endsWith('/')) return false;
        let path: string;
        try {
          path = normalizePath(file.name);
        } catch (err) {
          if (err instanceof UnsafePathError) return false;
          throw err;
        }
        if (filter && !filter(path)) return false;
        total += file.originalSize;
        if (total > limits.maxTotalBytes) throw new EpubError('The EPUB is too large once unpacked.', 'too-large');
        if (file.originalSize > RATIO_FLOOR && file.originalSize / Math.max(1, file.size) > limits.maxRatio) {
          throw new EpubError('The EPUB contains a suspiciously compressed file.', 'too-large');
        }
        // Smaller entries are not judged one by one, so the archive is: a thousand of them, each a
        // megabyte of markup from a kilobyte, would keep the parser busy for minutes.
        if (total > RATIO_FLOOR && total / bytes.length > limits.maxRatio) throw new EpubError('The EPUB is suspiciously compressed.', 'too-large');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof EpubError) throw err;
    throw new EpubError(`The EPUB archive is damaged (${(err as Error).message}).`, 'not-zip');
  }
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    const path = normalizePath(name);
    // Real (inflated) size check, in case the central directory lied.
    if (data.byteLength > limits.maxTotalBytes) throw new EpubError('The EPUB is too large once unpacked.', 'too-large');
    out.set(path, data);
  }
  return out;
}

const utf8 = new TextDecoder('utf-8');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

/** Decode a text file, honouring a BOM (some EPUB XHTML is UTF-16). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8.decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le.decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be.decode(bytes.subarray(2));
  return utf8.decode(bytes);
}
