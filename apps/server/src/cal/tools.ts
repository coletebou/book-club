import { chapterNameAt, formatPercent } from '@bookclub/shared';
import { type AppContext } from '../context';
import { type BookRow, bookById, bookChapters, booksForClub } from '../repos/books';
import { members } from '../repos/clubs';
import { progressFor } from '../repos/progress';
import { type EmbeddingsProvider } from './embeddings';
import { CalGate } from './gating';
import { hybridSearch } from './search';
import { type BookScope, chunkById, chunkNeighbors, inScope } from './store';
import { type SearchHit } from './types';

/** A tool call's turn-scoped context: who is asking, in which club, and whether the spoiler gate is lifted. */
export interface ToolContext {
  readonly ctx: AppContext;
  readonly embeddings: EmbeddingsProvider | null;
  readonly clubId: string;
  readonly userId: string;
  readonly wholeSeries: boolean;
  /** Which of the club's books this turn may draw on (D204: in the club's chat, the channel's own book, or none); null, all of them. */
  readonly books: BookScope;
  /** Every chunk id offered to the model this turn, across every tool call — citations outside this set are dropped (defense in depth, D162). */
  readonly offeredChunkIds: Set<string>;
}

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/** Cal's own tools (search_library, get_passage, whats_my_place). web_search is Anthropic's server-side tool, declared separately in anthropic.ts. */
export const CAL_TOOLS: ToolDef[] = [
  {
    name: 'search_library',
    description:
      "Hybrid (full-text + semantic) search over this club's indexed books and Cal's shelf (material members fed Cal beyond the club's books). " +
      'Results are already spoiler-filtered to what the asker has read; a book they have not reached in its series is left out entirely unless ' +
      'they turned on "whole series" in Cal\'s settings. Cite a result you use with [[cite:CHUNK_ID]] right after the sentence that uses it.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, in natural language.' },
        limit: { type: 'integer', minimum: 1, maximum: 12, description: 'How many results at most (default 6).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_passage',
    description: "A search result's neighbouring text (the paragraphs just before and after it), for more context around a passage you already found.",
    input_schema: {
      type: 'object',
      properties: {
        chunkId: { type: 'string', description: 'A chunk id from an earlier search_library result.' },
        before: { type: 'integer', minimum: 0, maximum: 5, description: 'Chunks of context before (default 1).' },
        after: { type: 'integer', minimum: 0, maximum: 5, description: 'Chunks of context after (default 1).' },
      },
      required: ['chunkId'],
      additionalProperties: false,
    },
  },
  {
    name: 'whats_my_place',
    description:
      "The asker's own reading position, and their club friends' positions (chapter and percentage only — never their notes or reactions), for the " +
      'club\'s books. Use this to answer "where am I", "who else has started this", or to judge how far ahead a question can safely go.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export interface ToolResult {
  readonly text: string;
  readonly hits?: readonly SearchHit[];
}

export async function runTool(tc: ToolContext, name: string, input: unknown): Promise<ToolResult> {
  switch (name) {
    case 'search_library':
      return searchLibraryTool(tc, input as { query?: unknown; limit?: unknown });
    case 'get_passage':
      return getPassageTool(tc, input as { chunkId?: unknown; before?: unknown; after?: unknown });
    case 'whats_my_place':
      return whatsMyPlaceTool(tc);
    default:
      return { text: `Unknown tool: ${name}` };
  }
}

async function searchLibraryTool(tc: ToolContext, input: { query?: unknown; limit?: unknown }): Promise<ToolResult> {
  const query = typeof input.query === 'string' ? input.query.slice(0, 500) : '';
  if (query.trim().length === 0) return { text: 'No query given.' };
  const limit = typeof input.limit === 'number' ? Math.min(12, Math.max(1, Math.floor(input.limit))) : 6;
  const hits = await hybridSearch(tc.ctx.db, tc.embeddings, { clubId: tc.clubId, userId: tc.userId, query, wholeSeries: tc.wholeSeries, limit, books: tc.books });
  for (const h of hits) tc.offeredChunkIds.add(h.chunkId);
  if (hits.length === 0) {
    return { text: 'No results — either nothing matches, or every match is past where the asker has read (spoiler-gated).' };
  }
  const text = hits
    .map((h, i) => {
      const where = h.sourceType === 'book' ? `${h.bookTitle}${h.chapterTitle ? `, ${h.chapterTitle}` : ''}` : `Cal's shelf: ${h.shelfTitle}`;
      return `[${i + 1}] chunk ${h.chunkId} — ${where}\n${h.text}`;
    })
    .join('\n\n');
  return { text, hits };
}

async function getPassageTool(tc: ToolContext, input: { chunkId?: unknown; before?: unknown; after?: unknown }): Promise<ToolResult> {
  const chunkId = typeof input.chunkId === 'string' ? input.chunkId : '';
  const chunk = chunkById(tc.ctx.db, chunkId);
  // Outside this turn's books (D204) is as unavailable as another club's: the id may be guessed.
  if (!chunk || chunk.club_id !== tc.clubId || !inScope(tc.books, chunk)) return { text: 'That chunk is not available.' };
  // Re-verified here, not just trusted from the earlier search: a chunk id's owner may have
  // turned off "whole series" between tool calls in the same turn, or it may not have been this
  // asker's own search result at all (a stale or guessed id).
  if (chunk.source_type === 'book') {
    const book = chunk.book_id ? bookById(tc.ctx.db, chunk.book_id) : undefined;
    const gate = new CalGate(tc.ctx.db, tc.userId, tc.wholeSeries);
    if (!book || !gate.bookIncluded(book) || !gate.chunkReadable(book, chunk)) return { text: 'That passage is not available to you yet.' };
  }
  const before = typeof input.before === 'number' ? Math.min(5, Math.max(0, Math.floor(input.before))) : 1;
  const after = typeof input.after === 'number' ? Math.min(5, Math.max(0, Math.floor(input.after))) : 1;
  const neighbors = chunkNeighbors(tc.ctx.db, chunk, before, after);
  // Neighbours of a book chunk are gated exactly like the chunk itself (they may run past what was read).
  const gate = chunk.source_type === 'book' ? new CalGate(tc.ctx.db, tc.userId, tc.wholeSeries) : null;
  const book = chunk.source_type === 'book' && chunk.book_id ? bookById(tc.ctx.db, chunk.book_id) : undefined;
  const visible = neighbors.filter((n) => !gate || !book || gate.chunkReadable(book, n));
  for (const n of visible) tc.offeredChunkIds.add(n.id);
  const text = visible.map((n) => `chunk ${n.id}${n.chapter_title ? ` (${n.chapter_title})` : ''}:\n${n.text}`).join('\n\n');
  return { text: text || 'Nothing more is available around that passage yet.' };
}

/** A position as whats_my_place reports it: a chapter name/percent, never a comment or a quote. */
function placeLabel(book: BookRow, t: number): string {
  const chapters = bookChapters(book);
  return chapterNameAt(chapters, t) ?? `before ${formatPercent(t)}`;
}

async function whatsMyPlaceTool(tc: ToolContext): Promise<ToolResult> {
  const books = booksForClub(tc.ctx.db, tc.clubId);
  const clubMembers = members(tc.ctx.db, tc.clubId);
  const lines: string[] = [];
  for (const book of books) {
    const rows: string[] = [];
    for (const m of clubMembers) {
      const progress = progressFor(tc.ctx.db, m.userId, book.id);
      if (!progress) continue;
      const who = m.userId === tc.userId ? 'The asker' : m.displayName;
      const status = progress.finished_at !== null ? 'finished it' : placeLabel(book, progress.t);
      rows.push(`${who}: ${status}`);
    }
    if (rows.length > 0) lines.push(`${book.title}:\n  ${rows.join('\n  ')}`);
  }
  return { text: lines.length > 0 ? lines.join('\n\n') : 'Nobody in this club has started any of its books yet.' };
}
