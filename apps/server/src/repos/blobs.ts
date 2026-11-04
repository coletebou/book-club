import { existsSync } from 'node:fs';
import { type Db } from '../db/db';
import { type AppContext } from '../context';
import { type Storage } from '../storage/storage';

export interface BlobRow {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  created_at: number;
}

export function blobById(db: Db, id: string): BlobRow | undefined {
  return db.get<BlobRow>('SELECT * FROM blobs WHERE id = ?', [id]);
}

export function insertBlob(db: Db, row: Omit<BlobRow, 'created_at'>): void {
  db.exec('INSERT INTO blobs (id, sha256, size, mime, created_at) VALUES (?, ?, ?, ?, ?)', [row.id, row.sha256, row.size, row.mime, Date.now()]);
}

/**
 * Move a file into the blob store, keeping each content once: a file identical to one already
 * stored (the same book uploaded to two clubs, the same tracks again) shares that blob. Deleting
 * a book removes a blob only once nothing refers to it (see `removeFiles`).
 */
export async function adoptBlob(db: Db, storage: Storage, file: string, mime: string): Promise<{ id: string; sha256: string; size: number }> {
  const blob = await storage.adopt(file);
  const same = db.get<BlobRow>('SELECT * FROM blobs WHERE sha256 = ? AND size = ? AND id != ?', [blob.sha256, blob.size, blob.id]);
  if (same && existsSync(storage.blobPath(same.id))) {
    await storage.removeBlob(blob.id);
    return { id: same.id, sha256: same.sha256, size: same.size };
  }
  insertBlob(db, { id: blob.id, sha256: blob.sha256, size: blob.size, mime });
  return blob;
}

/**
 * A stored blob with this content, its file in place, to share instead of storing the content
 * twice (D45). Look it up in the transaction that records its new use: a book deleted meanwhile
 * then cannot take the blob away, since deleting checks for uses and removes the row in one step.
 */
export function sharedBlob(db: Db, storage: Storage, sha256: string, size: number): BlobRow | undefined {
  return db.all<BlobRow>('SELECT * FROM blobs WHERE sha256 = ? AND size = ?', [sha256, size]).find((row) => existsSync(storage.blobPath(row.id)));
}

/**
 * Blobs no edition, book cover, Cal shelf item (D163) or note's media refers to any more (after
 * deletions). A note's media (D140) holds up to three blobs (original, derived, a video's poster):
 * orphanMedia's own sweep (services/note-media-cleanup.ts) removes an unattached upload's blobs
 * directly, after its own, longer grace period, so this never races a composer still open.
 */
export function orphanBlobs(db: Db): BlobRow[] {
  return db.all<BlobRow>(
    `SELECT b.* FROM blobs b
      WHERE NOT EXISTS (SELECT 1 FROM edition_files f WHERE f.blob_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM books k WHERE k.cover_blob_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM cal_shelf_items s WHERE s.blob_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM comment_media m WHERE m.original_blob_id = b.id OR m.derived_blob_id = b.id OR m.poster_blob_id = b.id)`,
  );
}

export function deleteBlobRow(db: Db, id: string): void {
  db.exec('DELETE FROM blobs WHERE id = ?', [id]);
}

/**
 * Delete a blob's row if nothing refers to it at this moment: true if it went. One statement, so
 * the check and the delete are one step, and a blob shared since it was found unused stays.
 */
export function deleteUnusedBlobRow(db: Db, id: string): boolean {
  const { changes } = db.exec(
    `DELETE FROM blobs WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM edition_files f WHERE f.blob_id = blobs.id)
        AND NOT EXISTS (SELECT 1 FROM books k WHERE k.cover_blob_id = blobs.id)
        AND NOT EXISTS (SELECT 1 FROM cal_shelf_items s WHERE s.blob_id = blobs.id)
        AND NOT EXISTS (SELECT 1 FROM comment_media m WHERE m.original_blob_id = blobs.id OR m.derived_blob_id = blobs.id OR m.poster_blob_id = blobs.id)`,
    [id],
  );
  return changes > 0;
}

/**
 * Remove blobs nothing refers to that are more than an hour old (a crash between storing a file
 * and recording what uses it leaves one behind; a younger one may be about to be used). A finish
 * may share one of them while the others are removed: each is checked again as it goes. This is
 * housekeeping, run unawaited, so it never fails: what goes wrong is logged and left for next time.
 */
export async function removeOrphanBlobs(ctx: AppContext, olderThanMs = 3600_000): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  let orphans: BlobRow[];
  try {
    orphans = orphanBlobs(ctx.db);
  } catch (err) {
    ctx.log.error({ err }, 'unused files could not be listed');
    return 0;
  }
  for (const blob of orphans) {
    if (blob.created_at > cutoff) continue;
    try {
      if (!deleteUnusedBlobRow(ctx.db, blob.id)) continue;
      await ctx.storage.removeBlob(blob.id);
      removed++;
    } catch (err) {
      ctx.log.error({ err, blob: blob.id }, 'an unused file could not be removed');
    }
  }
  return removed;
}

