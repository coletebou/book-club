import { type ClubSearchResponse, type ClubSearchResult, type Chapter, ClubSearchBodySchema, IdSchema, chapterEnd, chapterHeading, chapterNames, rangesCover } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireMember } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { RateLimiter } from '../auth/ratelimit';
import { type AppContext } from '../context';
import { parse, tooMany } from '../lib/errors';
import { type BookRow, bookChapters, booksForClub, editionsForBook } from '../repos/books';
import { chatSearchCandidates } from '../repos/chat';
import { noteSearchCandidates } from '../repos/comments';
import { readingOf } from '../repos/progress';
import { ChatViews, toChatView } from '../services/chat';
import { gateFor } from '../services/gating';

const HITS_PER_KIND = 8;

const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ');
const searchText = (text: string) => oneLine(text).toLowerCase();

function excerpt(text: string | null, query: string): string | null {
  const line = oneLine(text ?? '');
  const folded = line.toLowerCase();
  const match = folded.indexOf(query);
  if (match < 0) return null;
  let offset = match;
  // Lowercasing can expand a character (for example İ). Slice at an offset in the original.
  if (folded.length !== line.length) {
    let foldedOffset = 0;
    offset = 0;
    for (const char of line) {
      foldedOffset += char.toLowerCase().length;
      if (foldedOffset > match) break;
      offset += char.length;
    }
  }
  const start = Math.max(0, offset - 42);
  const end = Math.min(line.length, start + 168);
  return `${start ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

function bookHref(bookId: string): string {
  return `/books/${encodeURIComponent(bookId)}`;
}

function locationHrefs(ctx: AppContext, book: BookRow) {
  const editions = editionsForBook(ctx.db, book.id).filter((edition) => edition.status === 'ready');
  const preferred = editions.find((edition) => edition.kind !== 'audio') ?? editions[0];
  return (t: number, comment?: { id: string; editionId: string }) => {
    const edition = (comment && editions.find((candidate) => candidate.id === comment.editionId)) || preferred;
    if (!edition) return bookHref(book.id);
    const params = new URLSearchParams({ edition: edition.id, at: t.toFixed(6) });
    if (comment) params.set('comment', comment.id);
    return `${bookHref(book.id)}/${edition.kind === 'audio' ? 'listen' : 'read'}?${params}`;
  };
}

function matchingChapters(chapters: readonly Chapter[], query: string) {
  const names = chapterNames(chapters);
  return chapters.flatMap((chapter, index) => {
    const title = chapterHeading(chapter.title);
    if (!searchText(title).includes(query) && !searchText(names[index]!).includes(query)) return [];
    return [{ title, chapter, end: chapterEnd(chapters, index) }];
  });
}

/** Only open messages count toward the result limit. Hidden matches cannot displace an open one. */
function chatHits(ctx: AppContext, clubId: string, userId: string, query: string): ClubSearchResult[] {
  const views = new ChatViews(ctx, userId);
  const hits: ClubSearchResult[] = [];
  for (const row of chatSearchCandidates(ctx.db, clubId, query, userId)) {
    const view = toChatView(row, views.gate(row.book_id), userId, []);
    if (view.hidden) continue;
    const match = excerpt(view.text, query);
    if (!match) continue;
    hits.push({ kind: 'chat', id: row.id, title: match, detail: view.author.displayName, href: `/clubs/${encodeURIComponent(clubId)}/chat?message=${encodeURIComponent(row.id)}` });
    if (hits.length === HITS_PER_KIND) break;
  }
  return hits;
}

/** D251: search only what this club member can already open through the source's own gate. */
export function searchRoutes(app: FastifyInstance, ctx: AppContext): void {
  ctx.db.raw.function('bookclub_search_text', { deterministic: true }, (value) => typeof value === 'string' ? searchText(value) : '');
  const memberLimit = new RateLimiter(20, 60_000);
  const clubLimit = new RateLimiter(80, 60_000);
  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/search', async (request, reply): Promise<ClubSearchResponse> => {
    reply.header('Cache-Control', 'private, no-store');
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    const { query } = parse(ClubSearchBodySchema, request.body);
    const now = Date.now();
    if (memberLimit.blocked(user.id, now) || clubLimit.blocked(clubId, now)) throw tooMany('Too many searches. Try again in a minute.');
    memberLimit.record(user.id, now);
    clubLimit.record(clubId, now);
    const needle = searchText(query);
    const books: ClubSearchResult[] = [];
    const chapters: ClubSearchResult[] = [];
    const notes: ClubSearchResult[] = [];

    for (const book of booksForClub(ctx.db, clubId)) {
      if (books.length < HITS_PER_KIND && searchText(`${book.title} ${book.author}`).includes(needle)) {
        books.push({ kind: 'book', id: book.id, title: book.title, detail: book.author, href: bookHref(book.id) });
      }
      const chapterMatches = chapters.length < HITS_PER_KIND ? matchingChapters(bookChapters(book), needle) : [];
      let gate: ReturnType<typeof gateFor> | undefined;
      let reading: ReturnType<typeof readingOf> | undefined;
      let href: ReturnType<typeof locationHrefs> | undefined;
      if (chapterMatches.length > 0) {
        gate = gateFor(ctx.db, book);
        reading = readingOf(ctx.db, user.id, book.id);
        const spans = gate.readSpans(reading);
        for (const { title, chapter, end } of chapterMatches) {
          if (!rangesCover(spans, chapter.t, end)) continue;
          href ??= locationHrefs(ctx, book);
          chapters.push({ kind: 'chapter', id: `${book.id}-${chapter.index}`, title, detail: book.title, href: href(chapter.t) });
          if (chapters.length === HITS_PER_KIND) break;
        }
      }
      if (notes.length >= HITS_PER_KIND) continue;
      for (const note of noteSearchCandidates(ctx.db, book.id, needle, user.id)) {
        gate ??= gateFor(ctx.db, book);
        reading ??= readingOf(ctx.db, user.id, book.id);
        if (!gate.isOpen(note, user.id, reading)) continue;
        const match = excerpt(note.text, needle) ?? excerpt(note.quote, needle);
        if (!match) continue;
        href ??= locationHrefs(ctx, book);
        notes.push({ kind: 'note', id: note.id, title: match, detail: `${book.title} · ${note.author_name}`, href: href(note.t, { id: note.id, editionId: note.edition_id }) });
        if (notes.length === HITS_PER_KIND) break;
      }
    }

    return { results: [...books, ...chapters, ...notes, ...chatHits(ctx, clubId, user.id, needle)] };
  });
}
