import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  ApiErrorSchema,
  BookDetailSchema,
  BookMatchSchema,
  BookProgressSchema,
  EditionSchema,
  MAX_EDITION_UNITS,
  PublicationSchema,
  chapterLabel,
  intToRoman,
  isValidSyncMap,
  linearSyncMap,
  mToT,
  translateLocator,
  type BookDetail,
  type BookMatch,
  type ClubDetail,
  type Edition,
  type EditionTimeline,
  type Publication,
} from '@bookclub/shared';
import { DEFAULT_LIMITS as EPUB_LIMITS, buildPublication } from '@bookclub/epub';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeBook } from '../src/services/removal';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { looksLikeImage } from '../src/ingest/audio';
import { COVER_DRAWING } from '../src/ingest/covers';
import { ingestEdition, resumeIngest } from '../src/ingest/pipeline';
import { insertBlob } from '../src/repos/blobs';
import { addEditionFile, createBook, createEdition } from '../src/repos/books';
import { craftM4b, mp3With, pictureFrame, textFrame } from './crafted-audio';
import {
  FIXTURES,
  ALICE_EPUB,
  ALICE_PDF,
  ALICE_TINY_AUDIO,
  ALICE_TINY_COVER,
  SYNTHETIC_AUDIO,
  type Client,
  type Res,
  type TestApp,
  audioTracks,
  closeApp,
  bookDetail,
  fileFrom,
  fileOf,
  joinClub,
  makeEpub,
  makePdf,
  makeTestApp,
  makeZip,
  outsider,
  setupOwner,
  standardEbook,
  uploadBook,
} from './helpers';

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;
const timelineOf = (e: Edition): EditionTimeline => ({ geometry: e.geometry!, sync: e.sync! });
const editionOf = (book: BookDetail, kind: Edition['kind']) => book.editions.find((e) => e.kind === kind)!;

describe('ingest', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let aliceId: string;
  let aliceCoverBlob: string | null;
  let pdfId: string;
  let synthId: string;
  let anasAliceId: string;

  const cover = () => fileFrom(ALICE_TINY_COVER, 'cover', 'image/jpeg');
  const coverBlobOf = (bookId: string) => t.ctx.db.get<{ cover_blob_id: string | null }>('SELECT cover_blob_id FROM books WHERE id = ?', [bookId])!.cover_blob_id;
  const metaOf = (editionId: string) => JSON.parse(t.ctx.db.get<{ meta_json: string }>('SELECT meta_json FROM editions WHERE id = ?', [editionId])!.meta_json) as Record<string, unknown>;
  const blobFile = (blobId: string) => t.ctx.storage.blobPath(blobId);
  /** Whether any edition or cover still refers to a blob (identical files are stored once). */
  const stillUsed = (id: string) => !!t.ctx.db.get('SELECT 1 AS x FROM edition_files WHERE blob_id = ?', [id]) || !!t.ctx.db.get('SELECT 1 AS x FROM books WHERE cover_blob_id = ?', [id]);

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    aliceId = (await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], {
      title: "Alice's Adventures in Wonderland",
      author: 'Lewis Carroll',
    })).bookId;
    await t.settle();
    aliceCoverBlob = coverBlobOf(aliceId);
    // The LibriVox-shaped folder, cover image included, added to the EPUB's book as another format.
    await uploadBook(owner, club.id, 'audio', [...audioTracks(ALICE_TINY_AUDIO), cover()], { title: 'Alice in Wonderland', author: 'Lewis Carroll', bookId: aliceId });
    pdfId = (await uploadBook(owner, club.id, 'pdf', [fileFrom(ALICE_PDF, 'main', 'application/pdf')], { title: 'Alice, printed', author: 'Lewis Carroll' })).bookId;
    // Tag titles must win over filenames, so the files get anonymous names.
    const synth = audioTracks(SYNTHETIC_AUDIO).map((f, i) => ({ ...f, name: `track-${'abc'[i]}.mp3` }));
    synthId = (await uploadBook(owner, club.id, 'audio', synth, { title: 'The Synthetic Tale', author: 'Ada Tone' })).bookId;
    // The same folder as a book of its own (uploaded by a member).
    anasAliceId = (await uploadBook(ana, club.id, 'audio', [...audioTracks(ALICE_TINY_AUDIO), cover()], { title: 'Alice in Wonderland', author: 'Lewis Carroll' })).bookId;
    await t.settle();
  });

  afterAll(async () => {
    await closeApp(t);
  });

  describe('EPUB', () => {
    it('becomes a ready reference edition whose table of contents defines the book chapters', async () => {
      const book = BookDetailSchema.parse(await bookDetail(owner, aliceId));
      const epub = editionOf(book, 'epub');
      expect(epub).toMatchObject({ status: 'ready', error: null, publicationUrl: `/api/editions/${epub.id}/publication`, fileUrl: null, tracks: [] });
      expect(book.referenceEditionId).toBe(epub.id);
      expect(epub.geometry).toMatchObject({ kind: 'epub' });
      expect((epub.geometry as { sectionLengths: number[] }).sectionLengths).toHaveLength(15);
      expect(book.chapters.map((c) => c.title).slice(0, 4)).toEqual([
        'Alice’s Adventures in Wonderland',
        'THE MILLENNIUM FULCRUM EDITION 3.0',
        'Contents',
        'CHAPTER I. Down the Rabbit-Hole',
      ]);
      expect(book.chapters.filter((c) => c.title.startsWith('CHAPTER '))).toHaveLength(12);
      expect(book.chapters.at(-1)!.title).toBe('CHAPTER XII. Alice’s Evidence');
      for (const [i, c] of book.chapters.entries()) {
        expect(c.index).toBe(i);
        if (i > 0) expect(c.t).toBeGreaterThan(book.chapters[i - 1]!.t);
        expect(c.t).toBeLessThan(1);
      }
      // Every TOC entry but the licence is a chapter.
      expect(epub.units).toHaveLength(16);
      expect(epub.units.at(-1)!.title).toBe('THE FULL PROJECT GUTENBERG™ LICENSE');
      expect(epub.alignment).toEqual({ method: 'reference', unitToChapter: [...Array.from({ length: 15 }, (_, i) => i), null] });
    });

    it('maps the story (not the Gutenberg header or licence) linearly onto the timeline', async () => {
      const book = await bookDetail(owner, aliceId);
      const epub = editionOf(book, 'epub');
      const pub = PublicationSchema.parse(await owner.json(owner.get(epub.publicationUrl!), 200));
      const total = (epub.geometry as { sectionLengths: number[] }).sectionLengths.reduce((a, b) => a + b, 0);
      expect(pub.story.start).toBeGreaterThan(0);
      expect(pub.story.end).toBeLessThan(total);
      expect(epub.sync).toEqual(linearSyncMap(pub.story.start, pub.story.end));
      // The package metadata (dc:title) has a straight apostrophe; the table of contents a curly one.
      expect(metaOf(epub.id)).toEqual({ title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', language: 'en', story: pub.story });
    });

    it('publishes a manifest of the sanitised publication', async () => {
      const epub = editionOf(await bookDetail(owner, aliceId), 'epub');
      const res = await owner.get(epub.publicationUrl!);
      expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      const pub: Publication = PublicationSchema.parse(res.json());
      expect(pub).toMatchObject({ editionId: epub.id, baseUrl: `/media/editions/${epub.id}/epub/`, title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', language: 'en', direction: 'ltr' });
      expect(pub.sections.map((s) => s.index)).toEqual(Array.from({ length: 15 }, (_, i) => i));
      expect(pub.sections.map((s) => s.textLength)).toEqual((epub.geometry as { sectionLengths: number[] }).sectionLengths);
      expect(pub.toc).toHaveLength(16);
      for (const entry of pub.toc) {
        expect(entry.section).toBeGreaterThanOrEqual(0);
        expect(entry.section).toBeLessThan(15);
        expect(entry.href.startsWith(pub.sections[entry.section]!.href)).toBe(true);
      }
      for (const s of pub.sections) expect(pub.resources).toContain(s.href);
      expect(pub.resources.some((r) => r.endsWith('.opf'))).toBe(false);
    });

    it('serves every section as script-free XHTML', async () => {
      const epub = editionOf(await bookDetail(owner, aliceId), 'epub');
      const pub = await owner.json<Publication>(owner.get(epub.publicationUrl!), 200);
      for (const s of pub.sections) {
        const res = await owner.get(`${pub.baseUrl}${s.href}`);
        expect(res.statusCode, s.href).toBe(200);
        expect(res.headers['content-type']).toBe('application/xhtml+xml; charset=utf-8');
        expect(res.body).not.toMatch(/<script/i);
        expect(res.body).not.toMatch(/\son[a-z]+\s*=/i);
      }
      const chapterOne = pub.sections[pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section]!;
      expect((await owner.get(`${pub.baseUrl}${chapterOne.href}`)).body).toContain('Alice was beginning to get very tired');
    });

    it('leaves out of the story what the book marks around it: Standard Ebooks’ title page and imprint, colophon and licence (FR150)', async () => {
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf('jekyll.epub', standardEbook(), 'main', 'application/epub+zip')], { title: 'Jekyll', author: 'Stevenson' });
      await t.settle();
      const book = await bookDetail(owner, bookId);
      const epub = editionOf(book, 'epub');
      expect(epub.status).toBe('ready');
      // The book's chapters are its story's: no Titlepage, Imprint, Colophon or Uncopyright.
      expect(book.chapters.map((c) => c.title)).toEqual(['Story of the Door', 'Search for Mr. Hyde', 'Henry Jekyll’s Full Statement of the Case']);
      const pub = PublicationSchema.parse(await owner.json(owner.get(epub.publicationUrl!), 200));
      const lengths = (epub.geometry as { sectionLengths: number[] }).sectionLengths;
      const startOf = (i: number) => lengths.slice(0, i).reduce((a, b) => a + b, 0);
      // From the first chapter's document to the end of the last one's; the rest is after it, the book's own.
      expect(pub.story).toEqual({ start: startOf(2), end: startOf(5) });
      expect(pub.backMatter).toEqual({ start: startOf(5), end: startOf(7) });
      expect(epub.sync).toEqual(linearSyncMap(pub.story.start, pub.story.end));
      // The story's last chapter ends the book: its end is 100 %.
      expect(mToT(epub.sync!, startOf(5))).toBe(1);
      expect(book.chapters[0]!.t).toBe(0);
      // The colophon and the licence are still in the book, to read.
      expect(pub.toc.map((e) => e.title)).toEqual(['Titlepage', 'Imprint', 'Story of the Door', 'Search for Mr. Hyde', 'Henry Jekyll’s Full Statement of the Case', 'Colophon', 'Uncopyright']);
      const colophon = pub.sections[pub.toc.find((e) => e.title === 'Colophon')!.section]!;
      expect((await owner.get(`${pub.baseUrl}${colophon.href}`)).body).toContain('Standard Ebooks');
      // A place in the colophon is the story's end on the timeline, as Gutenberg's licence is (D26).
      expect(chapterLabel(book.chapters, mToT(epub.sync!, startOf(6)))).toBe('Henry Jekyll’s Full Statement of the… · 100%');
    });

    it('takes the cover from the EPUB', async () => {
      const book = await bookDetail(owner, aliceId);
      expect(book.hasCover).toBe(true);
      expect(aliceCoverBlob).not.toBeNull();
      expect(book.coverUrl).toBe(`/media/books/${aliceId}/cover?v=${aliceCoverBlob}.${COVER_DRAWING}`);
      expect(looksLikeImage(readFileSync(blobFile(aliceCoverBlob!)))).toBe(true);
    });
  });

  describe('PDF', () => {
    it('reads 91 pages and turns the 12 outline entries into the chapters', async () => {
      const book = BookDetailSchema.parse(await bookDetail(owner, pdfId));
      const pdf = editionOf(book, 'pdf');
      expect(pdf).toMatchObject({ status: 'ready', pageCount: 91, geometry: { kind: 'pdf', pageCount: 91 }, fileUrl: `/media/editions/${pdf.id}/file`, publicationUrl: null });
      expect(pdf.units).toHaveLength(12);
      expect(pdf.units.map((u) => u.title)).toEqual(Array.from({ length: 12 }, (_, i) => expect.stringMatching(new RegExp(`^CHAPTER ${intToRoman(i + 1).toUpperCase()}\\. `)) as string));
      expect(pdf.sync).toEqual(linearSyncMap(0, 91));
      expect(book.chapters.map((c) => c.title)).toEqual(pdf.units.map((u) => u.title));
      for (const [i, c] of book.chapters.entries()) expect(c.t).toBeCloseTo(pdf.units[i]!.m / 91, 12);
      expect(book.chapters[0]!.t).toBeGreaterThan(0); // the title page comes first
    });

    it('places an outline entry that points down a page at that point of the page', async () => {
      const bytes = makePdf(3, { title: 'In Two Parts', author: 'A. N. Author' }, [
        { title: 'Part One', page: 0, top: 450 },
        { title: 'Part Two', page: 1, top: 225 },
      ]);
      const { bookId } = await uploadBook(owner, club.id, 'pdf', [fileOf('parts.pdf', bytes, 'main', 'application/pdf')], { title: 'In Two Parts', author: '' });
      await t.settle();
      const book = await bookDetail(owner, bookId);
      expect(book.editions[0]!.units).toEqual([
        { title: 'Part One', m: 0 },
        { title: 'Part Two', m: 1.5 },
      ]);
      expect(book.chapters.map((c) => [c.title, c.t])).toEqual([
        ['Part One', 0],
        ['Part Two', 0.5],
      ]);
    });

    it('takes the title and author from the document info', async () => {
      const pdf = editionOf(await bookDetail(owner, pdfId), 'pdf');
      expect(metaOf(pdf.id)).toMatchObject({ title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', story: { start: 0, end: 91 } });
    });

    it('renders page one as the cover', async () => {
      const book = await bookDetail(owner, pdfId);
      expect(book.hasCover).toBe(true);
      const image = sharp(readFileSync(blobFile(coverBlobOf(pdfId)!)));
      const meta = await image.metadata();
      expect(meta.format).toBe('jpeg');
      expect(Math.max(meta.width, meta.height)).toBeGreaterThanOrEqual(899);
      expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(901);
      expect(meta.width / meta.height).toBeCloseTo(420 / 595, 2); // A5
      // The title page is a dark field with gold type, so a real rendering is dark (blank would be white).
      const stats = await image.stats();
      expect(stats.channels[0]!.mean).toBeLessThan(80);
    });
  });

  describe('audiobook from tagged tracks', () => {
    it('measures every track and names it from its tags, not its filename', async () => {
      const book = BookDetailSchema.parse(await bookDetail(owner, synthId));
      const audio = editionOf(book, 'audio');
      expect(audio.status).toBe('ready');
      expect(audio.tracks.map((tr) => tr.title)).toEqual(['The Beginning', 'The Middle', 'The End']);
      const durations = audio.tracks.map((tr) => tr.durationMs);
      for (const ms of durations) {
        expect(ms).toBeGreaterThan(7500);
        expect(ms).toBeLessThan(8500);
      }
      expect(audio.geometry).toEqual({ kind: 'audio', trackDurationsMs: durations });
      expect(audio.durationMs).toBe(durations.reduce((a, b) => a + b, 0));
      expect(audio.tracks.map((tr) => [tr.index, tr.url, tr.mime, tr.chapter])).toEqual([0, 1, 2].map((i) => [i, `/media/editions/${audio.id}/tracks/${i}`, 'audio/mpeg', i]));
      expect(audio.units).toEqual([
        { title: 'The Beginning', m: 0 },
        { title: 'The Middle', m: durations[0] },
        { title: 'The End', m: durations[0]! + durations[1]! },
      ]);
      expect(book.chapters.map((c) => c.title)).toEqual(['The Beginning', 'The Middle', 'The End']);
      expect(metaOf(audio.id)).toMatchObject({ album: 'The Synthetic Tale', artist: 'Ada Tone' });
    });

    it('takes the cover from the picture embedded in the first track', async () => {
      const book = await bookDetail(owner, synthId);
      expect(book.hasCover).toBe(true);
      const meta = await sharp(readFileSync(blobFile(coverBlobOf(synthId)!))).metadata();
      // The embedded APIC picture is a 300×300 JPEG.
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 300, 300]);
    });

    it('takes the cover from the folder image when the tracks have none', async () => {
      const book = BookDetailSchema.parse(await bookDetail(ana, anasAliceId));
      expect(book.hasCover).toBe(true);
      const meta = await sharp(readFileSync(blobFile(coverBlobOf(anasAliceId)!))).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 240, 240]);
      // LibriVox tag titles ("wonderland_ch_01") become readable track names.
      expect(editionOf(book, 'audio').tracks.map((tr) => tr.title)).toEqual(Array.from({ length: 12 }, (_, i) => `Chapter ${i + 1}`));
      expect(editionOf(book, 'audio').alignment.method).toBe('reference');
    });
  });

  it('a single-file audiobook with chapters inside (M4B) gets one unit per chapter, lined up with the book’s', async () => {
    const m4b = fileFrom(path.join(FIXTURES, 'audio/m4b/tale-in-three-chapters.m4b'), 'track', 'audio/mp4');
    // A text with three chapters of its own, then the audiobook as its other format.
    const epub = makeEpub(['<h1>Chapter One</h1><p>It starts.</p>', '<h1>Chapter Two</h1><p>It goes on.</p>', '<h1>Chapter Three</h1><p>It ends.</p>']);
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf('tale.epub', epub, 'main', 'application/epub+zip')], { title: 'A Tale in Three Chapters', author: 'Ada Tone' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', [m4b], { title: 'A Tale in Three Chapters', author: 'Ada Tone', bookId });
    await t.settle();
    const audio = editionOf(await bookDetail(owner, bookId), 'audio');
    expect(audio.status).toBe('ready');
    expect(audio.tracks).toHaveLength(1);
    expect(audio.units.map((u) => [u.title, u.m])).toEqual([
      ['Chapter One: The Start', 0],
      ['Chapter Two: The Middle', 4000],
      ['Chapter Three: The End', 8000],
    ]);
    // Each chapter of the file starts the matching chapter of the book.
    expect(audio.alignment.unitToChapter).toEqual([0, 1, 2]);
    // The text's contents only number its chapters ("Chapter 1"): the book takes the file's names for them.
    expect((await bookDetail(owner, bookId)).chapters.map((c) => c.title)).toEqual(['Chapter One: The Start', 'Chapter Two: The Middle', 'Chapter Three: The End']);
  });

  it('what members see of a track’s tags is cut to size, without control or bidirectional characters', async () => {
    const ch = (code: number) => String.fromCharCode(code);
    const mp3 = mp3With(
      [textFrame('TIT2', `Night${ch(0x202e)}gnp.exe${ch(1)}${'!'.repeat(6_000_000)}`), textFrame('TPE1', `Ann${ch(0x1b)}${ch(0x2066)} Teller`), textFrame('TALB', `Tales${ch(0x7f)}`)],
      path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3'),
    );
    const { bookId, editionId } = await uploadBook(owner, club.id, 'audio', [fileOf('night.mp3', mp3, 'track', 'audio/mpeg')], { title: 'Night', author: '' });
    await t.settle();
    const audio = editionOf(await bookDetail(owner, bookId), 'audio');
    expect(audio.tracks[0]!.title).toBe(`Nightgnp.exe${'!'.repeat(288)}`);
    expect(audio.units).toEqual([{ title: audio.tracks[0]!.title, m: 0 }]);
    expect(metaOf(editionId)).toMatchObject({ artist: 'Ann Teller', album: 'Tales' });
  });

  describe('audio files made to cost the server', () => {
    let ownerId: string;
    beforeAll(async () => {
      ownerId = (await owner.json<{ user: { id: string } }>(owner.get('/api/me'), 200)).user.id;
    });

    /** An audiobook of these files, recorded as a finished upload is, but not read yet. */
    const recordAudiobook = async (title: string, files: readonly { name: string; bytes: Uint8Array }[]) => {
      const book = createBook(t.ctx.db, { clubId: club.id, title, author: '', createdBy: ownerId });
      const edition = createEdition(t.ctx.db, { bookId: book.id, kind: 'audio', createdBy: ownerId, sizeBytes: files.reduce((n, f) => n + f.bytes.byteLength, 0) });
      for (const [idx, f] of files.entries()) {
        const stored = await t.ctx.storage.putBytes(f.bytes);
        insertBlob(t.ctx.db, { id: stored.id, sha256: stored.sha256, size: stored.size, mime: 'audio/mp4' });
        addEditionFile(t.ctx.db, { edition_id: edition.id, idx, blob_id: stored.id, role: 'track', original_name: f.name });
      }
      return { bookId: book.id, editionId: edition.id };
    };

    it('an M4B made to keep the chapter reader busy for seconds is read without its chapters, the server answering all along', async () => {
      // A million audio chunks, walked once for each of a thousand chapters (8 s on the server's own thread).
      const { bookId, editionId } = await recordAudiobook('Busy', [{ name: 'busy.m4b', bytes: craftM4b({ chunks: 1_000_000, chapters: 1000 }) }]);
      const before = performance.eventLoopUtilization();
      const started = performance.now();
      const ingest = ingestEdition(t.ctx, editionId, { chapterMs: 500 });
      const asked = performance.now();
      expect((await owner.get('/healthz')).statusCode).toBe(200);
      expect(performance.now() - asked).toBeLessThan(500);
      await ingest;
      expect(performance.now() - started).toBeLessThan(6000);
      expect(performance.eventLoopUtilization(before).utilization).toBeLessThan(0.5);
      expect(editionOf(await bookDetail(owner, bookId), 'audio')).toMatchObject({ status: 'ready', durationMs: 128_000_000, units: [{ title: 'Busy', m: 0 }] });
    });

    it('a file that cannot be read in time, even without its chapters, fails the edition, saying which', async () => {
      const { bookId, editionId } = await recordAudiobook('Too slow', [{ name: 'slow.m4b', bytes: craftM4b({ chunks: 1000, chapters: 3 }) }]);
      await ingestEdition(t.ctx, editionId, { chapterMs: 1, readMs: () => 1 });
      const audio = editionOf(await bookDetail(owner, bookId), 'audio');
      expect(audio).toMatchObject({ status: 'failed', error: 'slow.m4b took too long to read.' });
      // Read again in the ordinary time, it is fine.
      await ingestEdition(t.ctx, editionId);
      expect(editionOf(await bookDetail(owner, bookId), 'audio')).toMatchObject({ status: 'ready', error: null });
    });

    it(`chapters marked inside the files make at most ${MAX_EDITION_UNITS} units; past that, every file is one`, async () => {
      // Four hundred and fifty chapters, a second apart, in each file of eight and a half minutes.
      const file = (i: number) => ({ name: `Part ${i + 1}.m4b`, bytes: craftM4b({ chunks: 4000, chapters: 450 }) });
      const four = await recordAudiobook('Four parts', [0, 1, 2, 3].map(file));
      await ingestEdition(t.ctx, four.editionId);
      const fourParts = editionOf(await bookDetail(owner, four.bookId), 'audio');
      expect(fourParts.status).toBe('ready');
      expect(fourParts.units).toHaveLength(1800);
      expect(fourParts.units[450]).toEqual({ title: 'Chapter 0001', m: fourParts.tracks[0]!.durationMs });
      const five = await recordAudiobook('Five parts', [0, 1, 2, 3, 4].map(file));
      await ingestEdition(t.ctx, five.editionId);
      const fiveParts = editionOf(await bookDetail(owner, five.bookId), 'audio');
      expect(fiveParts.status).toBe('ready');
      expect(fiveParts.units.map((u) => u.title)).toEqual(['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5']);
    });

    it('an audiobook whose chapter marks all fall in its first half-minute does not pull a text’s chapters in after them', async () => {
      // Eleven chapters three seconds apart in ten hours: as the first format, the book's chapters all lie in its first 0.1 %.
      const audio = await recordAudiobook('Squeezed', [{ name: 'squeezed.m4b', bytes: craftM4b({ chunks: 281_250, chapters: 11, chapterSeconds: 3 }) }]);
      await ingestEdition(t.ctx, audio.editionId);
      let book = await bookDetail(owner, audio.bookId);
      expect(book.chapters).toHaveLength(11);
      expect(book.chapters.at(-1)!.t).toBeLessThan(0.001);
      // Then the text, eleven chapters of about the same length.
      const sections = Array.from({ length: 11 }, (_, i) => `<h1>Chapter ${i + 1}</h1><p>${'Words of this chapter. '.repeat(40)}</p>`);
      await uploadBook(owner, club.id, 'epub', [fileOf('squeezed.epub', makeEpub(sections), 'main', 'application/epub+zip')], { title: 'Squeezed', author: '', bookId: audio.bookId });
      await t.settle();
      book = await bookDetail(owner, audio.bookId);
      const epub = editionOf(book, 'epub');
      expect(epub.status).toBe('ready');
      // Paired chapter by chapter, the middle of the text would have sat 15 seconds into the
      // audiobook: a listener 16 seconds in would have seen notes from half-way through the book.
      expect(epub.alignment.method).toBe('none');
      const points = epub.sync!.points;
      expect(points).toHaveLength(2);
      expect(mToT(epub.sync!, (points[0]!.m + points[1]!.m) / 2)).toBeCloseTo(0.5, 9);
    });
  });

  describe('EPUBs made to cost the server', () => {
    let ownerId: string;
    beforeAll(async () => {
      ownerId = (await owner.json<{ user: { id: string } }>(owner.get('/api/me'), 200)).user.id;
    });

    /** A book of this EPUB, recorded as a finished upload is, but not read yet. */
    const recordEpub = async (title: string, bytes: Uint8Array) => {
      const book = createBook(t.ctx.db, { clubId: club.id, title, author: '', createdBy: ownerId });
      const edition = createEdition(t.ctx.db, { bookId: book.id, kind: 'epub', createdBy: ownerId, sizeBytes: bytes.byteLength });
      const stored = await t.ctx.storage.putBytes(bytes);
      insertBlob(t.ctx.db, { id: stored.id, sha256: stored.sha256, size: stored.size, mime: 'application/epub+zip' });
      addEditionFile(t.ctx.db, { edition_id: edition.id, idx: 0, blob_id: stored.id, role: 'main', original_name: `${title}.epub` });
      return { bookId: book.id, editionId: edition.id };
    };
    // A chapter of 150,000 short paragraphs: seconds of parsing and sanitising, all of it real work.
    const heavy = () => makeEpub([Array.from({ length: 150_000 }, (_, i) => `<p>w${i % 997} x${(i * 7919) % 10_007}</p>`).join('')]);

    it('one that keeps the parser busy for seconds is read in a worker thread, the server answering all along (D66)', async () => {
      const bytes = heavy();
      // The same book read on this thread, as the server once did: the time it would have held it.
      const inline = performance.now();
      buildPublication(bytes);
      const held = performance.now() - inline;
      expect(held).toBeGreaterThan(300);
      const { bookId, editionId } = await recordEpub('Busy', bytes);
      // The longest the server's thread is kept from anything else while the book is read.
      const delay = monitorEventLoopDelay({ resolution: 10 });
      delay.enable();
      const ingest = ingestEdition(t.ctx, editionId);
      const asked = performance.now();
      expect((await owner.get('/healthz')).statusCode).toBe(200);
      expect(performance.now() - asked).toBeLessThan(Math.min(500, held / 2));
      await ingest;
      delay.disable();
      expect(delay.max / 1e6).toBeLessThan(Math.min(250, held / 2));
      expect(editionOf(await bookDetail(owner, bookId), 'epub')).toMatchObject({ status: 'ready', error: null });
    });

    it('one larger than all a book may unpack to is refused before it is read', async () => {
      const { bookId, editionId } = await recordEpub('Too big', makeEpub(['<p>Small inside.</p>']));
      const blob = t.ctx.db.get<{ blob_id: string }>('SELECT blob_id FROM edition_files WHERE edition_id = ?', [editionId])!.blob_id;
      // Grown on disk past the limit without being written out (a sparse file).
      truncateSync(t.ctx.storage.blobPath(blob), EPUB_LIMITS.maxTotalBytes + 1);
      await ingestEdition(t.ctx, editionId);
      expect(editionOf(await bookDetail(owner, bookId), 'epub')).toMatchObject({ status: 'failed', error: 'This EPUB is larger than 512 MB, more than any book needs.' });
    });

    it('one that cannot be read in time fails the edition, saying so in plain words', async () => {
      const { bookId, editionId } = await recordEpub('Too slow', heavy());
      await ingestEdition(t.ctx, editionId, { epub: { ms: 1, heapMb: 512 } });
      expect(editionOf(await bookDetail(owner, bookId), 'epub')).toMatchObject({ status: 'failed', error: 'This EPUB is too large or too complex to read.' });
      // In its ordinary time it is fine.
      await ingestEdition(t.ctx, editionId);
      expect(editionOf(await bookDetail(owner, bookId), 'epub')).toMatchObject({ status: 'ready', error: null });
    });
  });

  describe('covers that cannot be read', () => {
    /** JPEG magic bytes followed by nothing an image decoder can use. */
    const brokenJpeg = () => {
      const bytes = new Uint8Array(2048);
      bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
      return bytes;
    };

    it('a broken cover image does not stop the upload; the book simply has no cover', async () => {
      const tracks = audioTracks(ALICE_TINY_AUDIO).slice(0, 2);
      const { bookId } = await uploadBook(owner, club.id, 'audio', [...tracks, fileOf('cover.jpg', brokenJpeg(), 'cover', 'image/jpeg')], { title: 'Broken cover', author: '' });
      await t.settle();
      const book = await bookDetail(owner, bookId);
      expect(book.editions[0]!.status).toBe('ready');
      expect(book.hasCover).toBe(false);
      expect((await owner.get(book.coverUrl)).headers.etag).toMatch(/^"gen-/);
    });

    it('an EPUB whose cover picture is broken is still read, without a cover', async () => {
      const bytes = makeEpub(['<p><img src="cover.jpg" alt="Cover"/></p><p>The text after the picture.</p>', '<p>More text.</p>'], {
        extraFiles: { 'OEBPS/cover.jpg': brokenJpeg() },
      });
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf('pictured.epub', bytes, 'main', 'application/epub+zip')], { title: 'Pictured', author: '' });
      await t.settle();
      const book = await bookDetail(owner, bookId);
      expect(book.editions[0]!.status).toBe('ready');
      expect(book.hasCover).toBe(false);
      expect(book.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
    });

    it('a picture found inside a file becomes the cover only if it is a JPEG, PNG, GIF or WebP', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#cc0000"/></svg>';
      const synthetic = path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3');
      // An EPUB whose first page shows an SVG picture, and an MP3 whose tag holds one: sharp would draw both.
      const epub = makeEpub(['<p><img src="cover.svg" alt="Cover"/></p><p>The text after the picture.</p>'], { extraFiles: { 'OEBPS/cover.svg': svg } });
      const svgBooks = [
        (await uploadBook(owner, club.id, 'epub', [fileOf('svg-cover.epub', epub, 'main', 'application/epub+zip')], { title: 'SVG cover', author: '' })).bookId,
        (await uploadBook(owner, club.id, 'audio', [fileOf('svg-picture.mp3', mp3With([pictureFrame('image/svg+xml', new TextEncoder().encode(svg))], synthetic), 'track', 'audio/mpeg')], { title: 'SVG picture', author: '' })).bookId,
      ];
      // The same picture as a PNG is taken.
      const png = new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
      const pngBook = (await uploadBook(owner, club.id, 'audio', [fileOf('png-picture.mp3', mp3With([pictureFrame('image/png', png)], synthetic), 'track', 'audio/mpeg')], { title: 'PNG picture', author: '' })).bookId;
      await t.settle();
      for (const bookId of svgBooks) {
        const book = await bookDetail(owner, bookId);
        expect(book.editions[0]!.status, book.title).toBe('ready');
        expect(book.hasCover, book.title).toBe(false);
      }
      expect((await bookDetail(owner, pngBook)).hasCover).toBe(true);
      const meta = await sharp(readFileSync(blobFile(coverBlobOf(pngBook)!))).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 300, 450]);
    });
  });

  describe('audiobook added to the EPUB’s book', () => {
    it('joins the book as a second format, each track aligned to its CHAPTER by number', async () => {
      const book = BookDetailSchema.parse(await bookDetail(owner, aliceId));
      expect(book.editions.map((e) => e.kind)).toEqual(['epub', 'audio']);
      expect(book.kinds).toEqual(['epub', 'audio']);
      const epub = editionOf(book, 'epub');
      const audio = editionOf(book, 'audio');
      expect(book.referenceEditionId).toBe(epub.id);
      expect(book.chapters).toHaveLength(15);
      expect(audio.status).toBe('ready');
      expect(audio.alignment.method).toBe('number');
      const chapterIndexOf = (k: number) => book.chapters.findIndex((c) => c.title.startsWith(`CHAPTER ${intToRoman(k + 1).toUpperCase()}. `));
      const expected = Array.from({ length: 12 }, (_, k) => chapterIndexOf(k));
      expect(expected.every((i) => i >= 3)).toBe(true);
      expect(audio.alignment.unitToChapter).toEqual(expected);
      expect(audio.tracks.map((tr) => tr.chapter)).toEqual(expected);
    });

    it('its sync map puts the start of track k at the start of CHAPTER k', async () => {
      const book = await bookDetail(owner, aliceId);
      const audio = editionOf(book, 'audio');
      expect(isValidSyncMap(audio.sync!)).toBe(true);
      let start = 0;
      for (const [k, track] of audio.tracks.entries()) {
        const chapter = book.chapters[audio.alignment.unitToChapter[k]!]!;
        expect(chapter.title.startsWith(`CHAPTER ${intToRoman(k + 1).toUpperCase()}. `)).toBe(true);
        expect(mToT(audio.sync!, start), `track ${k}`).toBeCloseTo(chapter.t, 9);
        start += track.durationMs;
      }
      expect(mToT(audio.sync!, start)).toBe(1);
      // So the first page of chapter V in the EPUB is the first second of track 5.
      const epub = editionOf(book, 'epub');
      const chapterFive = (await owner.json<Publication>(owner.get(epub.publicationUrl!), 200)).toc.find((e) => e.title.startsWith('CHAPTER V.'))!;
      const heard = translateLocator(timelineOf(epub), timelineOf(audio), { kind: 'epub', section: chapterFive.section, offset: chapterFive.offset });
      expect(heard).toMatchObject({ kind: 'audio', track: 4 });
      expect((heard as { ms: number }).ms).toBeLessThan(1);
    });

    it('an uploaded cover never replaces the cover the book already has', () => {
      expect(coverBlobOf(aliceId)).toBe(aliceCoverBlob);
    });
  });

  describe('a book whose first format has no chapters', () => {
    it('learns its chapters from a later format, without moving the reference', async () => {
      const blank = fileOf('blank.pdf', makePdf(4, { title: 'Blank (Pages)', author: 'Nobody' }), 'main', 'application/pdf');
      const { bookId, editionId } = await uploadBook(owner, club.id, 'pdf', [blank], { title: 'Blank Pages', author: 'Nobody' });
      await t.settle();
      let book = await bookDetail(owner, bookId);
      expect(book.chapters).toEqual([]);
      expect(editionOf(book, 'pdf')).toMatchObject({ status: 'ready', pageCount: 4, units: [] });
      expect(metaOf(editionId)).toMatchObject({ title: 'Blank (Pages)', author: 'Nobody' });

      await uploadBook(owner, club.id, 'audio', audioTracks(SYNTHETIC_AUDIO), { title: 'Blank Pages', author: 'Nobody', bookId });
      await t.settle();
      book = BookDetailSchema.parse(await bookDetail(owner, bookId));
      expect(book.referenceEditionId).toBe(editionId);
      expect(book.chapters.map((c) => [c.index, c.title])).toEqual([
        [0, 'The Beginning'],
        [1, 'The Middle'],
        [2, 'The End'],
      ]);
      expect(editionOf(book, 'audio').alignment.method).toBe('none');
    });
  });

  describe('a book whose first format names its chapters only by number', () => {
    let bookId: string;
    let audioId: string;
    let epubId: string;
    /** A little way into the third track. */
    const here = { kind: 'audio', track: 2, ms: 2500 } as const;
    const myProgress = async (c: Client, id: string) => BookProgressSchema.parse(await c.json(c.get(`/api/books/${id}/progress`), 200)).mine!;

    it('takes the names of the text added later, moving nothing on the timeline', async () => {
      // The LibriVox-shaped folder first: its chapters are named after its files.
      ({ bookId, editionId: audioId } = await uploadBook(owner, club.id, 'audio', audioTracks(ALICE_TINY_AUDIO), { title: 'Heard First', author: 'Lewis Carroll' }));
      await t.settle();
      let book = BookDetailSchema.parse(await bookDetail(owner, bookId));
      const numbered = book.chapters;
      expect(numbered.map((c) => c.title)).toEqual(Array.from({ length: 12 }, (_, i) => `Chapter ${i + 1}`));
      const audio = editionOf(book, 'audio');
      // Ana has heard a little of track 3, and left a note there.
      await ana.json(ana.put(`/api/books/${bookId}/progress`, { editionId: audioId, locator: here, readSpans: [{ from: { kind: 'audio', track: 0, ms: 0 }, to: here }], at: Date.now() }), 200);
      const place = await myProgress(ana, bookId);
      const note = await ana.json<{ id: string; t: number }>(ana.post(`/api/books/${bookId}/comments`, { editionId: audioId, locator: here, text: 'The Dodo runs a race.' }), 201);

      ({ editionId: epubId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Heard First', author: 'Lewis Carroll', bookId }));
      await t.settle();
      book = BookDetailSchema.parse(await bookDetail(owner, bookId));
      const epub = editionOf(book, 'epub');
      expect(epub.status).toBe('ready');
      expect(book.referenceEditionId).toBe(audioId);
      // Each CHAPTER of the text starts the chapter of its number.
      expect(epub.alignment).toEqual({ method: 'number', unitToChapter: [null, null, null, ...Array.from({ length: 12 }, (_, i) => i), null] });
      const real = epub.units.filter((u) => u.title.startsWith('CHAPTER ')).map((u) => u.title);
      expect(real).toHaveLength(12);
      expect(book.chapters.map((c) => c.title)).toEqual(real);
      expect(book.chapters[2]!.title).toBe('CHAPTER III. A Caucus-Race and a Long Tale');
      // Nothing moved: the chapters' places, the audiobook's map, Ana's place and her note.
      expect(book.chapters.map((c) => [c.index, c.t])).toEqual(numbered.map((c) => [c.index, c.t]));
      expect(editionOf(book, 'audio').sync).toEqual(audio.sync);
      const now = await myProgress(ana, bookId);
      expect(now.t).toBe(place.t);
      expect(now.label).toBe(place.label);
      const notes = await ana.json<{ id: string; t: number }[]>(ana.get(`/api/books/${bookId}/comments`), 200);
      expect(notes.find((c) => c.id === note.id)!.t).toBe(note.t);
      // The player names each track after its chapter (apps/web/src/player/tracks.ts): the text's names now.
      expect(editionOf(book, 'audio').tracks.map((tr) => book.chapters[tr.chapter!]!.title)).toEqual(real);
    });

    it('keeps them when either format is read again', async () => {
      const named = (await bookDetail(owner, bookId)).chapters;
      await ingestEdition(t.ctx, epubId);
      expect((await bookDetail(owner, bookId)).chapters).toEqual(named);
      await ingestEdition(t.ctx, audioId);
      expect((await bookDetail(owner, bookId)).chapters).toEqual(named);
    });

    it('never trades a real name for another format’s', async () => {
      const named = (await bookDetail(owner, bookId)).chapters;
      // A PDF whose outline names every chapter its own way, one a page.
      const outline = named.map((_, i) => ({ title: `Chapter ${i + 1}: Somewhere Else`, page: i, top: 450 }));
      const pdf = fileOf('elsewhere.pdf', makePdf(12, { title: 'Heard First', author: 'Lewis Carroll' }, outline), 'main', 'application/pdf');
      await uploadBook(owner, club.id, 'pdf', [pdf], { title: 'Heard First', author: 'Lewis Carroll', bookId });
      await t.settle();
      const book = await bookDetail(owner, bookId);
      expect(editionOf(book, 'pdf')).toMatchObject({ status: 'ready', alignment: { method: 'count', unitToChapter: Array.from({ length: 12 }, (_, i) => i) } });
      expect(book.chapters).toEqual(named);
    });

    it('keeps them when the other formats go and the audiobook is read again', async () => {
      const book = await bookDetail(owner, bookId);
      for (const e of book.editions.filter((x) => x.kind !== 'audio')) expect((await owner.delete(`/api/editions/${e.id}`)).statusCode).toBe(204);
      await t.settle();
      await ingestEdition(t.ctx, audioId);
      const after = await bookDetail(owner, bookId);
      expect(after.editions.map((e) => [e.kind, e.alignment.method])).toEqual([['audio', 'reference']]);
      expect(after.chapters).toEqual(book.chapters);
    });

    it('saved places are called after the names learned', async () => {
      // Tracks the upload named by their numbers alone, "01" to "12": a chapter so named is called
      // "Chapter 3 · …" already, and keeps that name once it learns its title. ("Track 03" would
      // number a track, not a chapter: D73, parts.test.ts.)
      const trackTitles = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
      const tracked = await uploadBook(owner, club.id, 'audio', audioTracks(ALICE_TINY_AUDIO), { title: 'Heard by Number', author: 'Lewis Carroll', trackTitles });
      await t.settle();
      expect((await bookDetail(owner, tracked.bookId)).chapters.map((c) => c.title)).toEqual(trackTitles);
      await ana.json(ana.put(`/api/books/${tracked.bookId}/progress`, { editionId: tracked.editionId, locator: here, readSpans: [], at: Date.now() }), 200);
      const before = await myProgress(ana, tracked.bookId);
      expect(before.label).toMatch(/^Chapter 3 · /);
      await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Heard by Number', author: 'Lewis Carroll', bookId: tracked.bookId });
      await t.settle();
      const book = await bookDetail(owner, tracked.bookId);
      expect(book.chapters[2]!.title).toBe('CHAPTER III. A Caucus-Race and a Long Tale');
      const after = await myProgress(ana, tracked.bookId);
      expect(after.t).toBe(before.t);
      expect(after.label).toBe(chapterLabel(book.chapters, after.t));
      expect(after.label).toMatch(/^Chapter 3 · /);
    });
  });

  describe('contents too long to keep whole', () => {
    /** An EPUB of these sections (each a list of chapter headings with ids) and this table of contents. */
    const epubWith = (sections: readonly string[][], navList: string) => {
      const xhtml = (body: string) =>
        `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>Contents</title></head><body>${body}</body></html>`;
      const files: Record<string, string> = {
        mimetype: 'application/epub+zip',
        'META-INF/container.xml':
          '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'OEBPS/content.opf':
          '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:test:contents</dc:identifier><dc:title>Contents</dc:title><dc:language>en</dc:language></metadata>' +
          `<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${sections.map((_, s) => `<item id="s${s}" href="s${s}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest>` +
          `<spine>${sections.map((_, s) => `<itemref idref="s${s}"/>`).join('')}</spine></package>`,
        'OEBPS/nav.xhtml': xhtml(`<nav epub:type="toc"><ol>${navList}</ol></nav>`),
      };
      sections.forEach((headings, s) => {
        files[`OEBPS/s${s}.xhtml`] = xhtml(headings.map((h, c) => `<h2 id="c${c}">${h}</h2><p>The text of ${h}.</p>`).join(''));
      });
      return makeZip(files);
    };
    const ingested = async (name: string, bytes: Uint8Array) => {
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf(name, bytes, 'main', 'application/epub+zip')], { title: name, author: '' });
      await t.settle();
      const epub = editionOf(await bookDetail(owner, bookId), 'epub');
      expect(epub.status).toBe('ready');
      return { units: epub.units, publication: PublicationSchema.parse(await owner.json(owner.get(epub.publicationUrl!), 200)) };
    };

    it(`keep their shallower levels, as many as fit in ${MAX_EDITION_UNITS} units, then lose their tail`, async () => {
      // Thirty parts of seventy chapters: 2130 entries. The parts are kept, tidied.
      const rlo = String.fromCharCode(0x202e);
      const parts = Array.from({ length: 30 }, (_, p) => Array.from({ length: 70 }, (_, c) => `Chapter ${p * 70 + c + 1}`));
      const nested = parts.map((chapters, p) => `<li><a href="s${p}.xhtml">Part${rlo} ${p + 1}</a><ol>${chapters.map((title, c) => `<li><a href="s${p}.xhtml#c${c}">${title}</a></li>`).join('')}</ol></li>`).join('');
      const { units: kept, publication } = await ingested('parts.epub', epubWith(parts, nested));
      expect(kept.map((u) => u.title)).toEqual(Array.from({ length: 30 }, (_, p) => `Part ${p + 1}`));
      // The reader's contents keep every entry, tidied the same way.
      expect(publication.toc).toHaveLength(2130);
      expect(publication.toc[0]!.title).toBe('Part 1');
      // 2100 chapters side by side: the first 2000.
      const chapters = Array.from({ length: 2100 }, (_, c) => `Chapter ${c + 1}`);
      const { units: flat } = await ingested('chapters.epub', epubWith([chapters], chapters.map((title, c) => `<li><a href="s0.xhtml#c${c}">${title}</a></li>`).join('')));
      expect(flat).toHaveLength(MAX_EDITION_UNITS);
      expect(flat.at(-1)!.title).toBe(`Chapter ${MAX_EDITION_UNITS}`);
    });
  });

  describe('manual alignment', () => {
    const align = (c: Client, editionId: string, unitToChapter: unknown) => c.put(`/api/editions/${editionId}/alignment`, { unitToChapter });

    it('the uploader re-aligns tracks to chapters by hand', async () => {
      const book = await bookDetail(owner, aliceId);
      const audio = editionOf(book, 'audio');
      const mapping = [3, null, 5, ...Array.from({ length: 9 }, (_, i) => 6 + i)];
      const updated = EditionSchema.parse(await owner.json(align(owner, audio.id, mapping), 200));
      expect(updated.alignment).toEqual({ method: 'manual', unitToChapter: mapping });
      const starts = audio.tracks.map((_, k) => audio.tracks.slice(0, k).reduce((s, tr) => s + tr.durationMs, 0));
      expect(mToT(updated.sync!, starts[0]!)).toBeCloseTo(book.chapters[3]!.t, 9);
      expect(mToT(updated.sync!, starts[2]!)).toBeCloseTo(book.chapters[5]!.t, 9);
      // The unpaired track 2 is interpolated inside chapters I–III.
      const t1 = mToT(updated.sync!, starts[1]!);
      expect(t1).toBeGreaterThan(book.chapters[3]!.t);
      expect(t1).toBeLessThan(book.chapters[5]!.t);
      expect((await bookDetail(owner, aliceId)).editions[1]!.tracks.map((tr) => tr.chapter)).toEqual(mapping);
    });

    it('drops choices that go backwards or point past the last chapter', async () => {
      const audio = editionOf(await bookDetail(owner, aliceId), 'audio');
      // Tracks 2 and 3 placed between chapters I and IV, the rest each with its chapter: a pace a
      // match may have (D77), where only tracks 1 and 4 matched, tracks 5 to 12 crammed into
      // chapter IV, would not.
      const choices = [3, 2, 99, 6, 7, 8, 9, 10, 11, 12, 13, 14];
      const updated = EditionSchema.parse(await owner.json(align(owner, audio.id, choices), 200));
      expect(updated.alignment).toEqual({ method: 'manual', unitToChapter: [3, null, null, ...choices.slice(3)] });
      const none = EditionSchema.parse(await owner.json(align(owner, audio.id, []), 200));
      expect(none.alignment.method).toBe('none');
      expect(none.sync).toEqual(linearSyncMap(0, audio.durationMs!));
    });

    it('refuses a match that would hear a track over far too little of the book, naming it (D77)', async () => {
      const audio = editionOf(await bookDetail(owner, aliceId), 'audio');
      const kept = EditionSchema.parse(await owner.json(align(owner, audio.id, Array.from({ length: 12 }, (_, i) => 3 + i)), 200));
      // Track 3 for chapter XII: it and the nine after it would be heard in that one chapter, track 2 over ten.
      const crammed = await align(owner, audio.id, [3, 4, 14]);
      expect(crammed.statusCode).toBe(400);
      expect(errorOf(crammed).message).toBe(`With these chapters, “${audio.tracks[2]!.title}” would be heard over far too little of the book. Check the chapter each part starts.`);
      // Track 1 for the title page and track 2 for the edition's note: track 1 would pass in 50 characters.
      const squeezed = await align(owner, audio.id, [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(squeezed.statusCode).toBe(400);
      expect(errorOf(squeezed).message).toBe(`With these chapters, “${audio.tracks[0]!.title}” would be heard over far too little of the book. Check the chapter each part starts.`);
      // The match before them stands.
      expect(editionOf(await bookDetail(owner, aliceId), 'audio').alignment).toEqual(kept.alignment);
    });

    it(`takes a choice for each unit an edition may have (${MAX_EDITION_UNITS}, chapters inside its files included), no more`, async () => {
      const audio = editionOf(await bookDetail(owner, aliceId), 'audio');
      const choices = (n: number) => [3, ...Array.from({ length: n - 1 }, () => null)];
      expect(EditionSchema.parse(await owner.json(align(owner, audio.id, choices(MAX_EDITION_UNITS)), 200)).alignment.method).toBe('manual');
      const tooMany = await align(owner, audio.id, choices(MAX_EDITION_UNITS + 1));
      expect(tooMany.statusCode).toBe(400);
    });

    it('is refused for the reference edition, for other members, outsiders and bad input', async () => {
      const book = await bookDetail(owner, aliceId);
      const reference = await align(owner, editionOf(book, 'epub').id, []);
      expect(reference.statusCode).toBe(400);
      expect(errorOf(reference).message).toBe('This edition defines the book’s chapters; there is nothing to align it to.');
      const audio = editionOf(book, 'audio');
      expect((await align(ana, audio.id, [])).statusCode).toBe(403);
      const ozzy = await outsider(t, owner, 'Ozzy');
      expect((await align(ozzy, audio.id, [])).statusCode).toBe(404);
      expect((await align(owner, audio.id, [-1])).statusCode).toBe(400);
      expect((await align(owner, audio.id, 'all of them')).statusCode).toBe(400);
      // Even for the member who added it: an alignment places every friend's notes for everyone.
      const own = fileOf('own.epub', makeEpub(['<p>Ana’s own book.</p>']), 'main', 'application/epub+zip');
      const { editionId: hers } = await uploadBook(ana, club.id, 'epub', [own], { title: 'Ana’s own', author: '' });
      await t.settle();
      const refused = await align(ana, hers, []);
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).message).toBe('Only the club owner can change how a format lines up with the book.');
    });
  });

  describe('failed ingest', () => {
    it('an EPUB that is a valid ZIP without container.xml ends up failed with a readable error', async () => {
      const broken = fileOf('broken.epub', makeEpub(['<p>Text.</p>'], { withoutContainer: true }), 'main', 'application/epub+zip');
      const { bookId, editionId } = await uploadBook(owner, club.id, 'epub', [broken], { title: 'Broken', author: '' });
      await t.settle();
      const book = BookDetailSchema.parse(await bookDetail(owner, bookId));
      expect(book.editions[0]).toMatchObject({
        id: editionId,
        status: 'failed',
        error: 'This file has no META-INF/container.xml, so it is not an EPUB.',
        publicationUrl: null,
      });
      expect(book.editions[0]!.error).not.toContain(t.dir);
      expect(book.kinds).toEqual([]);
      expect(book.hasCover).toBe(false);
      expect((await owner.get(`/api/editions/${editionId}/publication`)).statusCode).toBe(404);
      expect((await owner.get(`/media/editions/${editionId}/epub/OEBPS/s0.xhtml`)).statusCode).toBe(404);
      const progress = await owner.put(`/api/books/${bookId}/progress`, { editionId, locator: { kind: 'epub', section: 0, offset: 0 }, readSpans: [], at: Date.now() });
      expect(progress.statusCode).toBe(400);
      expect(errorOf(progress).message).toBe('That edition is not ready yet.');
      const align = await owner.put(`/api/editions/${editionId}/alignment`, { unitToChapter: [] });
      expect(errorOf(align).message).toBe('That edition is not ready yet.');
    });

    it('an MP3 header with no audio behind it fails', async () => {
      const bytes = new Uint8Array(4096);
      bytes.set(new TextEncoder().encode('ID3'), 0);
      bytes.set([3, 0, 0, 0, 0, 0, 0], 3);
      const { bookId } = await uploadBook(owner, club.id, 'audio', [fileOf('silence.mp3', bytes, 'track', 'audio/mpeg')], { title: 'Silence', author: '' });
      await t.settle();
      const edition = (await bookDetail(owner, bookId)).editions[0]!;
      expect(edition.status).toBe('failed');
      // The parser's own message names the file's path on the server; members must never see that.
      expect(edition.error).toBe('silence.mp3 has no playable audio.');
      expect(edition.error).not.toContain(t.dir);
    });

    it('MPEG frame bytes that hold no audio fail the same way', async () => {
      const { bookId } = await uploadBook(owner, club.id, 'audio', [fileOf('junk.mp3', new Uint8Array([0xff, 0xfb, 1, 2, 3, 4, 5, 6, 7, 8]), 'track', 'audio/mpeg')], {
        title: 'Junk',
        author: '',
      });
      await t.settle();
      expect((await bookDetail(owner, bookId)).editions[0]).toMatchObject({ status: 'failed', error: 'junk.mp3 has no playable audio.' });
    });

    it('a PDF that cannot be parsed fails, saying so in plain words', async () => {
      const { bookId } = await uploadBook(owner, club.id, 'pdf', [fileOf('torn.pdf', '%PDF-1.7\nthis is not really a pdf at all\n', 'main', 'application/pdf')], {
        title: 'Torn',
        author: '',
      });
      await t.settle();
      const edition = (await bookDetail(owner, bookId)).editions[0]!;
      // The parser's own message ("Invalid PDF structure.") goes to the log, not to members.
      expect(edition).toMatchObject({ status: 'failed', error: 'This PDF could not be read.' });
    });

    it('a failure that is not about the book never shows members the server’s paths (SA26)', async () => {
      // A file and a folder of the same name: storing the second fails with a disk error.
      const bytes = makeEpub(['<p>One.</p>'], { extraFiles: { 'OEBPS/a.css': 'p{}', 'OEBPS/a.css/b.css': 'p{}' } });
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf('clash.epub', bytes, 'main', 'application/epub+zip')], { title: 'Clash', author: '' });
      await t.settle();
      const edition = (await bookDetail(owner, bookId)).editions[0]!;
      expect(edition).toMatchObject({ status: 'failed', error: 'This EPUB could not be read.' });
      expect(JSON.stringify(edition)).not.toContain(t.ctx.config.dataDir);
    });
  });

  describe('restarts', () => {
    it('editions interrupted by a restart are ingested again', async () => {
      const audio = editionOf(await bookDetail(owner, synthId), 'audio');
      t.ctx.db.exec("UPDATE editions SET status = 'processing' WHERE id = ?", [audio.id]);
      expect(editionOf(await bookDetail(owner, synthId), 'audio').status).toBe('processing');
      expect(resumeIngest(t.ctx)).toBe(1);
      await t.settle();
      const again = editionOf(await bookDetail(owner, synthId), 'audio');
      expect(again.status).toBe('ready');
      expect(again.tracks.map((tr) => tr.durationMs)).toEqual(audio.tracks.map((tr) => tr.durationMs));
      // An edition deleted in the meantime is simply skipped.
      await expect(ingestEdition(t.ctx, 'vanishedEdition1')).resolves.toBeUndefined();
    });

    it('an edition whose reading stopped the server at every start is put aside, not read for ever', async () => {
      const audio = editionOf(await bookDetail(owner, synthId), 'audio');
      // Started three times and never finished: the server died reading it each time.
      t.ctx.db.exec("UPDATE editions SET status = 'processing', ingest_starts = 3 WHERE id = ?", [audio.id]);
      expect(resumeIngest(t.ctx)).toBe(0);
      expect(editionOf(await bookDetail(owner, synthId), 'audio')).toMatchObject({ status: 'failed', error: 'This file stopped the server each time it was read, so it was put aside.' });
      // Two starts are not yet a pattern: it is read again, and once ready the count starts over.
      t.ctx.db.exec("UPDATE editions SET status = 'processing', ingest_starts = 2 WHERE id = ?", [audio.id]);
      expect(resumeIngest(t.ctx)).toBe(1);
      await t.settle();
      expect(editionOf(await bookDetail(owner, synthId), 'audio').status).toBe('ready');
      expect(t.ctx.db.get<{ ingest_starts: number }>('SELECT ingest_starts FROM editions WHERE id = ?', [audio.id])!.ingest_starts).toBe(0);
    });

    it('a restarted server finishes the ingest it was doing when it stopped', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-restart-'));
      try {
        let editionId = '';
        const before = await makeTestApp({ DATA_DIR: dir });
        try {
          const first = await setupOwner(before);
          ({ editionId } = await uploadBook(first.owner, first.club.id, 'epub', [fileOf('small.epub', makeEpub(['<p>Once upon a time.</p>']), 'main', 'application/epub+zip')], {
            title: 'Small',
            author: '',
          }));
          await before.settle();
          // As if the process had died half-way through the ingest.
          before.ctx.db.exec("UPDATE editions SET status = 'processing' WHERE id = ?", [editionId]);
        } finally {
          await closeApp(before);
        }
        // Booted like the real server: background work (resumed ingest, housekeeping, heartbeats) on.
        const after = await buildApp({ config: loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, LOG_LEVEL: 'silent', SCRYPT_LOG_N: '12' }), logger: false });
        try {
          await after.ctx.jobs.idle();
          expect(after.ctx.db.get<{ status: string }>('SELECT status FROM editions WHERE id = ?', [editionId])?.status).toBe('ready');
        } finally {
          await after.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('book matches', () => {
    const matches = async (title: string, author: string) =>
      (await owner.json<unknown[]>(owner.get(`/api/clubs/${club.id}/book-matches?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}`), 200)).map(
        (m) => BookMatchSchema.parse(m),
      );

    it('finds “Alice’s Adventures in Wonderland” when “Alice in Wonderland” is uploaded', async () => {
      const found: BookMatch[] = await matches('Alice in Wonderland', 'Lewis Carroll');
      const alice = found.find((m) => m.bookId === aliceId);
      expect(alice).toMatchObject({ title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', kinds: ['epub', 'audio'] });
      expect(alice!.score).toBeGreaterThan(0.9);
      expect(found.length).toBeLessThanOrEqual(3);
      expect([...found].sort((a, b) => b.score - a.score)).toEqual(found);
    });

    it('scores a different author lower and ignores unrelated titles', async () => {
      const right = (await matches('Alice in Wonderland', 'Lewis Carroll')).find((m) => m.bookId === aliceId)!;
      const wrong = (await matches('Alice in Wonderland', 'Someone Else')).find((m) => m.bookId === aliceId)!;
      expect(wrong.score).toBeLessThan(right.score);
      expect(await matches('Pride and Prejudice', 'Jane Austen')).toEqual([]);
    });

    it('validates the query and is for members only', async () => {
      expect((await owner.get(`/api/clubs/${club.id}/book-matches?title=Alice`)).statusCode).toBe(400);
      const ozzy = await outsider(t, owner, 'Oscar');
      expect((await ozzy.get(`/api/clubs/${club.id}/book-matches?title=Alice&author=`)).statusCode).toBe(404);
    });
  });

  describe('editing and deleting', () => {
    it('the owner or whoever added a book can edit it; other members cannot', async () => {
      const denied = await ana.patch(`/api/books/${pdfId}`, { title: 'Ana’s now' });
      expect(denied.statusCode).toBe(403);
      expect(errorOf(denied).message).toBe('Only the club owner or whoever added the book can change it.');
      const edited = BookDetailSchema.parse(await owner.json(owner.patch(`/api/books/${pdfId}`, { title: 'Alice, in print', author: 'L. Carroll' }), 200));
      expect(edited).toMatchObject({ title: 'Alice, in print', author: 'L. Carroll' });
      expect(BookDetailSchema.parse(await ana.json(ana.patch(`/api/books/${anasAliceId}`, { author: 'Charles Dodgson' }), 200)).author).toBe('Charles Dodgson');
      expect((await owner.patch(`/api/books/${pdfId}`, { title: '' })).statusCode).toBe(400);
    });

    it('a book whose title or author holds characters XML forbids still gets its drawn cover', async () => {
      const ch = (code: number) => String.fromCharCode(code);
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileOf('plain.epub', makeEpub(['<p>No pictures here.</p>']), 'main', 'application/epub+zip')], { title: 'Plain', author: '' });
      await t.settle();
      await owner.json(owner.patch(`/api/books/${bookId}`, { title: `Odd${ch(1)} One${ch(0x0b)}${ch(0xfffe)}`, author: `Some${ch(2)}one` }), 200);
      const book = await bookDetail(owner, bookId);
      expect(book.hasCover).toBe(false);
      const cover = await owner.get(book.coverUrl);
      expect(cover.statusCode).toBe(200);
      expect(cover.headers['content-type']).toBe('image/webp');
      expect((await sharp(Buffer.from(cover.bytes)).metadata()).format).toBe('webp');
    });

    it('deleting a book removes its files, cover and publication from disk', async () => {
      const { bookId, editionId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Doomed', author: '' });
      await t.settle();
      const fileBlobs = t.ctx.db.all<{ blob_id: string }>('SELECT blob_id FROM edition_files WHERE edition_id = ?', [editionId]).map((r) => r.blob_id);
      const coverBlob = coverBlobOf(bookId)!;
      const paths = [...fileBlobs, coverBlob].map(blobFile);
      const pubDir = t.ctx.storage.pubDir(editionId);
      for (const p of [...paths, pubDir]) expect(existsSync(p), p).toBe(true);

      expect((await ana.delete(`/api/books/${bookId}`)).statusCode).toBe(403);
      expect((await owner.delete(`/api/books/${bookId}`)).statusCode).toBe(204);
      // Removing it keeps its files (D179, recoverable); the admin's purge removes them.
      expect(existsSync(pubDir)).toBe(true);
      await purgeBook(t.ctx, bookId);
      // Its own files go; a file another book also uses (the same EPUB uploaded before) stays.
      expect(existsSync(pubDir)).toBe(false);
      for (const id of [...fileBlobs, coverBlob]) {
        const used = stillUsed(id);
        expect(existsSync(blobFile(id)), blobFile(id)).toBe(used);
        expect(!!t.ctx.db.get('SELECT 1 AS x FROM blobs WHERE id = ?', [id])).toBe(used);
      }
      expect(stillUsed(coverBlob)).toBe(false);
      expect((await owner.get(`/api/books/${bookId}`)).statusCode).toBe(404);
      expect((await owner.json<{ id: string }[]>(owner.get(`/api/clubs/${club.id}/books`), 200)).some((b) => b.id === bookId)).toBe(false);
      expect((await owner.get(`/media/books/${bookId}/cover`)).statusCode).toBe(404);
      expect((await owner.get(`/media/editions/${editionId}/file`)).statusCode).toBe(404);
    });

    it('deleting one format keeps the book and its other formats', async () => {
      const audio = editionOf(await bookDetail(owner, aliceId), 'audio');
      const trackBlobs = t.ctx.db.all<{ blob_id: string }>('SELECT blob_id FROM edition_files WHERE edition_id = ?', [audio.id]).map((r) => r.blob_id);
      expect(trackBlobs).toHaveLength(12);
      expect((await ana.delete(`/api/editions/${audio.id}`)).statusCode).toBe(403);
      expect((await owner.delete(`/api/editions/${audio.id}`)).statusCode).toBe(204);
      for (const id of trackBlobs) expect(existsSync(blobFile(id))).toBe(stillUsed(id));
      const book = await bookDetail(owner, aliceId);
      expect(book.editions.map((e) => e.kind)).toEqual(['epub']);
      expect((await owner.get(`/media/editions/${audio.id}/tracks/0`)).statusCode).toBe(404);
      expect((await owner.get(editionOf(book, 'epub').publicationUrl!)).statusCode).toBe(200);
      expect(existsSync(blobFile(aliceCoverBlob!))).toBe(true);
    });
  });
});
