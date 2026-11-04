import { describe, expect, it } from 'vitest';
import { ID3V2_HEADER_BYTES, id3v2Header, id3v2ReadAgain, id3v2ReadLength, readId3v2, resynchronise } from './id3';

/* Tags made byte by byte, as their writers make them ----------------------------------------- */

const bytes = (...values: number[]) => Buffer.from(values);
const latin1 = (text: string) => Buffer.from(text, 'latin1');
/** UTF-16 with a byte-order mark, little-endian: what LibriVox's tags hold. */
const utf16 = (text: string) => Buffer.concat([bytes(0xff, 0xfe), Buffer.from(text, 'utf16le')]);
const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16();
const syncsafe = (n: number) => bytes((n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f);

/** A text frame's content: its encoding byte, then the text. */
const text = (encoding: number, encoded: Uint8Array) => Buffer.concat([bytes(encoding), encoded]);
const utf16Text = (value: string) => text(1, utf16(value));

/** ID3v2.3: a four-letter id, the size as a plain number, two flag bytes. */
function frame3(id: string, content: Uint8Array, flags = 0): Buffer {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(content.length, 4);
  head.writeUInt16BE(flags, 8);
  return Buffer.concat([head, content]);
}

/** ID3v2.4: as 2.3, with a syncsafe size. */
function frame4(id: string, content: Uint8Array, flags = 0): Buffer {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  syncsafe(content.length).copy(head, 4);
  head.writeUInt16BE(flags, 8);
  return Buffer.concat([head, content]);
}

/** ID3v2.2: a three-letter id and a three-byte size, no flags. */
function frame2(id: string, content: Uint8Array): Buffer {
  const head = Buffer.alloc(6);
  head.write(id, 0, 'latin1');
  head.writeUIntBE(content.length, 3, 3);
  return Buffer.concat([head, content]);
}

/** An attached picture's content (APIC): encoding, MIME type, picture type, description, data. */
function apic(mime: string, type: number, data: Uint8Array, description: Uint8Array = bytes(0), encoding = 0): Buffer {
  return Buffer.concat([bytes(encoding), latin1(`${mime}\0`), bytes(type), description, data]);
}

/**
 * Unsynchronisation as the ID3 specification has writers do it, and as LibriVox's tags are: a
 * zero byte after every FF that comes before 111xxxxx or before a zero.
 */
function unsynchronise(data: Uint8Array): Buffer {
  const out: number[] = [];
  data.forEach((b, i) => {
    out.push(b);
    if (b === 0xff && (i + 1 === data.length || data[i + 1]! >= 0xe0 || data[i + 1] === 0)) out.push(0);
  });
  return Buffer.from(out);
}

interface TagOptions {
  readonly unsynchronise?: boolean;
  readonly padding?: number;
  readonly flags?: number;
  /** The size to declare, when it is not the body's. */
  readonly size?: number;
}

/** A tag: its header, then its frames and padding, unsynchronised as a whole when asked (2.2, 2.3). */
function tag(version: 2 | 3 | 4, frames: readonly Uint8Array[], options: TagOptions = {}): Buffer {
  const plain = Buffer.concat([...frames, Buffer.alloc(options.padding ?? 0)]);
  const body = options.unsynchronise && version < 4 ? unsynchronise(plain) : plain;
  const flags = (options.flags ?? 0) | (options.unsynchronise ? 0x80 : 0);
  return Buffer.concat([latin1('ID3'), bytes(version, 0, flags), syncsafe(options.size ?? body.length), body]);
}

/** A JPEG's first and last bytes, with what unsynchronisation must keep: FF 00, FF FF, FF E0. */
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0x00, 0x12, 0xff, 0xff, 0x00, 0x7f, 0xff, 0xd9);

const ARCHIVE = 'https://archive.org/details/christmas_carol_7_1410_librivox';

/** The frames of one of LibriVox's "A Christmas Carol (version 7)" tracks, as they lie in the tag. */
function librivoxFrames(title: string, track: string, picture: Uint8Array = JPEG): Buffer[] {
  return [
    frame3('COMM', Buffer.concat([bytes(1), latin1('XXX'), bytes(0, 0), utf16(ARCHIVE)])),
    frame3('COMM', Buffer.concat([bytes(0), latin1('eng'), bytes(0), latin1(ARCHIVE)])),
    frame3('TALB', utf16Text('A Christmas Carol (version 7)')),
    frame3('TCON', text(0, latin1('Speech'))),
    frame3('TIT2', utf16Text(title)),
    frame3('TLEN', text(0, latin1('2797.45'))),
    frame3('TPE1', utf16Text('Charles Dickens')),
    frame3('TRCK', utf16Text(track)),
    frame3('TSSE', text(0, latin1('LAME 64bits version 3.99.5 (http://lame.sf.net)'))),
    frame3('APIC', apic('image/jpeg', 0, picture)),
  ];
}

const LIBRIVOX = { version: 3, title: '02 - Stave 2: The First of the Three Spirits', album: 'A Christmas Carol (version 7)', artist: 'Charles Dickens', albumArtist: null, track: 2, truncated: false };

/** The same few frames (title, album, artist, track, picture) as a tag of each version. */
function basicTag(version: 2 | 3 | 4, options: TagOptions & { readonly frameFlags?: number } = {}): Buffer {
  if (version === 2) {
    return tag(2, [frame2('TT2', utf16Text('Title')), frame2('TAL', utf16Text('Album')), frame2('TP1', utf16Text('Artist')), frame2('TRK', utf16Text('4')), frame2('PIC', Buffer.concat([bytes(0), latin1('JPG'), bytes(3, 0), JPEG]))], options);
  }
  const frame = (id: string, content: Uint8Array) => (version === 3 ? frame3(id, content, options.frameFlags) : frame4(id, content, options.frameFlags));
  return tag(version, [frame('TIT2', utf16Text('Title')), frame('TALB', utf16Text('Album')), frame('TPE1', utf16Text('Artist')), frame('TRCK', utf16Text('4')), frame('APIC', apic('image/jpeg', 3, JPEG))], options);
}

const BASIC = { title: 'Title', album: 'Album', artist: 'Artist', track: 4, truncated: false };

/** The same numbers every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => (a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296;
}

/* --------------------------------------------------------------------------------------------- */

describe('resynchronise', () => {
  it('turns every FF 00 back into FF, and keeps everything else', () => {
    expect([...resynchronise(bytes(0xff, 0x00, 0xfe))]).toEqual([0xff, 0xfe]);
    expect([...resynchronise(bytes(0xff, 0x00, 0x00))]).toEqual([0xff, 0x00]);
    expect([...resynchronise(bytes(0xff, 0x00, 0xff, 0x00))]).toEqual([0xff, 0xff]);
    expect([...resynchronise(bytes(0xff, 0xff, 0x00, 0xe0))]).toEqual([0xff, 0xff, 0xe0]);
    expect([...resynchronise(bytes(0x00, 0xff, 0x12, 0xff))]).toEqual([0x00, 0xff, 0x12, 0xff]);
    expect([...resynchronise(bytes())]).toEqual([]);
  });

  it('undoes what a writer’s unsynchronisation did, whatever the bytes', () => {
    const next = random(7);
    for (let n = 0; n < 200; n++) {
      // Bytes rich in FF, 00 and E0+, the ones unsynchronisation is about.
      const data = Buffer.from(Array.from({ length: 64 }, () => [0xff, 0x00, 0xe0, 0xfe, 0x12][Math.floor(next() * 5)]!));
      expect(Buffer.from(resynchronise(unsynchronise(data)))).toEqual(data);
    }
  });
});

describe('id3v2Header', () => {
  it('reads the version, the flags and the syncsafe size', () => {
    expect(id3v2Header(bytes(0x49, 0x44, 0x33, 3, 0, 0x80, 0x00, 0x04, 0x5e, 0x24))).toEqual({ version: 3, flags: 0x80, unsynchronised: true, size: 77_604 });
    expect(id3v2Header(bytes(0x49, 0x44, 0x33, 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f))).toEqual({ version: 4, flags: 0, unsynchronised: false, size: 2 ** 28 - 1 });
    expect(id3v2Header(bytes(0x49, 0x44, 0x33, 2, 0, 0, 0, 0, 0, 0))).toMatchObject({ version: 2, size: 0 });
  });

  it('is null for anything else', () => {
    expect(id3v2Header(latin1('ID3'))).toBeNull();
    expect(id3v2Header(bytes(0x49, 0x44, 0x32, 3, 0, 0, 0, 0, 0, 0))).toBeNull();
    // ID3v2.5 does not exist, nor does ID3v2.1 or a revision FF.
    expect(id3v2Header(bytes(0x49, 0x44, 0x33, 5, 0, 0, 0, 0, 0, 0))).toBeNull();
    expect(id3v2Header(bytes(0x49, 0x44, 0x33, 1, 0, 0, 0, 0, 0, 0))).toBeNull();
    expect(id3v2Header(bytes(0x49, 0x44, 0x33, 3, 0xff, 0, 0, 0, 0, 0))).toBeNull();
    // A size byte with its top bit set is not syncsafe.
    expect(id3v2Header(bytes(0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x80, 0))).toBeNull();
    expect(id3v2Header(bytes(0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0))).toBeNull();
  });
});

describe('id3v2ReadLength', () => {
  const header = (size: number) => id3v2Header(Buffer.concat([latin1('ID3'), bytes(3, 0, 0x80), syncsafe(size)]))!;

  it('is the header and the size the tag declares', () => {
    expect(id3v2ReadLength(header(77_604), 32 * 1024 * 1024)).toBe(ID3V2_HEADER_BYTES + 77_604);
  });

  it('is capped by the largest picture kept and a megabyte beside it, whatever the tag declares', () => {
    expect(id3v2ReadLength(header(2 ** 28 - 1), 32 * 1024 * 1024)).toBe(ID3V2_HEADER_BYTES + 33 * 1024 * 1024);
    expect(id3v2ReadLength(header(2 ** 28 - 1), 0)).toBe(ID3V2_HEADER_BYTES + 1024 * 1024);
  });
});

describe('id3v2ReadAgain', () => {
  const header = (flags: number) => id3v2Header(Buffer.concat([latin1('ID3'), bytes(3, 0, flags), syncsafe(100)]))!;

  it('reads a tag again when it is unsynchronised, or when music-metadata stopped short in it', () => {
    expect(id3v2ReadAgain(header(0x80), [])).toBe(true);
    expect(id3v2ReadAgain(header(0), [{ message: 'Non-zero bytes found in ID3v2 padding' }])).toBe(true);
    expect(id3v2ReadAgain(header(0), [])).toBe(false);
    expect(id3v2ReadAgain(header(0), [{ message: 'Invalid ID3v2.3 frame-header-ID: abcd' }])).toBe(false);
  });
});

describe('readId3v2', () => {
  describe('a tag unsynchronised as a whole, as LibriVox writes its tags (ID3v2.3)', () => {
    const tagged = tag(3, librivoxFrames('02 - Stave 2: The First of the Three Spirits', '2'), { unsynchronise: true, padding: 378 });

    it('holds zeros put in where a frame’s size does not count them (the check that this can fail)', () => {
      const plain = tag(3, librivoxFrames('02 - Stave 2: The First of the Three Spirits', '2'), { padding: 378 });
      expect(tagged.length).toBeGreaterThan(plain.length);
      // The first frame's byte-order mark, as it lies in the tag: FF 00 FE.
      expect(tagged.indexOf(bytes(0xff, 0x00, 0xfe))).toBeGreaterThan(0);
      expect(tagged.indexOf(bytes(0xff, 0x00, 0xfe))).toBeLessThan(10 + 10 + 126);
    });

    it('reads every frame: full title, album, artist, track and picture', () => {
      const read = readId3v2(tagged);
      expect(read).toMatchObject(LIBRIVOX);
      expect(read!.picture).toMatchObject({ mime: 'image/jpeg', type: 0, description: '' });
      // The picture as it was before unsynchronisation, its own FF 00s kept.
      expect(Buffer.from(read!.picture!.data)).toEqual(JPEG);
    });

    it('reads a 76,509-byte cover such as LibriVox’s whole, after the text frames', () => {
      const next = random(76);
      const cover = Buffer.concat([JPEG.subarray(0, 4), Buffer.from(Array.from({ length: 76_505 - 2 }, () => Math.floor(next() * 256))), bytes(0xff, 0xd9)]);
      const read = readId3v2(tag(3, librivoxFrames('01 - Stave 1: Marley’s Ghost', '1', cover), { unsynchronise: true, padding: 201 }));
      expect(read).toMatchObject({ title: '01 - Stave 1: Marley’s Ghost', track: 1, truncated: false });
      expect(read!.picture!.data.length).toBe(76_509);
      expect(Buffer.from(read!.picture!.data)).toEqual(cover);
    });
  });

  it('reads a plain ID3v2.3 tag, keeping the FF 00s its picture holds', () => {
    const read = readId3v2(tag(3, librivoxFrames('02 - Stave 2: The First of the Three Spirits', '2'), { padding: 100 }));
    expect(read).toMatchObject(LIBRIVOX);
    expect(Buffer.from(read!.picture!.data)).toEqual(JPEG);
  });

  it('reads ID3v2.2, plain or unsynchronised: three-letter frames and a PIC with a three-letter format', () => {
    for (const unsynchronised of [false, true]) {
      const read = readId3v2(basicTag(2, { unsynchronise: unsynchronised, padding: 16 }));
      expect(read).toMatchObject({ version: 2, ...BASIC });
      expect(read!.picture).toMatchObject({ mime: 'image/jpeg', type: 3 });
      expect(Buffer.from(read!.picture!.data)).toEqual(JPEG);
    }
    const png = readId3v2(tag(2, [frame2('PIC', Buffer.concat([bytes(0), latin1('PNG'), bytes(3, 0), JPEG]))]));
    expect(png!.picture!.mime).toBe('image/png');
    const gif = readId3v2(tag(2, [frame2('PIC', Buffer.concat([bytes(0), latin1('GIF'), bytes(3, 0), JPEG]))]));
    expect(gif!.picture!.mime).toBe('image/gif');
  });

  it('reads an ID3v2.2 tag’s album artist (TP2) and a 2.3 tag’s (TPE2)', () => {
    expect(readId3v2(tag(2, [frame2('TP1', text(0, latin1('Reader'))), frame2('TP2', text(0, latin1('Charles Dickens')))]))).toMatchObject({ artist: 'Reader', albumArtist: 'Charles Dickens' });
    expect(readId3v2(tag(3, [frame3('TPE2', text(0, latin1('Charles Dickens')))], { unsynchronise: true }))).toMatchObject({ artist: null, albumArtist: 'Charles Dickens' });
  });

  it('ignores an ID3v2.2 tag that says it is compressed, as its specification has readers do', () => {
    expect(readId3v2(basicTag(2, { flags: 0x40 }))).toBeNull();
  });

  describe('ID3v2.4', () => {
    it('reads a plain tag, with syncsafe frame sizes', () => {
      const read = readId3v2(basicTag(4, { padding: 10 }));
      expect(read).toMatchObject({ version: 4, ...BASIC });
      expect(Buffer.from(read!.picture!.data)).toEqual(JPEG);
    });

    it('resynchronises frames unsynchronised one by one, the frame’s size counting the zeros put in', () => {
      const frames = [frame4('TIT2', unsynchronise(utf16Text('Title')), 0x02), frame4('APIC', unsynchronise(apic('image/jpeg', 3, JPEG)), 0x02)];
      const read = readId3v2(tag(4, frames));
      expect(read).toMatchObject({ title: 'Title', truncated: false });
      expect(Buffer.from(read!.picture!.data)).toEqual(JPEG);
    });

    it('resynchronises every frame when the tag says it is unsynchronised, whatever the frames say', () => {
      const frames = [frame4('TIT2', unsynchronise(utf16Text('Title'))), frame4('APIC', unsynchronise(apic('image/jpeg', 3, JPEG)))];
      const read = readId3v2(tag(4, frames, { flags: 0x80 }));
      expect(read).toMatchObject({ title: 'Title' });
      expect(Buffer.from(read!.picture!.data)).toEqual(JPEG);
    });

    it('takes off a frame’s group byte and data length', () => {
      const content = utf16Text('Title');
      const grouped = Buffer.concat([bytes(0x42), syncsafe(content.length), content]);
      expect(readId3v2(tag(4, [frame4('TIT2', grouped, 0x41)]))).toMatchObject({ title: 'Title' });
      expect(readId3v2(tag(4, [frame4('TIT2', Buffer.concat([syncsafe(content.length), unsynchronise(content)]), 0x03)]))).toMatchObject({ title: 'Title' });
    });

    it('passes over compressed and encrypted frames', () => {
      for (const flags of [0x08 | 0x01, 0x04]) {
        const read = readId3v2(tag(4, [frame4('TIT2', utf16Text('Hidden'), flags), frame4('TIT2', utf16Text('Seen')), frame4('TALB', text(3, Buffer.from('x\0', 'latin1')), flags)]));
        expect(read).toMatchObject({ title: 'Seen', album: null });
      }
    });

    it('steps over an extended header', () => {
      const extended = Buffer.concat([syncsafe(6), bytes(1, 0)]);
      expect(readId3v2(tag(4, [extended, frame4('TIT2', utf16Text('Title'))], { flags: 0x40 }))).toMatchObject({ title: 'Title', truncated: false });
    });
  });

  describe('ID3v2.3 frames and headers', () => {
    it('passes over compressed and encrypted frames, and takes off a group byte', () => {
      const read = readId3v2(
        tag(3, [frame3('TIT2', Buffer.concat([bytes(0, 0, 0, 9), utf16Text('Zipped')]), 0x0080), frame3('TALB', utf16Text('Locked'), 0x0040), frame3('TPE1', Buffer.concat([bytes(7), utf16Text('Grouped')]), 0x0020), frame3('TIT2', utf16Text('Plain'))], { unsynchronise: true }),
      );
      expect(read).toMatchObject({ title: 'Plain', album: null, artist: 'Grouped' });
    });

    it('steps over an extended header, with or without its CRC, unsynchronised with the rest', () => {
      for (const extended of [Buffer.concat([bytes(0, 0, 0, 6), bytes(0, 0), bytes(0, 0, 0, 0)]), Buffer.concat([bytes(0, 0, 0, 10), bytes(0x80, 0), bytes(0, 0, 0, 0), bytes(0xff, 0xe1, 0xff, 0x00)])]) {
        const read = readId3v2(tag(3, [extended, frame3('TIT2', utf16Text('Title'))], { flags: 0x40, unsynchronise: true }));
        expect(read).toMatchObject({ title: 'Title', truncated: false });
      }
    });

    it('reads nothing past an extended header larger than the tag', () => {
      expect(readId3v2(tag(3, [bytes(0, 0, 0x10, 0), frame3('TIT2', utf16Text('Title'))], { flags: 0x40 }))).toMatchObject({ title: null, truncated: true });
    });
  });

  describe('text in every encoding', () => {
    const title = (encoding: number, encoded: Uint8Array) => readId3v2(tag(3, [frame3('TIT2', text(encoding, encoded))], { unsynchronise: true }))!.title;

    it('ISO-8859-1, UTF-16 with either byte-order mark (or none: little-endian), UTF-16BE and UTF-8', () => {
      expect(title(0, latin1('Les Misérables'))).toBe('Les Misérables');
      expect(title(1, utf16('Les Misérables — Fantine'))).toBe('Les Misérables — Fantine');
      expect(title(1, Buffer.concat([bytes(0xfe, 0xff), utf16be('Les Misérables — Fantine')]))).toBe('Les Misérables — Fantine');
      expect(title(1, Buffer.from('Fantine', 'utf16le'))).toBe('Fantine');
      expect(title(2, utf16be('Les Misérables — Fantine'))).toBe('Les Misérables — Fantine');
      expect(title(3, Buffer.from('Les Misérables — 𝔉antine', 'utf8'))).toBe('Les Misérables — 𝔉antine');
    });

    it('up to the first NUL (ID3v2.4 parts several values with one), trimmed', () => {
      expect(title(0, latin1('  First\0Second'))).toBe('First');
      expect(title(1, Buffer.concat([utf16(' First '), bytes(0, 0), utf16('Second')]))).toBe('First');
      expect(title(2, Buffer.concat([utf16be('First'), bytes(0, 0), utf16be('Second')]))).toBe('First');
      expect(title(3, Buffer.from('First\0Second', 'utf8'))).toBe('First');
      // A zero byte inside a UTF-16 character is not its end: U+0100 is 00 01 in UTF-16BE.
      expect(title(2, utf16be('ĀĀ'))).toBe('ĀĀ');
      // An odd last byte of UTF-16 is no character.
      expect(title(1, Buffer.concat([utf16('Odd'), bytes(0x41)]))).toBe('Odd');
    });

    it('is null for empty text and for an encoding there is none of', () => {
      expect(title(1, utf16('   '))).toBeNull();
      expect(title(0, bytes())).toBeNull();
      expect(title(4, latin1('Title'))).toBeNull();
      expect(readId3v2(tag(3, [frame3('TIT2', bytes())]))!.title).toBeNull();
    });

    it('takes the first of a frame with text, and a later one when the first has none', () => {
      expect(readId3v2(tag(3, [frame3('TIT2', utf16Text('One')), frame3('TIT2', utf16Text('Two'))]))!.title).toBe('One');
      expect(readId3v2(tag(3, [frame3('TIT2', utf16Text('')), frame3('TIT2', utf16Text('Two'))]))!.title).toBe('Two');
    });

    it('reads a track number from "2", "2/5" or " 02 ", and no number from anything else', () => {
      const track = (value: string) => readId3v2(tag(3, [frame3('TRCK', text(0, latin1(value)))]))!.track;
      expect([track('2'), track('2/5'), track(' 02 '), track('0'), track('-1'), track('two'), track('99999999999999999999')]).toEqual([2, 2, 2, null, null, null, null]);
    });
  });

  describe('pictures', () => {
    it('reads the MIME type, picture type, description (in the frame’s encoding) and data', () => {
      const read = readId3v2(tag(3, [frame3('APIC', apic('image/png', 3, JPEG, Buffer.concat([utf16('Cover (front)'), bytes(0, 0)]), 1))], { unsynchronise: true }));
      expect(read!.picture).toMatchObject({ mime: 'image/png', type: 3, description: 'Cover (front)' });
      expect(Buffer.from(read!.picture!.data)).toEqual(JPEG);
      const utf8 = readId3v2(tag(3, [frame3('APIC', apic('JPG', 0, JPEG, Buffer.from('Ça\0', 'utf8'), 3))]));
      expect(utf8!.picture).toMatchObject({ mime: 'image/jpeg', description: 'Ça' });
    });

    it('takes the front cover over any picture before it, else the first picture', () => {
      const back = Buffer.concat([JPEG, bytes(1)]);
      const front = Buffer.concat([JPEG, bytes(2)]);
      const other = Buffer.concat([JPEG, bytes(3)]);
      const picture = (...frames: Buffer[]) => Buffer.from(readId3v2(tag(3, frames))!.picture!.data);
      expect(picture(frame3('APIC', apic('image/jpeg', 4, back)), frame3('APIC', apic('image/jpeg', 3, front)), frame3('APIC', apic('image/jpeg', 3, other)))).toEqual(front);
      expect(picture(frame3('APIC', apic('image/jpeg', 0, other)), frame3('APIC', apic('image/jpeg', 4, back)))).toEqual(other);
    });

    it('passes over a picture larger than the caller keeps, and a link to one', () => {
      const big = Buffer.alloc(5000, 7);
      expect(readId3v2(tag(3, [frame3('APIC', apic('image/jpeg', 3, big))]), { maxPictureBytes: 4999 })!.picture).toBeNull();
      const kept = readId3v2(tag(3, [frame3('APIC', apic('image/jpeg', 3, big)), frame3('APIC', apic('image/jpeg', 0, JPEG))]), { maxPictureBytes: 4999 })!.picture;
      expect(Buffer.from(kept!.data)).toEqual(JPEG);
      expect(readId3v2(tag(3, [frame3('APIC', apic('-->', 3, latin1('https://example.com/cover.jpg')))]))!.picture).toBeNull();
    });

    it('is null for a picture that is not all there', () => {
      for (const content of [bytes(0), latin1('\0image/jpeg'), latin1('\0image/jpeg\0'), latin1('\0image/jpeg\0\x03'), latin1('\0image/jpeg\0\x03\0'), Buffer.concat([bytes(1), latin1('image/jpeg\0'), bytes(3, 0x41, 0)])]) {
        expect(readId3v2(tag(3, [frame3('APIC', content)]))!.picture, content.toString('hex')).toBeNull();
      }
    });
  });

  describe('tags that are cut short, overstate their size or hold garbage', () => {
    const whole = tag(3, librivoxFrames('02 - Stave 2: The First of the Three Spirits', '2'), { unsynchronise: true, padding: 32 });

    it('reads, from a tag cut anywhere, the frames before the cut and nothing of the frame it cuts', () => {
      const titleEnd = whole.indexOf(latin1('TLEN'));
      for (let length = 0; length <= whole.length; length++) {
        const read = readId3v2(whole.subarray(0, length));
        if (length < ID3V2_HEADER_BYTES) {
          expect(read).toBeNull();
          continue;
        }
        expect(read!.truncated, String(length)).toBe(length < whole.length);
        // The title is all there or not there at all, and so is the picture (the last frame, before 32 bytes of padding).
        expect(read!.title, String(length)).toBe(length >= titleEnd ? LIBRIVOX.title : null);
        expect(read!.picture === null, String(length)).toBe(length < whole.length - 32);
      }
    });

    it('reads what is there of a tag that declares more than it holds (its size is 28 bits)', () => {
      const overstated = tag(3, librivoxFrames('02 - Stave 2: The First of the Three Spirits', '2'), { unsynchronise: true, size: 2 ** 28 - 1 });
      const read = readId3v2(overstated);
      expect(read).toMatchObject({ ...LIBRIVOX, truncated: true });
      expect(Buffer.from(read!.picture!.data)).toEqual(JPEG);
    });

    it('looks at no more of a tag than it is told to', () => {
      const read = readId3v2(whole, { maxBytes: whole.indexOf(latin1('TLEN')) });
      expect(read).toMatchObject({ title: LIBRIVOX.title, artist: null, picture: null, truncated: true });
    });

    it('does not read a frame that runs past the tag’s end, nor anything after it', () => {
      const frames = [frame3('TALB', utf16Text('Album')), frame3('TIT2', utf16Text('Title'))];
      const body = Buffer.concat(frames);
      // The title's frame declares a byte more than the tag has.
      body.writeUInt32BE(body.readUInt32BE(frames[0]!.length + 4) + 1, frames[0]!.length + 4);
      expect(readId3v2(tag(3, [body]))).toMatchObject({ album: 'Album', title: null, truncated: true });
      // A frame declaring 4 GB is the same.
      body.writeUInt32BE(0xffffffff, frames[0]!.length + 4);
      expect(readId3v2(tag(3, [body]))).toMatchObject({ album: 'Album', title: null, truncated: true });
      // In ID3v2.4, a frame size that is not syncsafe ends the reading too.
      const v4 = Buffer.concat([frame4('TALB', utf16Text('Album')), frame4('TIT2', utf16Text('Title'))]);
      const sizeByte = frame4('TALB', utf16Text('Album')).length + 7;
      v4[sizeByte] = v4[sizeByte]! | 0x80;
      expect(readId3v2(tag(4, [v4]))).toMatchObject({ album: 'Album', title: null });
    });

    it('stops at the padding, and at bytes that are no frame', () => {
      expect(readId3v2(tag(3, [frame3('TALB', utf16Text('Album')), Buffer.alloc(4), frame3('TIT2', utf16Text('Title'))]))).toMatchObject({ album: 'Album', title: null, truncated: false });
      expect(readId3v2(tag(3, [frame3('TALB', utf16Text('Album')), latin1('ti t'), frame3('TIT2', utf16Text('Title'))]))).toMatchObject({ album: 'Album', title: null });
      expect(readId3v2(tag(3, []))).toMatchObject({ title: null, album: null, artist: null, albumArtist: null, track: null, picture: null, truncated: false });
    });

    it('never throws on garbage, and is quick about it', () => {
      const next = random(2026);
      const started = Date.now();
      for (let n = 0; n < 3000; n++) {
        let input: Buffer;
        if (n % 3 === 0) {
          // A real tag with a few of its bytes changed.
          input = Buffer.from(whole);
          for (let k = 0; k < 1 + (n % 7); k++) input[Math.floor(next() * input.length)] = Math.floor(next() * 256);
        } else {
          // A header of any version and flags, then noise heavy in FF, zeros and capital letters.
          const noise = Buffer.from(Array.from({ length: Math.floor(next() * 300) }, () => (next() < 0.3 ? [0xff, 0x00, 0x54, 0x41][Math.floor(next() * 4)]! : Math.floor(next() * 256))));
          input = Buffer.concat([latin1('ID3'), bytes(2 + (n % 3), 0, Math.floor(next() * 256)), syncsafe(Math.floor(next() * 2 ** 28)), noise]);
        }
        const read = readId3v2(input, { maxPictureBytes: 1000 });
        if (read) {
          expect(read.picture === null || read.picture.data.length <= 1000).toBe(true);
          for (const value of [read.title, read.album, read.artist, read.albumArtist]) expect(value === null || (typeof value === 'string' && value.length > 0)).toBe(true);
        }
      }
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });
});
