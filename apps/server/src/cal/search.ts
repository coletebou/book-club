import { type Db } from '../db/db';
import { bookById } from '../repos/books';
import { type EmbeddingsProvider } from './embeddings';
import { CalGate } from './gating';
import { chunkById, embeddedChunksForClub, ftsSearch, shelfItemById } from './store';
import { type SearchHit } from './types';
import { vectorSearch } from './vector-search';
import { fuseRanked } from '@bookclub/shared';

export interface SearchOptions {
  readonly clubId: string;
  readonly userId: string;
  readonly query: string;
  readonly wholeSeries: boolean;
  readonly limit?: number;
}

/** How many candidates each half of the hybrid search contributes before fusion and gating. */
const CANDIDATE_LIMIT = 40;

/**
 * Hybrid search over a club's indexed material (D161): full-text (BM25) and vector (cosine, see
 * vector-search.ts) candidate lists, combined by reciprocal rank fusion, then filtered by Cal's
 * spoiler gate (gating.ts, D162) before anything is returned — gating runs on the fused list, not
 * before fusion, since a chunk's own book determines whether it is even a candidate, and that
 * check is cheap next to the search itself; what the asker receives never includes a gated-out
 * chunk's rank, text or existence (D162: a `search_library` tool call cannot reveal that a hidden
 * chunk exists at all).
 */
export async function hybridSearch(db: Db, embeddings: EmbeddingsProvider | null, options: SearchOptions): Promise<SearchHit[]> {
  const limit = options.limit ?? 8;
  const gate = new CalGate(db, options.userId, options.wholeSeries);

  const ftsHits = ftsSearch(db, options.clubId, ftsQuery(options.query), CANDIDATE_LIMIT).map((h) => ({ id: h.id }));

  let vectorHits: { id: string }[] = [];
  if (embeddings) {
    const candidates = embeddedChunksForClub(db, options.clubId, embeddings.name, embeddings.model);
    if (candidates.length > 0) {
      const { vectors } = await embeddings.embed([options.query]);
      const scored = await vectorSearch(vectors[0]!, candidates, CANDIDATE_LIMIT);
      vectorHits = scored.map((s) => ({ id: s.id }));
    }
  }

  const fused = fuseRanked([ftsHits, vectorHits]);
  const scores = new Map(fused.map((id, i) => [id, 1 / (i + 1)]));
  const bookTitles = new Map<string, string>();
  const shelfTitles = new Map<string, string>();
  const hits: SearchHit[] = [];

  for (const id of fused) {
    if (hits.length >= limit) break;
    const chunk = chunkById(db, id);
    if (!chunk || chunk.club_id !== options.clubId) continue;
    if (chunk.source_type === 'book') {
      const book = chunk.book_id ? bookById(db, chunk.book_id) : undefined;
      if (!book || !gate.bookIncluded(book) || !gate.chunkReadable(book, chunk)) continue;
      if (!bookTitles.has(book.id)) bookTitles.set(book.id, book.title);
      hits.push({
        chunkId: chunk.id,
        text: chunk.text,
        sourceType: 'book',
        bookId: book.id,
        bookTitle: book.title,
        editionId: chunk.edition_id,
        shelfItemId: null,
        shelfTitle: null,
        chapterTitle: chunk.chapter_title,
        t: chunk.t_start,
        fusedScore: scores.get(id) ?? 0,
      });
    } else {
      const shelf = chunk.shelf_item_id ? shelfItemById(db, chunk.shelf_item_id) : undefined;
      if (!shelf) continue;
      if (!shelfTitles.has(shelf.id)) shelfTitles.set(shelf.id, shelf.title);
      hits.push({
        chunkId: chunk.id,
        text: chunk.text,
        sourceType: 'shelf',
        bookId: null,
        bookTitle: null,
        editionId: null,
        shelfItemId: shelf.id,
        shelfTitle: shelf.title,
        chapterTitle: null,
        t: null,
        fusedScore: scores.get(id) ?? 0,
      });
    }
  }
  return hits;
}

/** FTS5 MATCH syntax has its own operators; a free-text question is quoted word by word (AND of terms, typo- and operator-safe). */
function ftsQuery(raw: string): string {
  const words = raw
    .toLowerCase()
    .match(/[a-z0-9']+/g)
    ?.slice(0, 24);
  if (!words || words.length === 0) return '""';
  return words.map((w) => `"${w.replaceAll('"', '')}"`).join(' OR ');
}
