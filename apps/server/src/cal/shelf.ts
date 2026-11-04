import { readFile, rm, writeFile } from 'node:fs/promises';
import { chunkAtoms } from '@bookclub/shared';
import { type AppContext } from '../context';
import { embedChunks } from './indexer';
import { safeFetch } from './safe-fetch';
import { epubShelfAtoms, htmlToText, pdfShelfAtoms, textAtoms } from './shelf-extract';
import { deleteChunksForShelfItem, insertChunksYielding, setShelfItemStatus, shelfItemById, shelfItemsForClub } from './store';
import { type CalShelfItemRow, type NewChunk } from './types';

/** Longest a member may feed Cal's shelf directly: a long paper, not a film-sized PDF (D163). */
export const MAX_SHELF_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Index one shelf item (D163): extract its readable text (a PDF's pages, an EPUB's spine, a plain
 * text/Markdown file, or a fetched URL's HTML), chunk it exactly as a book's own text is chunked,
 * and embed it. Shelf chunks carry no `t` (no timeline place) and so are never spoiler-gated —
 * general material a member fed Cal is not part of any book's story.
 */
export async function ingestShelfItem(ctx: AppContext, shelfItemId: string): Promise<void> {
  const item = shelfItemById(ctx.db, shelfItemId);
  if (!item) return;
  setShelfItemStatus(ctx.db, item.id, 'processing');
  try {
    const atoms = await atomsFor(ctx, item);
    deleteChunksForShelfItem(ctx.db, item.id);
    if (atoms.length === 0) {
      setShelfItemStatus(ctx.db, item.id, 'failed', 'No readable text was found there.');
      return;
    }
    const windows = chunkAtoms(atoms);
    const chunks: NewChunk[] = windows.map((w, seq) => ({
      clubId: item.club_id,
      sourceType: 'shelf',
      bookId: null,
      editionId: null,
      shelfItemId: item.id,
      chapterTitle: null,
      tStart: null,
      tEnd: null,
      seq,
      text: w.text,
      tokenCount: w.tokenCount,
    }));
    const ids = await insertChunksYielding(ctx.db, chunks);
    await embedChunks(ctx, item.club_id, ids, chunks.map((c) => c.text));
    setShelfItemStatus(ctx.db, item.id, 'ready');
  } catch (err) {
    setShelfItemStatus(ctx.db, item.id, 'failed', err instanceof Error ? err.message.slice(0, 500) : 'Could not read that.');
  }
}

async function atomsFor(ctx: AppContext, item: CalShelfItemRow | undefined) {
  if (!item) return [];
  switch (item.kind) {
    case 'epub':
      return item.blob_id ? epubShelfAtoms(new Uint8Array(await readFile(ctx.storage.blobPath(item.blob_id)))) : [];
    case 'pdf':
      return item.blob_id ? pdfShelfAtoms(ctx.storage.blobPath(item.blob_id)) : [];
    case 'txt':
    case 'md':
      return item.blob_id ? textAtoms(await readFile(ctx.storage.blobPath(item.blob_id), 'utf8')) : [];
    case 'url': {
      if (!item.source_url) return [];
      const fetched = await safeFetch(item.source_url);
      if (/pdf/i.test(fetched.contentType)) {
        const tmp = `${ctx.storage.tmpDir}/shelf-${item.id}.pdf`;
        await writeFile(tmp, fetched.bytes);
        try {
          return await pdfShelfAtoms(tmp);
        } finally {
          await rm(tmp, { force: true });
        }
      }
      const text = new TextDecoder('utf8', { fatal: false }).decode(fetched.bytes);
      return /html/i.test(fetched.contentType) || /<html/i.test(text.slice(0, 2000)) ? textAtoms(htmlToText(text)) : textAtoms(text);
    }
  }
}

/** Queue a shelf item for indexing. */
export function queueIndexShelfItem(ctx: AppContext, shelfItemId: string): void {
  ctx.calJobs.enqueue(`cal-shelf:${shelfItemId}`, () => ingestShelfItem(ctx, shelfItemId));
}

/** Re-queue shelf items whose indexing was interrupted by a restart (mirrors resumeCalIndexing). */
export function resumeShelfIndexing(ctx: AppContext): void {
  for (const club of ctx.db.all<{ id: string }>('SELECT id FROM clubs WHERE deleted_at IS NULL')) {
    for (const item of shelfItemsForClub(ctx.db, club.id)) {
      if (item.status === 'pending' || item.status === 'processing') queueIndexShelfItem(ctx, item.id);
    }
  }
}
