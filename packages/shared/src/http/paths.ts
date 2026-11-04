/**
 * Whether a value is a path of this app, safe to send someone to after signing in: one leading
 * slash, then no slash or backslash, and no whitespace or control characters anywhere (browsers
 * drop tabs and newlines and read `\` as `/`, so `/\evil.example` would be another site).
 */
export function isAppPath(path: string | null | undefined): path is string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  return !!path && path.length <= 2000 && /^\/(?![/\\])/.test(path) && !/[\s\u0000-\u001f\u007f\\]/.test(path);
}

/**
 * The same-app path to go to for a `next` value, written as the URL parser reads it (dot segments
 * resolved, characters beyond ASCII percent-encoded), or null. The check is made again on that
 * form: `/..//evil.example` passes the first look, then resolves to `//evil.example`, another site.
 */
export function appPath(path: string | null | undefined): string | null {
  if (!isAppPath(path)) return null;
  const base = 'http://app.invalid';
  const url = new URL(path, base);
  const resolved = `${url.pathname}${url.search}${url.hash}`;
  return url.origin === base && isAppPath(resolved) ? resolved : null;
}
