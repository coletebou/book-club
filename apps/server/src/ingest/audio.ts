import { open, stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { LIMITS, MAX_COVER_BYTES } from '@bookclub/shared';
import { workerFromSources } from '../lib/worker-source';
import { cleanTitle } from './text';
import type { RawChapter, RawTrack, TrackReadLimits, TrackReply, TrackRequest } from './track-worker';

export interface TrackInfo {
  readonly durationMs: number;
  /** Chapters marked inside the file (an M4B's), with their starts; empty when it has none. */
  readonly chapters: readonly { readonly title: string; readonly startMs: number }[];
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly trackNo: number | null;
  readonly picture: { readonly data: Uint8Array; readonly format: string } | null;
  readonly container: string | null;
  /** Why chapters marked in the file were left out, for the log; null when none were. */
  readonly chaptersSkipped: string | null;
}

/** Chapters one file may mark: a long novel has a few hundred. A file with more is read as one. */
export const MAX_CHAPTERS_PER_TRACK = 500;

/** Longest chapter title kept; a title or artist is held to what members may type for a book's. */
const CHAPTER_TITLE_MAX = 200;

/** How long an MP4's chapter track may take to read before the file is read again without it. */
const CHAPTER_READ_MS = 20_000;

/**
 * How long reading one file may take: a minute, and a second more for every 256 KB. A VBR MP3
 * without a frame count is read frame by frame, which takes about a second a megabyte.
 */
export function readLimitMs(size: number): number {
  return 60_000 + Math.ceil(size / (256 * 1024)) * 1000;
}

/** A read stopped for taking too long. */
export class TrackTimeoutError extends Error {
  override name = 'TrackTimeoutError';
}

/** The worker: beside the bundle once built (build.mjs); from the sources, bundled here in memory. */
const BUILT = import.meta.url.endsWith('.ts') ? null : new URL('./track-worker.mjs', import.meta.url);

const READ_LIMITS: TrackReadLimits = { chapters: MAX_CHAPTERS_PER_TRACK, text: 4096, pictureBytes: MAX_COVER_BYTES };

export interface TrackReaderOptions {
  /** How long an MP4's chapter track may take to read (default 20 s). */
  readonly chapterMs?: number;
  /** How long a file of a given size may take to read without it (default {@link readLimitMs}). */
  readonly readMs?: (size: number) => number;
}

/**
 * Reads audio files, one at a time, in a worker thread: tags and duration are computed from the
 * stream when the header does not state them (so they are right for VBR files), and no file,
 * however it is made, can hold up the server, since a read that takes too long is stopped along
 * with its worker. The costly part is an MP4's chapter track: music-metadata walks the audio's
 * chunk table once per chapter, which a crafted file makes last minutes. A file whose chapter
 * track cannot be read in time is read again without it, and so are the reader's later files.
 */
export class TrackReader {
  private worker: Worker | null = null;
  private nextId = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private chapterTracks = true;

  constructor(private readonly options: TrackReaderOptions = {}) {}

  /** Tags, duration and chapters of one file (ID3v1/v2, MP4/M4B atoms, Vorbis comments). */
  inspect(file: string): Promise<TrackInfo> {
    const read = this.queue.then(() => this.read(file));
    this.queue = read.catch(() => undefined);
    return read;
  }

  /** Stop the worker; the reader starts another if it is used again. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  private async read(file: string): Promise<TrackInfo> {
    const { size } = await stat(file);
    const plainMs = (this.options.readMs ?? readLimitMs)(size);
    // Only an MP4 has a chapter track to walk (music-metadata reads chapters in no other format).
    if (!(await startsLikeMp4(file))) return trackInfo(await this.request(file, false, plainMs), null);
    if (!this.chapterTracks) return trackInfo(await this.request(file, false, plainMs), 'an earlier file’s chapters took too long to read');
    let skipped: string;
    try {
      return trackInfo(await this.request(file, true, this.options.chapterMs ?? CHAPTER_READ_MS), null);
    } catch (err) {
      if (err instanceof TrackTimeoutError) this.chapterTracks = false;
      skipped = err instanceof TrackTimeoutError ? 'its chapters took too long to read' : `its chapters could not be read (${err instanceof Error ? err.message : String(err)})`;
    }
    return trackInfo(await this.request(file, false, plainMs), skipped);
  }

  private async start(): Promise<Worker> {
    // The heap is bounded too: a file that makes the parser build huge tables fails on its own.
    const options = { workerData: READ_LIMITS, resourceLimits: { maxOldGenerationSizeMb: 512 } };
    const worker = BUILT ? new Worker(BUILT, options) : new Worker(await workerFromSources(new URL('./track-worker.ts', import.meta.url)), { ...options, eval: true, execArgv: ['--input-type=module'] });
    // An idle reader keeps nothing alive; a read in progress has its timer for that.
    worker.unref();
    // A worker that fails between reads is simply replaced.
    worker.on('error', () => this.drop(worker));
    worker.on('exit', () => this.drop(worker));
    return worker;
  }

  private drop(worker: Worker): void {
    if (this.worker === worker) this.worker = null;
    void worker.terminate();
  }

  private async request(file: string, chapters: boolean, limitMs: number): Promise<RawTrack> {
    // Bundling the worker from the sources is not part of a read's time.
    const worker = (this.worker ??= await this.start());
    const id = ++this.nextId;
    return new Promise<RawTrack>((resolve, reject) => {
      const settle = (done: () => void) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        done();
      };
      const onMessage = (reply: TrackReply) => {
        if (reply.id === id) settle(() => ('track' in reply ? resolve(reply.track) : reject(new Error(reply.error))));
      };
      const onError = (err: Error) => settle(() => reject(err));
      const onExit = (code: number) => settle(() => reject(new Error(`the track reader stopped (exit code ${code})`)));
      const timer = setTimeout(() => {
        this.drop(worker);
        settle(() => reject(new TrackTimeoutError(`reading took longer than ${limitMs} ms`)));
      }, limitMs);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      const request: TrackRequest = { id, file, chapters };
      worker.postMessage(request);
    });
  }
}

/** Tags, duration and chapters of one audio file, read by a reader of its own. */
export async function inspectTrack(file: string): Promise<TrackInfo> {
  const reader = new TrackReader();
  try {
    return await reader.inspect(file);
  } finally {
    await reader.close();
  }
}

async function startsLikeMp4(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const head = new Uint8Array(8);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && String.fromCharCode(...head.subarray(4, 8)) === 'ftyp';
  } finally {
    await handle.close();
  }
}

/** What the worker read, as the server keeps it: text tidied and bounded, chapters in milliseconds. */
function trackInfo(raw: RawTrack, skipped: string | null): TrackInfo {
  const ms = Math.round((raw.durationS ?? 0) * 1000);
  const durationMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const text = (value: string | null, max: number) => (value === null ? null : cleanTitle(value, max) || null);
  return {
    durationMs,
    chapters: raw.moreChapters ? [] : chaptersOf(raw.chapters, raw.sampleRate, durationMs),
    title: text(raw.title, LIMITS.bookTitle),
    artist: text(raw.artist, LIMITS.bookAuthor),
    album: text(raw.album, LIMITS.bookTitle),
    trackNo: raw.trackNo,
    picture: raw.picture,
    container: text(raw.container, 100),
    chaptersSkipped: skipped ?? (raw.moreChapters ? `it marks more than ${MAX_CHAPTERS_PER_TRACK} chapters` : null),
  };
}

/**
 * Where a chapter starts, in milliseconds. An MP4 chapter track and a Nero chapter list count in
 * their own units, `timeScale` of them to the second (a chapter track without a time scale is
 * placed by where its text lies among the audio's samples); ID3 chapter frames (CHAP) come from
 * music-metadata in seconds.
 */
function chapterStartMs(c: RawChapter, sampleRate: number | null): number {
  if (c.timeScale !== null && c.timeScale > 0) return (c.start * 1000) / c.timeScale;
  if (c.timeScale === 0) return c.sampleOffset !== null && sampleRate ? (c.sampleOffset * 1000) / sampleRate : Number.NaN;
  return c.start * 1000;
}

/**
 * The chapters marked inside one file (an M4B audiobook, an MP3 with ID3 chapter frames), each
 * with its start in milliseconds, in order, inside the file and at least a second apart.
 */
function chaptersOf(raw: readonly RawChapter[], sampleRate: number | null, durationMs: number): { title: string; startMs: number }[] {
  const out: { title: string; startMs: number }[] = [];
  for (const c of raw) {
    const startMs = chapterStartMs(c, sampleRate);
    if (!Number.isFinite(startMs) || startMs < 0 || (durationMs > 0 && startMs >= durationMs)) continue;
    const title = cleanTitle(c.title, CHAPTER_TITLE_MAX) || `Chapter ${out.length + 1}`;
    out.push({ title, startMs: Math.round(startMs) });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  const kept: { title: string; startMs: number }[] = [];
  for (const c of out) if (kept.length === 0 || c.startMs - kept[kept.length - 1]!.startMs >= 1000) kept.push(c);
  return kept;
}

/** Magic-byte check that a file really is audio we can serve (MP3, MP4/M4A/M4B, Ogg, FLAC, WAV, WebM). */
export function looksLikeAudio(head: Uint8Array): boolean {
  const ascii = (start: number, len: number) => String.fromCharCode(...head.subarray(start, start + len));
  if (ascii(0, 3) === 'ID3') return true;
  if (head[0] === 0xff && head[1] !== undefined && (head[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  if (ascii(4, 4) === 'ftyp') return true;
  if (ascii(0, 4) === 'OggS' || ascii(0, 4) === 'fLaC') return true;
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return true;
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true; // WebM/Matroska
  return false;
}

export function looksLikePdf(head: Uint8Array): boolean {
  // "%PDF-" may be preceded by a little junk in the first KB.
  const text = String.fromCharCode(...head.subarray(0, Math.min(head.length, 1024)));
  return text.includes('%PDF-');
}

export function looksLikeZip(head: Uint8Array): boolean {
  return head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05);
}

export function looksLikeImage(head: Uint8Array): boolean {
  const ascii = (start: number, len: number) => String.fromCharCode(...head.subarray(start, start + len));
  return (
    (head[0] === 0xff && head[1] === 0xd8) ||
    (head[0] === 0x89 && ascii(1, 3) === 'PNG') ||
    ascii(0, 3) === 'GIF' ||
    (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP')
  );
}
