import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '@bookclub/shared';
import sharp from 'sharp';
import { parseFile } from 'music-metadata';
import { type AppContext } from '../context';
import { newId } from '../lib/crypto';
import { looksLikeAudio, looksLikeImage } from '../ingest/audio';
import { type BlobRow, insertBlob, sharedBlob } from '../repos/blobs';
import { type CommentMediaRow, type ProcessedMedia, markMediaProcessed, setMediaTranscript } from '../repos/comment-media';

/**
 * Media notes (D140, D141): a note or reply may carry a voice recording, 1-4 photos, or a short
 * video. Validated by content, never by its declared name or type; images are resized and
 * stripped of metadata (EXIF GPS: a phone's camera roll tags where a picture was taken) with
 * sharp, which the server already carries for covers; voice and video are made web-safe with
 * ffmpeg when the deploy image has it (Dockerfile, D141), since a recording made on an iPhone is
 * AAC/MP4 and one made in Chrome is WebM/Opus, and neither phone plays the other's directly.
 * Without ffmpeg, voice still works (its own bytes are served, which the browser that made them
 * always plays; cross-browser playback degrades) but a video is refused outright with a clear
 * reason: there is no safe way to read its dimensions or cut a poster frame from an unknown
 * container without it.
 */

/** How large one upload of each kind may be (LIMITS, D140). */
export const MAX_BYTES: Record<CommentMediaRow['kind'], number> = {
  voice: LIMITS.voiceNoteBytes,
  photo: LIMITS.photoNoteBytes,
  video: LIMITS.videoNoteBytes,
};

function headBytes(buf: Buffer): Uint8Array {
  return buf.subarray(0, Math.min(buf.length, 4096));
}

/** The HEIC/HEIF family: an iPhone set to "High Efficiency" may send one (an MP4-family box too). */
function looksLikeHeic(head: Uint8Array): boolean {
  const ascii = (start: number, len: number) => String.fromCharCode(...head.subarray(start, start + len));
  return ascii(4, 4) === 'ftyp' && ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(ascii(8, 4));
}

let ffmpegChecked: boolean | null = null;

/** Whether ffmpeg and ffprobe are on the server's PATH (Dockerfile's `runtime` image, D141). */
export function ffmpegAvailable(): boolean {
  if (ffmpegChecked === null) {
    try {
      ffmpegChecked = spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0 && spawnSync('ffprobe', ['-version'], { timeout: 5000 }).status === 0;
    } catch {
      ffmpegChecked = false;
    }
  }
  return ffmpegChecked;
}

/** For tests: force the cached answer (a box without ffmpeg installed, or one that pretends not to have it). */
export function setFfmpegAvailableForTests(value: boolean | null): void {
  ffmpegChecked = value;
}

/** What ffmpeg and ffprobe are given of the server's environment: enough to run, none of its secrets. */
function toolEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'];
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k)));
}

/** Signal ffmpeg and whatever it started (it leads its own process group, like the recogniser). */
function signalAll(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

/** Run ffmpeg, bounded: killed on the clock, its stderr kept for the failure message. */
function run(bin: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'ignore', 'pipe'], env: toolEnv(), detached: true });
    let stderr = '';
    let timedOut = false;
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      signalAll(child, 'SIGTERM');
      setTimeout(() => signalAll(child, 'SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (timedOut) reject(new Error(`took longer than ${Math.round(timeoutMs / 1000)}s`));
      else reject(new Error(stderr.trim().split('\n').pop() ?? `exited with ${code}`));
    });
  });
}

interface Probed {
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly hasVideo: boolean;
}

/** ffprobe's JSON: the stream and format info this needs, nothing else trusted from the file. */
function probe(file: string, timeoutMs: number): Promise<Probed> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { stdio: ['ignore', 'pipe', 'ignore'], env: toolEnv(), detached: true });
    let stdout = '';
    const timer = setTimeout(() => signalAll(child, 'SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffprobe exited with ${code}`));
        return;
      }
      try {
        const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[] };
        const video = data.streams?.find((s) => s.codec_type === 'video');
        const durationS = Number(data.format?.duration ?? video?.duration ?? NaN);
        resolve({ durationMs: Number.isFinite(durationS) ? Math.round(durationS * 1000) : null, width: video?.width ?? null, height: video?.height ?? null, hasVideo: !!video });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/** Longest ffmpeg may take on one file: generous for a clip this short, never unbounded. */
function timeoutFor(bytes: number): number {
  return 60_000 + Math.ceil(bytes / (1024 * 1024)) * 4000;
}

function failed(error: string): ProcessedMedia {
  return { status: 'failed', originalBlobId: null, derivedBlobId: null, posterBlobId: null, mime: null, durationMs: null, width: null, height: null, transcriptStatus: 'none', error };
}

/** Store bytes already in memory as a blob, sharing identical content already stored (D45). */
async function storeBlob(ctx: AppContext, bytes: Buffer, mime: string): Promise<BlobRow | { id: string; sha256: string; size: number }> {
  const stored = await ctx.storage.putBytes(bytes);
  const shared = sharedBlob(ctx.db, ctx.storage, stored.sha256, stored.size);
  if (shared) {
    await ctx.storage.removeBlob(stored.id);
    return shared;
  }
  insertBlob(ctx.db, { id: stored.id, sha256: stored.sha256, size: stored.size, mime });
  return stored;
}

async function processPhoto(ctx: AppContext, bytes: Buffer): Promise<ProcessedMedia> {
  const head = headBytes(bytes);
  if (!looksLikeImage(head) && !looksLikeHeic(head)) return failed('That is not a picture we can read.');
  try {
    const image = sharp(bytes, { limitInputPixels: 80_000_000 }).rotate();
    const meta = await image.metadata();
    // EXIF orientations 5-8 turn the picture a quarter: its width is the stored height (as covers.ts).
    const [w, h] = (meta.orientation ?? 1) >= 5 ? [meta.height ?? 0, meta.width ?? 0] : [meta.width ?? 0, meta.height ?? 0];
    // Re-encoding without .withMetadata() drops EXIF entirely, the GPS tag with it.
    const jpeg = await image.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
    const original = await storeBlob(ctx, bytes, 'image/*');
    const derived = await storeBlob(ctx, jpeg, 'image/jpeg');
    return { status: 'ready', originalBlobId: original.id, derivedBlobId: derived.id, posterBlobId: null, mime: 'image/jpeg', durationMs: null, width: w || null, height: h || null, transcriptStatus: 'none', error: null };
  } catch (err) {
    return failed(err instanceof Error ? err.message : 'That picture could not be read.');
  }
}

async function processVoice(ctx: AppContext, file: string, bytes: Buffer, size: number): Promise<ProcessedMedia> {
  if (!looksLikeAudio(headBytes(bytes))) return failed('That is not an audio recording we can play.');
  let durationMs: number | null = null;
  try {
    durationMs = Math.round(((await parseFile(file, { duration: true, skipCovers: true })).format.duration ?? 0) * 1000) || null;
  } catch {
    durationMs = null;
  }
  if (durationMs !== null && durationMs > LIMITS.voiceNoteSeconds * 1000 + 2000) return failed(`That recording is longer than ${Math.round(LIMITS.voiceNoteSeconds / 60)} minutes.`);
  const original = await storeBlob(ctx, bytes, 'audio/*');
  if (!ffmpegAvailable()) {
    // Served as its own bytes: the browser that recorded it always plays them (D141's fallback).
    return { status: 'ready', originalBlobId: original.id, derivedBlobId: original.id, posterBlobId: null, mime: null, durationMs, width: null, height: null, transcriptStatus: 'none', error: null };
  }
  const out = path.join(ctx.storage.tmpDir, `note-voice-${newId()}.m4a`);
  try {
    await run('ffmpeg', ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out], timeoutFor(size));
    const info = await probe(out, 15_000).catch((): Probed => ({ durationMs, width: null, height: null, hasVideo: false }));
    const derived = await storeBlob(ctx, await readFile(out), 'audio/mp4');
    return {
      status: 'ready',
      originalBlobId: original.id,
      derivedBlobId: derived.id,
      posterBlobId: null,
      mime: 'audio/mp4',
      durationMs: info.durationMs ?? durationMs,
      width: null,
      height: null,
      transcriptStatus: ctx.config.TRANSCRIBE_COMMAND ? 'queued' : 'none',
      error: null,
    };
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'a voice note could not be transcoded; its own bytes are served');
    return { status: 'ready', originalBlobId: original.id, derivedBlobId: original.id, posterBlobId: null, mime: null, durationMs, width: null, height: null, transcriptStatus: 'none', error: null };
  } finally {
    await unlink(out).catch(() => {});
  }
}

async function processVideo(ctx: AppContext, file: string, bytes: Buffer, size: number): Promise<ProcessedMedia> {
  if (!looksLikeAudio(headBytes(bytes))) return failed('That is not a video we can play.');
  if (!ffmpegAvailable()) return failed('Video notes need ffmpeg on the server, which this deploy does not have.');
  let probed: Probed;
  try {
    probed = await probe(file, 15_000);
  } catch {
    return failed('That video could not be read.');
  }
  if (!probed.hasVideo) return failed('That file has no picture to show.');
  if (probed.durationMs !== null && probed.durationMs > LIMITS.videoNoteSeconds * 1000 + 2000) return failed(`That video is longer than ${Math.round(LIMITS.videoNoteSeconds / 60)} minutes.`);
  const outVideo = path.join(ctx.storage.tmpDir, `note-video-${newId()}.mp4`);
  const outPoster = path.join(ctx.storage.tmpDir, `note-poster-${newId()}.jpg`);
  try {
    await run(
      'ffmpeg',
      ['-y', '-i', file, '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outVideo],
      timeoutFor(size),
    );
    const posterAt = probed.durationMs && probed.durationMs > 1000 ? '00:00:00.5' : '00:00:00.0';
    await run('ffmpeg', ['-y', '-ss', posterAt, '-i', outVideo, '-frames:v', '1', outPoster], 20_000);
    const info = await probe(outVideo, 15_000).catch(() => probed);
    const original = await storeBlob(ctx, bytes, 'video/*');
    const derived = await storeBlob(ctx, await readFile(outVideo), 'video/mp4');
    const poster = await storeBlob(ctx, await readFile(outPoster), 'image/jpeg');
    return {
      status: 'ready',
      originalBlobId: original.id,
      derivedBlobId: derived.id,
      posterBlobId: poster.id,
      mime: 'video/mp4',
      durationMs: info.durationMs ?? probed.durationMs,
      width: info.width ?? probed.width,
      height: info.height ?? probed.height,
      transcriptStatus: 'none',
      error: null,
    };
  } catch (err) {
    return failed(`That video could not be made playable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await unlink(outVideo).catch(() => {});
    await unlink(outPoster).catch(() => {});
  }
}

/**
 * Validate and process one upload (D140-D142): true content, never the declared name; images
 * resized and stripped of metadata; voice and video made web-safe when ffmpeg is there. Runs
 * inline in the upload request (clips are short; D142): by the time it returns, the note's writer
 * already knows whether it worked, with a reason when it did not.
 */
export async function processNoteMediaUpload(ctx: AppContext, media: CommentMediaRow, file: string): Promise<ProcessedMedia> {
  const { size } = await stat(file);
  if (size <= 0) return failed('That file is empty.');
  if (size > MAX_BYTES[media.kind]) return failed('That file is larger than this kind of note allows.');
  const bytes = await readFile(file);
  const result = media.kind === 'photo' ? await processPhoto(ctx, bytes) : media.kind === 'voice' ? await processVoice(ctx, file, bytes, size) : await processVideo(ctx, file, bytes, size);
  markMediaProcessed(ctx.db, media.id, result);
  return result;
}

/** How long a voice note's transcript may take: generous, since the file is at most a few minutes. */
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;

/** Split a command line on spaces, quoted parts together (mirrors services/readalong.ts). */
function splitCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

interface NoteTranscriptDoc {
  readonly tracks: readonly { readonly words: readonly (readonly [number, number, string, number?])[] }[];
}

/**
 * A voice note's transcript (D79, D143), from the same recogniser audiobooks use
 * (TRANSCRIBE_COMMAND): the note is one track, and its recognised words are joined into plain
 * text. Run in the background (services/jobs.ts' slow queue) so posting a voice note never waits
 * on it; the comment is republished over the socket once it is ready (routes/reading.ts), so the
 * transcript appears live under the player, the way a delete's placeholder is republished too.
 */
export async function transcribeVoiceNote(ctx: AppContext, mediaId: string, file: string): Promise<string | null> {
  const command = ctx.config.TRANSCRIBE_COMMAND;
  if (!command) return null;
  const parts = splitCommand(command);
  const out = path.join(ctx.storage.tmpDir, `note-transcript-${mediaId}.json`);
  try {
    await run(parts[0]!, [...parts.slice(1), '--out', out, file], TRANSCRIBE_TIMEOUT_MS);
    const doc = JSON.parse(await readFile(out, 'utf8')) as NoteTranscriptDoc;
    const words = doc.tracks[0]?.words.map((w) => w[2]).join(' ') ?? '';
    const text = words.replace(/\s+/g, ' ').trim().slice(0, LIMITS.noteTranscriptWords * 8) || null;
    setMediaTranscript(ctx.db, mediaId, text, text ? 'ready' : 'failed');
    return text;
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err), mediaId }, 'a voice note could not be transcribed');
    setMediaTranscript(ctx.db, mediaId, null, 'failed');
    return null;
  } finally {
    await unlink(out).catch(() => {});
  }
}
