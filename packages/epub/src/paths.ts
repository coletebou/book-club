/**
 * Paths inside an EPUB container. Every href is resolved against the document it appears in and
 * compared as a normalised absolute container path, never as a raw string: TOC entries are
 * relative to the nav document, spine items to the OPF, and the two often live in different
 * folders (v1 broke on exactly that).
 */

export class UnsafePathError extends Error {
  override name = 'UnsafePathError';
}

function safeDecode(segment: string): string {
  // Without a percent sign there is nothing to decode (the decoder would return it unchanged).
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Normalise a container path: decode percent-escapes, collapse `.` and `..`, use `/`.
 * Throws for paths that escape the container root or contain control characters.
 */
export function normalizePath(path: string): string {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\0-\x1f]/.test(path)) throw new UnsafePathError(`control character in path: ${JSON.stringify(path)}`);
  const parts = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const raw of parts) {
    const part = safeDecode(raw);
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) throw new UnsafePathError(`path escapes the container: ${path}`);
      out.pop();
      continue;
    }
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[\0-\x1f]/.test(part) || part.includes('/')) throw new UnsafePathError(`unsafe path segment in ${path}`);
    out.push(part);
  }
  return out.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export interface SplitHref {
  readonly path: string;
  readonly fragment: string | null;
}

/** Whether an href points outside the publication (a URL with a scheme, or protocol-relative). */
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href.trim()) || href.trim().startsWith('//');
}

/**
 * Resolve `href` (as written in `fromDocument`) to a container path and fragment.
 * Returns null for external URLs.
 */
export function resolveHref(fromDocument: string, href: string): SplitHref | null {
  const trimmed = href.trim();
  if (isExternalHref(trimmed)) return null;
  const hashAt = trimmed.indexOf('#');
  const rawPath = hashAt === -1 ? trimmed : trimmed.slice(0, hashAt);
  const fragment = hashAt === -1 ? null : safeDecode(trimmed.slice(hashAt + 1)) || null;
  const withoutQuery = rawPath.split('?')[0]!;
  if (withoutQuery === '') return { path: normalizePath(fromDocument), fragment };
  const base = withoutQuery.startsWith('/') ? '' : dirname(fromDocument);
  return { path: normalizePath(base === '' ? withoutQuery : `${base}/${withoutQuery}`), fragment };
}

/** A relative href from one container document to another path (used when rewriting links). */
export function relativeHref(fromDocument: string, toPath: string): string {
  const from = dirname(fromDocument).split('/').filter(Boolean);
  const to = toPath.split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => '..');
  return [...up, ...to.slice(i)].map((p) => (p === '..' ? p : encodeURIComponent(p))).join('/');
}

/**
 * Case-insensitive lookup in paths that no longer change: some EPUBs reference `Images/A.JPG`
 * while the zip holds `images/a.jpg` (Windows-made books). Exact matches always win; otherwise the
 * first path, in order, that differs only in case. The lower-case index is built once, at the
 * first lookup that is not an exact match, so a book naming thousands of files it does not hold
 * costs one pass over its paths, not one for each.
 */
export function pathFinder(paths: ReadonlySet<string> | ReadonlyMap<string, unknown>): (wanted: string) => string | null {
  let byLowerCase: Map<string, string> | null = null;
  return (wanted) => {
    if (paths.has(wanted)) return wanted;
    if (!byLowerCase) {
      byLowerCase = new Map();
      for (const p of paths.keys()) {
        const lower = p.toLowerCase();
        if (!byLowerCase.has(lower)) byLowerCase.set(lower, p);
      }
    }
    return byLowerCase.get(wanted.toLowerCase()) ?? null;
  };
}
