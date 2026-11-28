import { open } from 'node:fs/promises';
import { LIMITS } from '@bookclub/shared';
import { type AppContext } from '../context';
import { looksLikeAudio } from '../ingest/audio';
import { type ChatAttachmentRow, type ProcessedChatAttachment, markAttachmentProcessed } from '../repos/chat-attachments';
import { encodeVoice, ffmpegAvailable, storeBlob } from './note-media';

async function encode(ctx: AppContext, file: string, signal: AbortSignal): Promise<{ bytes: Buffer; durationMs: number } | { error: string }> {
  signal.throwIfAborted();
  const handle = await open(file, 'r');
  let size: number;
  const head = Buffer.alloc(16);
  try {
    ({ size } = await handle.stat());
    if (size === 0) return { error: 'That file is empty.' };
    if (size > LIMITS.voiceNoteBytes) return { error: 'That recording is too large.' };
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  if (!looksLikeAudio(head)) return { error: 'That is not an audio recording we can play.' };
  if (!ffmpegAvailable()) return { error: 'This server cannot prepare voice messages right now.' };
  // D276: encode at most one second past the accepted duration, so even a file that omits
  // its length cannot grow the output beyond the limit. Only the clean playback copy is kept.
  const allowedSeconds = LIMITS.voiceNoteSeconds + 2;
  let encoded;
  try {
    encoded = await encodeVoice(ctx, file, size, allowedSeconds + 1, signal);
  } catch (err) {
    signal.throwIfAborted();
    ctx.log.warn({ err }, 'a chat recording could not be encoded');
    return { error: 'That recording could not be read.' };
  }
  if (!encoded.durationMs) return { error: 'That recording contains no playable audio.' };
  if (encoded.durationMs > allowedSeconds * 1000) return { error: 'That recording is too long.' };
  return { bytes: encoded.bytes, durationMs: encoded.durationMs };
}

export async function processChatVoice(ctx: AppContext, row: ChatAttachmentRow, file: string, signal: AbortSignal): Promise<ProcessedChatAttachment> {
  const encoded = await encode(ctx, file, signal);
  signal.throwIfAborted();
  const fields = { thumbBlobId: null, width: null, height: null };
  if ('error' in encoded) {
    const failed = { ...fields, status: 'failed' as const, blobId: null, mime: null, error: encoded.error };
    markAttachmentProcessed(ctx.db, row.id, failed);
    return failed;
  }
  const ready = { ...fields, status: 'ready' as const, mime: 'audio/mp4', durationMs: encoded.durationMs, error: null };
  const blob = await storeBlob(ctx, encoded.bytes, ready.mime, (blobId) => markAttachmentProcessed(ctx.db, row.id, { ...ready, blobId }));
  return { ...ready, blobId: blob.id };
}
