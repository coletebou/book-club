/*
 * ID3v2 tags, read here where music-metadata's reading falls short: a tag unsynchronised as a
 * whole. ID3v2.2 and 2.3 unsynchronise everything after a tag's header (a zero byte goes in after
 * every FF that could pass for the start of an MPEG frame, and after every FF 00), while a frame's
 * size counts its bytes as they were before. music-metadata (12.2.3, and 12.3.0 too) walks such a
 * tag's frames where they lie, so the first zero put in ends the tag for it ("Non-zero bytes found
 * in ID3v2 padding"): a UTF-16 byte-order mark, FF FE, is written FF 00 FE. LibriVox's tracks are
 * tagged so; they kept only their ID3v1 titles, cut to 30 characters, and lost their pictures.
 * This reader undoes the unsynchronisation first, then walks the frames (ID3v2.4 unsynchronises
 * frame by frame, and is read so too).
 *
 * It works on bytes the caller has read (the tag's declared size, capped: in the server's track
 * worker, and in the browser from a File's first bytes), and takes them for untrusted: every
 * length is checked against the bytes there are before anything is read or allocated, a tag
 * declaring more than it holds gives what it holds, and garbage gives what came before it, or
 * null. It never throws.
 */

/** Bytes of an ID3v2 header: "ID3", the version, the flags and the size of the tag after them. */
export const ID3V2_HEADER_BYTES = 10;

/** Most of a tag looked at unless the caller says otherwise: what music-metadata buffers at most. */
const MAX_TAG_BYTES = 64 * 1024 * 1024;

/** Room for a tag's other frames beside its largest picture, and for the zero bytes put in. */
const ROOM_BESIDE_PICTURE = 1024 * 1024;

/** Bytes of a text frame decoded, and searched for a picture's MIME type or description, at most. */
const MAX_TEXT_BYTES = 64 * 1024;

export interface Id3v2Header {
  /** 2, 3 or 4: ID3v2.2, 2.3 or 2.4. */
  readonly version: 2 | 3 | 4;
  readonly flags: number;
  /** Unsynchronised: as a whole in 2.2 and 2.3, every frame in 2.4. */
  readonly unsynchronised: boolean;
  /** Bytes of the tag after its header, as it declares them: up to 256 MiB (28 bits). */
  readonly size: number;
}

export interface Id3v2Picture {
  /** Its MIME type, in lower case ("image/jpeg"; ID3v2.2's "JPG" and "PNG" are read as theirs). */
  readonly mime: string;
  /** Its ID3 picture type: 3 is the front cover, 0 any other picture. */
  readonly type: number;
  readonly description: string;
  readonly data: Uint8Array;
}

export interface Id3v2Tags {
  readonly version: 2 | 3 | 4;
  readonly title: string | null;
  readonly album: string | null;
  readonly artist: string | null;
  readonly albumArtist: string | null;
  /** The track's number ("2", or "2/5": 2). */
  readonly track: number | null;
  /** The tag's front cover, or else its first picture. */
  readonly picture: Id3v2Picture | null;
  /** The tag stopped short: a frame ran past its end, or the tag past the bytes given. */
  readonly truncated: boolean;
}

export interface Id3v2ReadOptions {
  /** Pictures larger than this are passed over (by default none is). */
  readonly maxPictureBytes?: number;
  /** Bytes of the tag looked at, its header included (default 64 MiB). */
  readonly maxBytes?: number;
}

type TextField = 'title' | 'album' | 'artist' | 'albumArtist' | 'track';

/** The text frames read, in ID3v2.2 (three-letter ids) and in 2.3 and 2.4. */
const V22_TEXT = new Map<string, TextField>([
  ['TT2', 'title'],
  ['TAL', 'album'],
  ['TP1', 'artist'],
  ['TP2', 'albumArtist'],
  ['TRK', 'track'],
]);
const V23_TEXT = new Map<string, TextField>([
  ['TIT2', 'title'],
  ['TALB', 'album'],
  ['TPE1', 'artist'],
  ['TPE2', 'albumArtist'],
  ['TRCK', 'track'],
]);

const FRONT_COVER = 3;

/** The ID3v2 header at the start of `bytes`, or null when they do not start with one. */
export function id3v2Header(bytes: Uint8Array): Id3v2Header | null {
  if (bytes.length < ID3V2_HEADER_BYTES || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
  const version = bytes[3]!;
  // No version or revision byte is ever FF, and the size is syncsafe: seven bits to a byte.
  if ((version !== 2 && version !== 3 && version !== 4) || bytes[4] === 0xff) return null;
  const size = syncsafe(bytes, 6);
  if (size === null) return null;
  const flags = bytes[5]!;
  return { version, flags, unsynchronised: (flags & 0x80) !== 0, size };
}

/**
 * How many bytes from the start of a file to read for its ID3v2 tag: the header and the size the
 * tag declares, but no more than a picture of `maxPictureBytes` and the frames beside it take.
 */
export function id3v2ReadLength(header: Id3v2Header, maxPictureBytes: number): number {
  return ID3V2_HEADER_BYTES + Math.min(header.size, Math.max(0, maxPictureBytes) + ROOM_BESIDE_PICTURE);
}

/** music-metadata's warning when it found other bytes than zeros where a tag's frames stopped. */
const STOPPED_SHORT = /ID3v2 padding/i;

/**
 * Whether a file's ID3v2 tag should be read again here, music-metadata's reading of it being
 * possibly incomplete: the tag is unsynchronised, or music-metadata stopped reading it at bytes
 * that are not padding (its warning "Non-zero bytes found in ID3v2 padding").
 */
export function id3v2ReadAgain(header: Id3v2Header, warnings: readonly { readonly message: string }[]): boolean {
  return header.unsynchronised || warnings.some((w) => STOPPED_SHORT.test(w.message));
}

/** Bytes with their unsynchronisation undone: every FF 00 is FF again (ID3v2.3 §5, 2.4 §6.1). */
export function resynchronise(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[length++] = bytes[i]!;
    if (bytes[i] === 0xff && bytes[i + 1] === 0) i++;
  }
  return out.subarray(0, length);
}

/**
 * The title, album, artists, track number and picture of the ID3v2 tag that `bytes` start with, as
 * far as they hold it; null when they do not start with a tag this can read (another version, or a
 * compressed ID3v2.2 tag, which its specification says to ignore).
 */
export function readId3v2(bytes: Uint8Array, options: Id3v2ReadOptions = {}): Id3v2Tags | null {
  const header = id3v2Header(bytes);
  if (!header || (header.version === 2 && header.flags & 0x40)) return null;
  const { version } = header;
  const declared = ID3V2_HEADER_BYTES + header.size;
  const end = Math.min(declared, bytes.length, Math.max(ID3V2_HEADER_BYTES, options.maxBytes ?? MAX_TAG_BYTES));
  let body = bytes.subarray(ID3V2_HEADER_BYTES, end);
  // 2.2 and 2.3 unsynchronise the whole tag, and their frame sizes count the bytes as they were;
  // 2.4 unsynchronises each frame, and its sizes count the bytes as they are.
  if (header.unsynchronised && version < 4) body = resynchronise(body);
  const maxPictureBytes = options.maxPictureBytes ?? Number.POSITIVE_INFINITY;
  const texts = new Map<TextField, string>();
  let picture: Id3v2Picture | null = null;
  const first = framesStart(body, header);
  let truncated = end < declared || first === null;
  const frameHead = version === 2 ? 6 : 10;
  let at = first ?? body.length;
  // Frames until the padding (zero bytes) or the end; a frame that is not one ends the reading.
  while (at < body.length && body[at] !== 0) {
    if (at + frameHead > body.length) {
      truncated = true;
      break;
    }
    const id = frameId(body, at, version === 2 ? 3 : 4);
    const size = version === 2 ? u24(body, at + 3) : version === 3 ? u32(body, at + 4) : syncsafe(body, at + 4);
    if (id === null || size === null) break;
    const start = at + frameHead;
    if (size > body.length - start) {
      truncated = true;
      break;
    }
    at = start + size;
    const field = (version === 2 ? V22_TEXT : V23_TEXT).get(id);
    const isPicture = id === (version === 2 ? 'PIC' : 'APIC');
    // The first of each frame counts, and a front cover over any other picture.
    if (field ? texts.has(field) : !isPicture || picture?.type === FRONT_COVER) continue;
    const content = frameContent(body.subarray(start, at), version, version === 2 ? 0 : body[start - 1]!, header.unsynchronised);
    if (!content) continue;
    if (field) {
      const text = frameText(content);
      if (text !== null) texts.set(field, text);
      continue;
    }
    const found = framePicture(content, version);
    if (found && found.data.length <= maxPictureBytes && (!picture || found.type === FRONT_COVER)) picture = found;
  }
  const track = texts.get('track');
  return {
    version,
    title: texts.get('title') ?? null,
    album: texts.get('album') ?? null,
    artist: texts.get('artist') ?? null,
    albumArtist: texts.get('albumArtist') ?? null,
    track: track === undefined ? null : trackNumber(track),
    picture,
    truncated,
  };
}

/** A 28-bit number written seven bits to a byte; null when a byte has its top bit set (or is missing). */
function syncsafe(bytes: Uint8Array, at: number): number | null {
  if (at + 4 > bytes.length) return null;
  const [a, b, c, d] = [bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!];
  if ((a | b | c | d) & 0x80) return null;
  return (a << 21) | (b << 14) | (c << 7) | d;
}

function u24(bytes: Uint8Array, at: number): number {
  return bytes[at]! * 0x10000 + bytes[at + 1]! * 0x100 + bytes[at + 2]!;
}

function u32(bytes: Uint8Array, at: number): number {
  return bytes[at]! * 0x1000000 + u24(bytes, at + 1);
}

/** A frame id: three (ID3v2.2) or four capital letters and digits; null for anything else. */
function frameId(bytes: Uint8Array, at: number, length: number): string | null {
  let id = '';
  for (let i = at; i < at + length; i++) {
    const c = bytes[i]!;
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) return null;
    id += String.fromCharCode(c);
  }
  return id;
}

/**
 * Where a tag's frames start in its body: after its extended header, if it has one (in 2.3 a
 * size that leaves itself out, then 6 or 10 bytes; in 2.4 a syncsafe size that counts itself).
 * Null when that header runs past the tag.
 */
function framesStart(body: Uint8Array, header: Id3v2Header): number | null {
  if (header.version === 2 || !(header.flags & 0x40)) return 0;
  if (header.version === 3) {
    if (body.length < 4) return null;
    const size = 4 + u32(body, 0);
    return size <= body.length ? size : null;
  }
  const size = syncsafe(body, 0);
  return size !== null && size >= 6 && size <= body.length ? size : null;
}

/**
 * A frame's content, freed of what its format flags put around it; null for one this cannot read
 * (compressed or encrypted). ID3v2.3's flags are %ijk00000: compressed, encrypted, grouped (a
 * group byte first). 2.4's are %0h00kmnp: grouped, compressed, encrypted, unsynchronised (as all
 * frames are when the tag says so), and a data length (four bytes) first.
 */
function frameContent(data: Uint8Array, version: 2 | 3 | 4, format: number, tagUnsynchronised: boolean): Uint8Array | null {
  if (version === 2) return data;
  if (version === 3) {
    if (format & 0xc0) return null;
    return format & 0x20 ? data.subarray(1) : data;
  }
  if (format & 0x0c) return null;
  let content = format & 0x02 || tagUnsynchronised ? resynchronise(data) : data;
  if (format & 0x40) content = content.subarray(1);
  if (format & 0x01) content = content.subarray(4);
  return content;
}

const UTF8 = new TextDecoder('utf-8');
const UTF16LE = new TextDecoder('utf-16le');
const UTF16BE = new TextDecoder('utf-16be');

/** ID3's text encodings: 0 ISO-8859-1, 1 UTF-16 with a byte-order mark, 2 UTF-16BE, 3 UTF-8. */
const isWide = (encoding: number) => encoding === 1 || encoding === 2;

/** Where a string ends: at its NUL (in UTF-16 two zero bytes, on a character's boundary), or -1. */
function nulAt(bytes: Uint8Array, wide: boolean): number {
  if (!wide) return bytes.indexOf(0);
  for (let i = 0; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
  return -1;
}

/** Whole UTF-16 characters: a last odd byte is left out. */
const even = (bytes: Uint8Array) => bytes.subarray(0, bytes.length & ~1);

function latin1(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 4096) text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return text;
}

/** A string (with no NUL in it) in one of ID3's encodings; UTF-16 without a byte-order mark is read little-endian. */
function decode(bytes: Uint8Array, encoding: number): string {
  if (encoding === 0) return latin1(bytes);
  if (encoding === 3) return UTF8.decode(bytes);
  if (encoding === 2) return UTF16BE.decode(even(bytes));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return UTF16BE.decode(even(bytes.subarray(2)));
  return UTF16LE.decode(even(bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2) : bytes));
}

/** A text frame's first string (2.4 parts several with a NUL), trimmed; null when it holds none. */
function frameText(content: Uint8Array): string | null {
  const encoding = content[0];
  if (encoding === undefined || encoding > 3) return null;
  const bytes = content.subarray(1, 1 + MAX_TEXT_BYTES);
  const end = nulAt(bytes, isWide(encoding));
  const text = decode(end < 0 ? bytes : bytes.subarray(0, end), encoding).trim();
  return text === '' ? null : text;
}

/** "2", "2/5" or " 02 ": 2. Nought, or no number, is none. */
function trackNumber(text: string): number | null {
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * An attached picture: an encoding, the picture's format (2.3 and 2.4: a MIME type up to a NUL;
 * 2.2: three letters), its type, a description in that encoding up to its NUL, then the picture.
 * Null for one that is not all there, or is only a link to a picture ("-->").
 */
function framePicture(content: Uint8Array, version: 2 | 3 | 4): Id3v2Picture | null {
  const encoding = content[0];
  if (encoding === undefined || encoding > 3) return null;
  let format: string;
  let at: number;
  if (version === 2) {
    format = latin1(content.subarray(1, 4));
    at = 4;
  } else {
    const end = content.subarray(1, 1 + MAX_TEXT_BYTES).indexOf(0);
    if (end < 0) return null;
    format = latin1(content.subarray(1, 1 + end));
    at = 2 + end;
  }
  const type = content[at];
  if (type === undefined) return null;
  const rest = content.subarray(at + 1);
  const wide = isWide(encoding);
  const end = nulAt(rest.subarray(0, MAX_TEXT_BYTES), wide);
  if (end < 0) return null;
  const data = rest.subarray(end + (wide ? 2 : 1));
  const mime = pictureMime(format, version);
  if (data.length === 0 || mime === '-->') return null;
  return { mime, type, description: decode(rest.subarray(0, end), encoding).trim(), data };
}

/** A picture's format as a MIME type, in lower case: "jpg" (and "image/jpg") is image/jpeg. */
function pictureMime(format: string, version: 2 | 3 | 4): string {
  const f = format.trim().toLowerCase();
  if (f === 'jpg' || f === 'jpeg' || f === 'image/jpg') return 'image/jpeg';
  if (f === 'png') return 'image/png';
  // ID3v2.2 names the format in three letters ("GIF", "BMP").
  return version === 2 && /^[a-z]{3}$/.test(f) ? `image/${f}` : f;
}
