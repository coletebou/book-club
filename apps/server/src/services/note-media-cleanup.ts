import { type AppContext } from '../context';
import { deleteCommentMediaRow, orphanMedia } from '../repos/comment-media';
import { deleteUnusedBlobRow } from '../repos/blobs';

/**
 * Media uploaded (POST /api/books/:bookId/media) but never attached to a note: the composer was
 * closed, or the tab was, before posting. Swept up an hour on, like an abandoned upload (D140);
 * this is housekeeping, run unawaited, so it never fails: what goes wrong is logged for next time.
 */
export async function removeOrphanNoteMedia(ctx: AppContext, olderThanMs = 3600_000): Promise<number> {
  let removed = 0;
  let orphans: ReturnType<typeof orphanMedia>;
  try {
    orphans = orphanMedia(ctx.db, olderThanMs);
  } catch (err) {
    ctx.log.error({ err }, 'orphaned note media could not be listed');
    return 0;
  }
  for (const media of orphans) {
    try {
      // The row goes first: deleteUnusedBlobRow refuses a blob a live comment_media row still
      // names, and this one is about to stop being that.
      deleteCommentMediaRow(ctx.db, media.id);
      for (const blobId of [media.original_blob_id, media.derived_blob_id, media.poster_blob_id]) {
        if (!blobId) continue;
        if (deleteUnusedBlobRow(ctx.db, blobId)) await ctx.storage.removeBlob(blobId);
      }
      removed++;
    } catch (err) {
      ctx.log.error({ err, media: media.id }, 'an orphaned note media could not be removed');
    }
  }
  return removed;
}
