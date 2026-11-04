import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BookDetailSchema, ID3V2_HEADER_BYTES, id3v2Header } from '@bookclub/shared';
import { parseFile } from 'music-metadata';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectTrack, looksLikeImage } from '../src/ingest/audio';
import { readTrack } from '../src/ingest/track-worker';
import { mpegFramesOf } from './crafted-audio';
import { FIXTURES, SYNTHETIC_AUDIO, type Client, type TestApp, audioTracks, bookDetail, closeApp, makeTestApp, setupOwner, uploadBook } from './helpers';

/*
 * LibriVox's "A Christmas Carol (version 7)": ID3v2.3 tags unsynchronised as a whole, which
 * music-metadata reads no further than their first frame, and ID3v1 tags with the titles cut to
 * 30 characters (fidelity review round 13). fixtures/audio/carol-tiny holds five tracks tagged
 * as those are, frame for frame (scripts/fixtures/make-audio.mjs).
 */

const CAROL = path.join(FIXTURES, 'audio/carol-tiny');
const trackFile = (n: number) => path.join(CAROL, `christmascarol_${n}_dickens_64kb.mp3`);
const NUMBERS = [1, 2, 3, 4, 5];
const TITLES = ["01 - Stave 1: Marley's Ghost", '02 - Stave 2: The First of the Three Spirits', '03 - Stave 3: The Second of the Three Spirits', '04 - Stave 4: The Last of the Spirits', '05 - Stave 5: The End of It'];
/** The titles their ID3v1 tags hold: the first 30 characters. */
const CUT = ["01 - Stave 1: Marley's Ghost", '02 - Stave 2: The First of the', '03 - Stave 3: The Second of th', '04 - Stave 4: The Last of the', '05 - Stave 5: The End of It'];
/** A sixtieth of the recordings' 53:28, 46:43, 62:35, 41:15 and 17:44. */
const SECONDS = [53, 47, 63, 41, 18];
const ALBUM = 'A Christmas Carol (version 7)';
const AUTHOR = 'Charles Dickens';
const LIMITS = { chapters: 10, text: 4096, pictureBytes: 32 * 1024 * 1024 };

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
function write(name: string, bytes: Uint8Array): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-librivox-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

describe('tracks tagged as LibriVox tags them', () => {
  it('carry an unsynchronised ID3v2.3 tag, of which music-metadata reads nothing: only the cut ID3v1 title (the check that this can fail)', async () => {
    for (const n of NUMBERS) {
      expect(id3v2Header(readFileSync(trackFile(n)).subarray(0, ID3V2_HEADER_BYTES))).toMatchObject({ version: 3, unsynchronised: true });
      const meta = await parseFile(trackFile(n));
      expect(meta.format.tagTypes).toEqual(['ID3v2.3', 'ID3v1']);
      expect(meta.quality.warnings.map((w) => w.message)).toContain('Non-zero bytes found in ID3v2 padding');
      expect(meta.common).toMatchObject({ title: CUT[n - 1], album: ALBUM, artist: AUTHOR, track: { no: n } });
      expect(meta.common.picture).toBeUndefined();
    }
  });

  it('are read whole: the full titles, album, artist, track numbers and the cover', async () => {
    for (const n of NUMBERS) {
      const info = await inspectTrack(trackFile(n));
      expect(info).toMatchObject({ title: TITLES[n - 1], album: ALBUM, artist: AUTHOR, trackNo: n, container: 'MPEG', chapters: [] });
      expect(Math.abs(info.durationMs - SECONDS[n - 1]! * 1000)).toBeLessThan(250);
      expect(info.picture?.format).toBe('image/jpeg');
      expect(looksLikeImage(info.picture!.data)).toBe(true);
      const cover = await sharp(info.picture!.data).metadata();
      expect([cover.format, cover.width, cover.height]).toEqual(['jpeg', 200, 200]);
    }
  });

  it('the worker’s own reading of the tag read again passes on no more than it is allowed', async () => {
    const reply = await readTrack({ id: 1, file: trackFile(2), chapters: false }, { ...LIMITS, text: 12, pictureBytes: 100 });
    expect(reply).toMatchObject({ id: 1, track: { title: '02 - Stave 2', album: 'A Christmas ', artist: 'Charles Dick', trackNo: 2, picture: null } });
    const whole = await readTrack({ id: 2, file: trackFile(2), chapters: false }, LIMITS);
    expect('track' in whole && whole.track.picture?.data.byteLength).toBe(4298);
  });

  it('keeps music-metadata’s reading of whatever the tag read again lacks', async () => {
    // An unsynchronised tag holding a title alone, and an ID3v1 tag with an album and an artist.
    const utf16 = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from('The Whole Title of the Track, Longer Than Thirty', 'utf16le')]);
    const frame = Buffer.concat([Buffer.from('TIT2', 'latin1'), Buffer.alloc(4), Buffer.alloc(2), utf16]);
    frame.writeUInt32BE(utf16.length, 4);
    const body = Buffer.concat([frame, Buffer.alloc(64)]);
    const unsynchronised = Buffer.from([...body].flatMap((b, i) => (b === 0xff && (body[i + 1]! >= 0xe0 || body[i + 1] === 0) ? [b, 0] : [b])));
    const size = unsynchronised.length;
    const v1 = Buffer.alloc(128);
    v1.write('TAG', 0, 'latin1');
    v1.write('The Whole Title of the Track, ', 3, 30, 'latin1');
    v1.write('Ann Teller', 33, 30, 'latin1');
    v1.write('Tales from the First Tag', 63, 30, 'latin1');
    const file = write(
      'title-only.mp3',
      Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0x80, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]), unsynchronised, mpegFramesOf(path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3')), v1]),
    );
    // music-metadata reads the title's frame where it lies: its byte-order mark is FF 00 FE there.
    expect((await parseFile(file)).common.title).not.toBe('The Whole Title of the Track, Longer Than Thirty');
    expect(await inspectTrack(file)).toMatchObject({ title: 'The Whole Title of the Track, Longer Than Thirty', artist: 'Ann Teller', album: 'Tales from the First Tag', trackNo: null, picture: null });
  });

  it('a tag that is not unsynchronised, and in which music-metadata did not stop short, is not read again', async () => {
    const synthetic = path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3');
    expect(id3v2Header(readFileSync(synthetic))).toMatchObject({ version: 3, unsynchronised: false });
    expect((await parseFile(synthetic)).quality.warnings).toEqual([]);
    expect(await inspectTrack(synthetic)).toMatchObject({ title: 'The Beginning', artist: 'Ada Tone', album: 'The Synthetic Tale', trackNo: 1 });
  });
});

describe('an audiobook uploaded from tracks tagged as LibriVox tags them', () => {
  let t: TestApp;
  let owner: Client;
  let bookId: string;
  let editionId: string;

  beforeAll(async () => {
    t = await makeTestApp();
    let club;
    ({ owner, club } = await setupOwner(t));
    ({ bookId, editionId } = await uploadBook(owner, club.id, 'audio', audioTracks(CAROL), { title: 'A Christmas Carol', author: AUTHOR }));
    await t.settle();
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('names every track by its full title, and the book’s chapters after them', async () => {
    const book = BookDetailSchema.parse(await bookDetail(owner, bookId));
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    expect(audio.status).toBe('ready');
    expect(audio.tracks.map((tr) => tr.title)).toEqual(TITLES);
    audio.tracks.forEach((tr, i) => expect(Math.abs(tr.durationMs - SECONDS[i]! * 1000)).toBeLessThan(250));
    expect(book.chapters.map((c) => c.title)).toEqual(TITLES);
  });

  it('keeps the album and the artist from the tags', () => {
    const meta = JSON.parse(t.ctx.db.get<{ meta_json: string }>('SELECT meta_json FROM editions WHERE id = ?', [editionId])!.meta_json) as Record<string, unknown>;
    expect(meta).toMatchObject({ album: ALBUM, artist: AUTHOR });
  });

  it('takes the book’s cover from the picture in the tags', async () => {
    expect((await bookDetail(owner, bookId)).hasCover).toBe(true);
    const blob = t.ctx.db.get<{ cover_blob_id: string | null }>('SELECT cover_blob_id FROM books WHERE id = ?', [bookId])!.cover_blob_id;
    const cover = await sharp(readFileSync(t.ctx.storage.blobPath(blob!))).metadata();
    expect([cover.format, cover.width, cover.height]).toEqual(['jpeg', 200, 200]);
  });
});
