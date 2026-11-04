import { chapterNameAt, chunkAtoms, mToT } from '@bookclub/shared';
import { type AppContext } from '../context';
import { bookById, bookChapters, editionById, editionTimeline } from '../repos/books';
import { embeddingsProviderFor } from './embeddings';
import { embedInBatches } from './embeddings/provider';
import { atomsForEdition } from './extract';
import { deleteChunksForEdition, indexStatus, insertChunksYielding, insertEmbeddings, logCost, pendingIndexJobs, setIndexStatus, yieldToLoop } from './store';
import { type NewChunk } from './types';

/**
 * Index (or re-index) one edition's text for Cal's hybrid search (D160, D164): extract its text
 * as atoms on its own measure, chunk them (packages/shared/cal/chunker.ts), place each chunk on
 * the book's timeline through the edition's own sync map (the same one spoiler gating uses), and
 * embed it. Old chunks of this edition are dropped first, so re-running after a re-ingest (a new
 * upload replacing the file, a corrected alignment) leaves no stale ones (cascade also drops them
 * if the edition itself is deleted, migrations/012_cal.sql).
 */
export async function indexEdition(ctx: AppContext, editionId: string): Promise<void> {
  setIndexStatus(ctx.db, 'edition', editionId, 'processing');
  try {
    const edition = editionById(ctx.db, editionId);
    if (!edition || edition.status !== 'ready') {
      setIndexStatus(ctx.db, 'edition', editionId, 'pending');
      return;
    }
    const book = bookById(ctx.db, edition.book_id);
    const timeline = editionTimeline(edition);
    if (!book || !timeline) {
      setIndexStatus(ctx.db, 'edition', editionId, 'failed', 'no book or timeline for this edition');
      return;
    }
    deleteChunksForEdition(ctx.db, editionId);
    const atoms = await atomsForEdition(ctx, edition);
    // Each step below is a solid stretch of work on a long book (parsing a 10 MB transcript, then
    // chunking it, then storing it): the event loop runs between them, never under all three at once.
    await yieldToLoop();
    if (atoms.length === 0) {
      setIndexStatus(ctx.db, 'edition', editionId, 'ready', null, 0);
      return;
    }
    const chapters = bookChapters(book);
    const windows = chunkAtoms(atoms);
    await yieldToLoop();
    const newChunks: NewChunk[] = windows.map((w, seq) => {
      const tStart = mToT(timeline.sync, w.m);
      const tEnd = mToT(timeline.sync, w.mEnd);
      return {
        clubId: book.club_id,
        sourceType: 'book',
        bookId: book.id,
        editionId: edition.id,
        shelfItemId: null,
        chapterTitle: chapterNameAt(chapters, tStart),
        tStart,
        tEnd,
        seq,
        text: w.text,
        tokenCount: w.tokenCount,
      };
    });
    const ids = await insertChunksYielding(ctx.db, newChunks);
    await embedChunks(ctx, book.club_id, ids, newChunks.map((c) => c.text));
    setIndexStatus(ctx.db, 'edition', editionId, 'ready', null, ids.length);
  } catch (err) {
    setIndexStatus(ctx.db, 'edition', editionId, 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Embed and store a batch of chunks' vectors; logs their cost (cal_cost_log, D168). No-op without a configured provider — the chunks stay full-text searchable, and are embedded the next time an index job for them runs once a key is set. */
export async function embedChunks(ctx: AppContext, clubId: string, chunkIds: readonly string[], texts: readonly string[]): Promise<void> {
  const provider = embeddingsProviderFor(ctx.config);
  if (!provider || chunkIds.length === 0) return;
  const { vectors, inputUnits, costUsd } = await embedInBatches(provider, texts);
  insertEmbeddings(ctx.db, chunkIds.map((id, i) => ({ chunkId: id, provider: provider.name, model: provider.model, vector: vectors[i]! })));
  logCost(ctx.db, { clubId, userId: null, kind: 'embed', provider: provider.name, model: provider.model, inputUnits, outputUnits: 0, costUsd });
}

/** Queue an edition for indexing (ingest/pipeline.ts calls this once an edition turns 'ready'). */
export function queueIndexEdition(ctx: AppContext, editionId: string): void {
  setIndexStatus(ctx.db, 'edition', editionId, 'pending');
  ctx.calJobs.enqueue(`cal-index:${editionId}`, () => indexEdition(ctx, editionId));
}

/** Re-queue editions whose indexing was interrupted by a restart (mirrors ingest's resumeIngest). */
export function resumeCalIndexing(ctx: AppContext): void {
  for (const job of pendingIndexJobs(ctx.db, 'edition')) {
    const edition = editionById(ctx.db, job.ref_id);
    if (edition?.status === 'ready') ctx.calJobs.enqueue(`cal-index:${job.ref_id}`, () => indexEdition(ctx, job.ref_id));
  }
}

export function editionIndexStatus(ctx: AppContext, editionId: string) {
  return indexStatus(ctx.db, 'edition', editionId);
}
