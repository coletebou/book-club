/**
 * Where a link into the app goes (D189): a widget's or the Live Activity's tap opens
 * `bookclub:///books/<id>` (the book page) or `bookclub:///` (home). Only those: the scheme is the
 * app's, but anything can open it, so nothing else (Google's sign-in return, `bookclub://auth`, is
 * the browser session's own, D178) is followed into the page.
 */
export function pathOfAppLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'bookclub:' || (parsed.hostname !== '' && parsed.hostname !== 'books')) return null;
  // `bookclub://books/<id>` and `bookclub:///books/<id>` both name a book.
  const path = parsed.hostname === 'books' ? `/books${parsed.pathname}` : parsed.pathname;
  if (path === '/' || path === '') return '/';
  return /^\/books\/[A-Za-z0-9_-]{6,64}$/.test(path) ? path : null;
}
