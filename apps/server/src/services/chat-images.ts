import { readFile, stat } from 'node:fs/promises';
import { LIMITS } from '@bookclub/shared';
import sharp from 'sharp';
import { type AppContext } from '../context';
import { looksLikeImage } from '../ingest/audio';
import { deleteUnusedBlobRow } from '../repos/blobs';
import {
  type ChatAttachmentRow,
  type ProcessedImage,
  blobsOf,
  deleteChatAttachmentRow,
  markAttachmentProcessed,
  orphanChatAttachments,
  takeAttachmentsOf,
} from '../repos/chat-attachments';
import { headBytes, looksLikeHeic, storeBlob } from './note-media';

/**
 * Pictures in chat (D203), made safe the way a note's photos are (D141), with the same sharp, the
 * same content sniffing and the same blob store: validated by what the bytes are, never by the
 * name or type they came with; re-encoded without any of their metadata, so the EXIF a phone
 * writes (where the photo was taken, the GPS) never leaves the upload request. Unlike a note's,
 * the upload as it came is not kept at all: nothing here needs it, and a copy kept would keep the
 * position it carries in the data directory and every backup.
 */

/** A kept picture's longest side: enough for a phone screenshot's text to stay legible. */
export const CHAT_IMAGE_MAX_SIDE = 2048;
/** A thumbnail's longest side: a bubble's width on a phone at twice its pixel density. */
export const CHAT_THUMB_MAX_SIDE = 640;
/** The largest picture sharp may decode (the same bound a note's photo has). */
const MAX_INPUT_PIXELS = 80_000_000;

type Metadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;

const failed = (error: string): ProcessedImage => ({ status: 'failed', blobId: null, thumbBlobId: null, mime: null, width: null, height: null, error });

/** Where a picture of `w` by `h` fits inside a square of `max`, never made larger. */
function fitted(w: number, h: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

async function encode(ctx: AppContext, bytes: Buffer): Promise<ProcessedImage> {
  const head = headBytes(bytes);
  const heic = looksLikeHeic(head);
  if (!looksLikeImage(head) && !heic) return failed('That is not a picture we can read.');
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    return failed(heic ? 'This server cannot read HEIC pictures. Send it as a JPEG (on an iPhone: Settings, Camera, Formats, Most Compatible).' : 'That picture could not be read.');
  }
  // An animated GIF or WebP stays animated (as WebP); anything else is one still picture.
  const animated = (meta.pages ?? 1) > 1 && (meta.format === 'gif' || meta.format === 'webp');
  try {
    const box = { width: CHAT_IMAGE_MAX_SIDE, height: CHAT_IMAGE_MAX_SIDE, fit: 'inside' as const, withoutEnlargement: true };
    // Never `.withMetadata()`: re-encoding drops EXIF (the GPS with it), XMP and IPTC.
    let full: Buffer;
    let mime: string;
    let width: number;
    let height: number;
    if (animated) {
      full = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: true }).resize(box).webp({ quality: 80 }).toBuffer();
      mime = 'image/webp';
      ({ width, height } = fitted(meta.width ?? 1, meta.pageHeight ?? meta.height ?? 1, CHAT_IMAGE_MAX_SIDE));
    } else {
      // A picture with transparency (a sticker, a cut-out) keeps it, as WebP; a photo is a JPEG.
      const still = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize(box);
      const out = await (meta.hasAlpha ? still.webp({ quality: 85 }) : still.jpeg({ quality: 84, mozjpeg: true })).toBuffer({ resolveWithObject: true });
      full = out.data;
      mime = meta.hasAlpha ? 'image/webp' : 'image/jpeg';
      ({ width, height } = out.info);
    }
    const thumb = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: CHAT_THUMB_MAX_SIDE, height: CHAT_THUMB_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    const fullBlob = await storeBlob(ctx, full, mime);
    const thumbBlob = await storeBlob(ctx, thumb, 'image/webp');
    return { status: 'ready', blobId: fullBlob.id, thumbBlobId: thumbBlob.id, mime, width, height, error: null };
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'a chat picture could not be made safe');
    return failed('That picture could not be read.');
  }
}

/**
 * Validate and make safe one uploaded picture, inline in its upload request (D142's shape): by the
 * time it answers, the composer knows whether the picture came through, and why not if it did not.
 */
export async function processChatImage(ctx: AppContext, row: ChatAttachmentRow, file: string): Promise<ProcessedImage> {
  const { size } = await stat(file);
  const result =
    size <= 0 ? failed('That file is empty.') : size > LIMITS.photoNoteBytes ? failed(`That picture is larger than ${Math.round(LIMITS.photoNoteBytes / 1024 ** 2)} MB.`) : await encode(ctx, await readFile(file));
  markAttachmentProcessed(ctx.db, row.id, result);
  return result;
}

/** A picture's bytes go, those nothing else (a shared, identical upload) still refers to. */
async function removeBlobsOf(ctx: AppContext, row: Pick<ChatAttachmentRow, 'blob_id' | 'thumb_blob_id'>): Promise<void> {
  for (const blobId of blobsOf(row)) if (deleteUnusedBlobRow(ctx.db, blobId)) await ctx.storage.removeBlob(blobId);
}

/** A message's pictures go with it, at once (D147's rule: deleted means gone, not gone within the hour). */
export async function deleteAttachmentsOf(ctx: AppContext, messageId: string): Promise<void> {
  for (const row of takeAttachmentsOf(ctx.db, messageId)) await removeBlobsOf(ctx, row);
}

/** An upload taken back before its message was sent (removed from the composer). */
export async function discardChatAttachment(ctx: AppContext, row: ChatAttachmentRow): Promise<void> {
  deleteChatAttachmentRow(ctx.db, row.id);
  await removeBlobsOf(ctx, row);
}

/**
 * Pictures uploaded but never sent, swept an hour on (as a note's media is, D140). Housekeeping,
 * run unawaited: it never fails, it logs what went wrong for the next run.
 */
export async function removeOrphanChatAttachments(ctx: AppContext, olderThanMs = 3600_000): Promise<number> {
  let removed = 0;
  let orphans: ChatAttachmentRow[];
  try {
    orphans = orphanChatAttachments(ctx.db, olderThanMs);
  } catch (err) {
    ctx.log.error({ err }, 'unsent chat pictures could not be listed');
    return 0;
  }
  for (const row of orphans) {
    try {
      await discardChatAttachment(ctx, row);
      removed++;
    } catch (err) {
      ctx.log.error({ err, attachment: row.id }, 'an unsent chat picture could not be removed');
    }
  }
  return removed;
}
