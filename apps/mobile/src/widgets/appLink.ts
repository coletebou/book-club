/**
 * Where a link into the app goes (D189, D220): a widget's or the Live Activity's tap opens
 * `bookclub:///books/<id>` (the book page) or `bookclub:///` (home); a Book Club message tapped in
 * iMessage opens what it is about: `/join/<code>` (an invite), `/clubs/<id>/next` (the club's vote)
 * or a book, at one of its notes (`#note-<id>`). Only those, each the page's own route behind its
 * own sign-in and membership gates: the scheme is the app's, but anything can open it, so nothing
 * else (Google's sign-in return, `bookclub://auth`, is the browser session's own, D178) is
 * followed into the page.
 */
const ID = '[A-Za-z0-9_-]{6,64}';
const ROUTES = [new RegExp(`^/books/${ID}$`), /^\/join\/[A-Za-z0-9_-]{8,64}$/, new RegExp(`^/clubs/${ID}/next$`)];
const NOTE = new RegExp(`^#note-${ID}$`);

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
  if ((path === '/' || path === '') && !parsed.search && !parsed.hash) return '/';
  if (parsed.search || !ROUTES.some((r) => r.test(path))) return null;
  if (!parsed.hash) return path;
  // A note, in a book only: what is shown of it is the page's to decide (the spoiler gate, D9).
  return path.startsWith('/books/') && NOTE.test(parsed.hash) ? `${path}${parsed.hash}` : null;
}
