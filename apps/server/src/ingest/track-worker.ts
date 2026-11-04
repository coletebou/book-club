/*
 * The worker thread that reads an audio file's tags, duration and chapters for TrackReader
 * (audio.ts), so that a file made to keep the parser busy holds up neither the server nor anyone
 * else's upload: the reader stops the worker when a read takes too long. It is bundled, as
 * dist/track-worker.mjs (build.mjs) or by TrackReader in memory from the sources, since the
 * shared package's ID3v2 reader it uses is TypeScript whose imports name no file extensions; it
 * imports nothing of the server's.
 */
import { open } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { type IAudioMetadata, parseFile } from 'music-metadata';
import { ID3V2_HEADER_BYTES, type Id3v2Tags, id3v2Header, id3v2ReadAgain, id3v2ReadLength, readId3v2 } from '@bookclub/shared';

/** How much of a file the server can use; anything more stays in the worker. */
export interface TrackReadLimits {
  /** Chapters passed on at most (a file with more is told apart by `moreChapters`). */
  readonly chapters: number;
  /** Characters of each piece of text. */
  readonly text: number;
  /** Bytes of the embedded picture: a bigger one is left out. */
  readonly pictureBytes: number;
}

export interface TrackRequest {
  readonly id: number;
  readonly file: string;
  /** Whether to read an MP4's chapter track (chapters in an ID3 tag come with the tag anyway). */
  readonly chapters: boolean;
}

/** A chapter as music-metadata gives it: `start` in the units its kind of chapter counts in. */
export interface RawChapter {
  readonly title: string;
  readonly start: number;
  readonly timeScale: number | null;
  readonly sampleOffset: number | null;
}

export interface RawTrack {
  readonly durationS: number | null;
  readonly sampleRate: number | null;
  readonly container: string | null;
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly trackNo: number | null;
  readonly picture: { readonly data: Uint8Array; readonly format: string } | null;
  readonly chapters: readonly RawChapter[];
  /** The file marks more chapters than are passed on. */
  readonly moreChapters: boolean;
}

export type TrackReply = { readonly id: number; readonly track: RawTrack } | { readonly id: number; readonly error: string };

/** Read one file, keeping no more of it than the limits allow. */
export async function readTrack(request: TrackRequest, limits: TrackReadLimits): Promise<TrackReply> {
  try {
    const meta = await parseFile(request.file, { duration: true, skipCovers: false, includeChapters: request.chapters });
    // A file that cannot be read again keeps what music-metadata read of it.
    const tag = await tagReadAgain(request.file, meta, limits).catch(() => null);
    return { id: request.id, track: rawTrack(meta, tag, limits) };
  } catch (err) {
    return { id: request.id, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The file's ID3v2 tag read again by the shared reader where music-metadata's reading of it may
 * have stopped short (a tag unsynchronised as a whole, as LibriVox's are): only the tag's bytes,
 * as many as it declares and no more than the largest picture kept needs. Null for any other file.
 */
async function tagReadAgain(file: string, meta: IAudioMetadata, limits: TrackReadLimits): Promise<Id3v2Tags | null> {
  const handle = await open(file, 'r');
  try {
    const head = new Uint8Array(ID3V2_HEADER_BYTES);
    const header = id3v2Header(head.subarray(0, (await handle.read(head, 0, head.length, 0)).bytesRead));
    if (!header || !id3v2ReadAgain(header, meta.quality.warnings)) return null;
    const bytes = new Uint8Array(Math.min(id3v2ReadLength(header, limits.pictureBytes), (await handle.stat()).size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return readId3v2(bytes.subarray(0, bytesRead), { maxPictureBytes: limits.pictureBytes });
  } finally {
    await handle.close();
  }
}

function rawTrack(meta: IAudioMetadata, tag: Id3v2Tags | null, limits: TrackReadLimits): RawTrack {
  const text = (value: string | null | undefined) => (typeof value === 'string' ? value.slice(0, limits.text) : null);
  const { common } = meta;
  const chapters = meta.format.chapters ?? [];
  // What the tag read again holds wins over music-metadata's reading (an ID3v1 title, cut to 30
  // characters), which stands for whatever the tag lacks.
  const picture = tag?.picture ? { data: tag.picture.data, format: tag.picture.mime } : common.picture?.[0];
  return {
    durationS: meta.format.duration ?? null,
    sampleRate: meta.format.sampleRate ?? null,
    container: text(meta.format.container),
    title: text(tag?.title ?? common.title),
    artist: text(tag?.albumArtist ?? tag?.artist ?? common.albumartist ?? common.artist),
    album: text(tag?.album ?? common.album),
    trackNo: tag?.track ?? common.track.no ?? null,
    // Copied out of the tag it lies in, so that only the picture crosses to the server.
    picture: picture && picture.data.byteLength <= limits.pictureBytes ? { data: picture.data.slice(), format: text(picture.format) ?? '' } : null,
    chapters: chapters.slice(0, limits.chapters).map((c) => ({ title: text(c.title) ?? '', start: c.start, timeScale: c.timeScale ?? null, sampleOffset: c.sampleOffset ?? null })),
    moreChapters: chapters.length > limits.chapters,
  };
}

// TrackReader starts this file with its limits as the worker's data; imported anywhere else
// (a test of readTrack), it listens for nothing.
const port = parentPort;
const limits = workerData as TrackReadLimits | null;
if (port && typeof limits?.chapters === 'number') {
  port.on('message', (request: TrackRequest) => {
    void readTrack(request, limits).then((reply) => {
      port.postMessage(reply, 'track' in reply && reply.track.picture ? [reply.track.picture.data.buffer as ArrayBuffer] : []);
    });
  });
}
