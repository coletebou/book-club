import { readFileSync } from 'node:fs';

/*
 * Audio files made byte by byte for the tests: an M4B laid out to keep music-metadata's chapter
 * reader busy, and ID3v2.4 tags with chapter, text and picture frames put in front of the MPEG
 * frames of a fixture.
 */

function box(type: string, ...parts: Uint8Array[]): Buffer {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

const u32 = (...values: number[]) => {
  const b = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => b.writeUInt32BE(v, 4 * i));
  return b;
};
const u16 = (...values: number[]) => {
  const b = Buffer.alloc(2 * values.length);
  values.forEach((v, i) => b.writeUInt16BE(v, 2 * i));
  return b;
};
const zeros = (n: number) => Buffer.alloc(n);

function sampleTable(entry: Buffer, count: number, delta: number, sampleSize: number, chunkOffsets: readonly number[]): Buffer {
  // A million offsets are too many to spread into arguments: written one by one.
  const offsets = Buffer.alloc(4 * chunkOffsets.length);
  chunkOffsets.forEach((o, i) => offsets.writeUInt32BE(o, 4 * i));
  return box(
    'stbl',
    box('stsd', u32(0, 1), entry),
    box('stts', u32(0, 1, count, delta)),
    // One sample in every chunk.
    box('stsc', u32(0, 1, 1, 1, 1)),
    box('stsz', u32(0, sampleSize, count)),
    box('stco', u32(0, chunkOffsets.length), offsets),
  );
}

export interface CraftedM4b {
  /** One-sample chunks of audio (8 kHz, 1024 samples each): the table walked once per chapter. */
  readonly chunks: number;
  readonly chapters: number;
  /** Seconds between chapter starts (default 1). */
  readonly chapterSeconds?: number;
}

/**
 * An M4B whose chapter titles lie after all of its audio chunks. For each chapter music-metadata
 * finds where its title lies among the audio's chunks and adds up the samples before it, so the
 * work is chapters times chunks: a few megabytes take seconds, sixty-four take minutes.
 */
export function craftM4b({ chunks, chapters, chapterSeconds = 1 }: CraftedM4b): Uint8Array {
  const titles = Array.from({ length: chapters }, (_, i) => `Chapter ${String(i + 1).padStart(4, '0')}`);
  const sampleSize = 2 + titles[0]!.length;
  const ftyp = box('ftyp', Buffer.from('M4B \0\0\0\0isomM4B ', 'latin1'));
  const mp4a = Buffer.concat([u32(36), Buffer.from('mp4a', 'latin1'), zeros(6), u16(1), zeros(8), u16(1, 16, 0, 0, 8000, 0)]);
  const text = Buffer.concat([u32(16), Buffer.from('text', 'latin1'), zeros(6), u16(1)]);
  const moovAt = (mdatStart: number) =>
    box(
      'moov',
      box('mvhd', u32(0, 0, 0, 1000, Math.round((chunks * 1024) / 8), 0x00010000), u16(0x0100), zeros(10), zeros(36), zeros(24), u32(3)),
      box(
        'trak',
        box('tkhd', u32(3, 0, 0, 1, 0, 0), zeros(8), u16(0, 0, 0x0100, 0), zeros(36), u32(0, 0)),
        box('tref', box('chap', u32(2))),
        box(
          'mdia',
          box('mdhd', u32(0, 0, 0, 8000, chunks * 1024), u16(0x55c4, 0)),
          box('hdlr', u32(0, 0), Buffer.from('soun', 'latin1'), zeros(12), Buffer.from('h\0')),
          // Every audio chunk starts where the media data does, before every title.
          box('minf', sampleTable(mp4a, chunks, 1024, 10, new Array<number>(chunks).fill(mdatStart))),
        ),
      ),
      box(
        'trak',
        box('tkhd', u32(0, 0, 0, 2, 0, 0), zeros(8), u16(0, 0, 0x0100, 0), zeros(36), u32(0, 0)),
        box(
          'mdia',
          box('mdhd', u32(0, 0, 0, 1000, chapters * chapterSeconds * 1000), u16(0x55c4, 0)),
          box('hdlr', u32(0, 0), Buffer.from('text', 'latin1'), zeros(12), Buffer.from('h\0')),
          box('minf', sampleTable(text, chapters, chapterSeconds * 1000, sampleSize, titles.map((_, i) => mdatStart + 16 + i * sampleSize))),
        ),
      ),
    );
  // The media data's offset depends on the size of the movie box before it, which does not.
  const mdatStart = ftyp.length + moovAt(0).length + 8;
  const samples = titles.map((t) => Buffer.concat([u16(t.length), Buffer.from(t, 'latin1')]));
  return new Uint8Array(Buffer.concat([ftyp, moovAt(mdatStart), box('mdat', zeros(16), ...samples)]));
}

/* ID3v2.4 ------------------------------------------------------------------------------------ */

function syncsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/** One ID3v2.4 frame. */
export function id3Frame(id: string, data: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(data.length), zeros(2), data]);
}

/** A text frame (TIT2, TPE1, TALB...) in UTF-8. */
export function textFrame(id: string, text: string): Buffer {
  return id3Frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]));
}

/** A chapter frame (CHAP): its element id, start and end in milliseconds, and its title. */
export function chapFrame(elementId: string, startMs: number, endMs: number, title: string): Buffer {
  return id3Frame('CHAP', Buffer.concat([Buffer.from(`${elementId}\0`, 'latin1'), u32(startMs, endMs, 0xffffffff, 0xffffffff), textFrame('TIT2', title)]));
}

/** A top-level, ordered table of contents (CTOC) of chapter frames, at most 255. */
export function ctocFrame(elementIds: readonly string[]): Buffer {
  return id3Frame('CTOC', Buffer.concat([Buffer.from('toc\0', 'latin1'), Buffer.from([0x03, elementIds.length]), ...elementIds.map((id) => Buffer.from(`${id}\0`, 'latin1'))]));
}

/** An attached picture (APIC) of any type, as the front cover. */
export function pictureFrame(mime: string, data: Uint8Array): Buffer {
  return id3Frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from(`${mime}\0`, 'latin1'), Buffer.from([3, 0]), data]));
}

/** An ID3v2.4 tag holding these frames. */
export function id3Tag(frames: readonly Uint8Array[]): Buffer {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), syncsafe(body.length), body]);
}

/** The MPEG audio of an MP3 file without its ID3v2 tag (the fixtures have none at their end). */
export function mpegFramesOf(file: string): Buffer {
  const bytes = readFileSync(file);
  if (bytes.toString('latin1', 0, 3) !== 'ID3') return bytes;
  const size = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
  return bytes.subarray(10 + size);
}

/** An MP3: this tag in front of the MPEG frames of a fixture. */
export function mp3With(frames: readonly Uint8Array[], audioOf: string): Uint8Array {
  return new Uint8Array(Buffer.concat([id3Tag(frames), mpegFramesOf(audioOf)]));
}
