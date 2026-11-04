import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bodyTextWithBreaks, buildPublication } from '@bookclub/epub';
import {
  type AudioLocator,
  type BookDetail,
  type ClubDetail,
  type CommentView,
  CommentViewSchema,
  type Edition,
  type EpubLocator,
  type Locator,
  NotificationListSchema,
  type PdfLocator,
  ProgressUpdateResultSchema,
  type Transcript,
  mToT,
  textWords,
  tToLocator,
  tToM,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEdition } from '../src/ingest/pipeline';
import { AUDIO_MARGIN_MS, LISTENING_JOIN_MS } from '../src/services/gating';
import { craftM4b } from './crafted-audio';
import {
  ALICE_EPUB,
  ALICE_PDF,
  ALICE_TINY_AUDIO,
  type Client,
  type TestApp,
  audioTracks,
  bookDetail,
  closeApp,
  fileFrom,
  fileOf,
  joinClub,
  makeTestApp,
  openSocket,
  setupOwner,
  uploadBook,
} from './helpers';

/*
 * Spoiler gating across formats. Each edition is lined up with the book's timeline by its sync map,
 * and an audiobook lined up only by chapters places the words inside a chapter by interpolation:
 * up to 44 s from the narration (docs/ALIGNMENT.md). A note opens exactly where its own edition was
 * read past it; reading in another format opens it only once past it by a margin covering that
 * (a minute of audio, a page of a PDF), and with a trusted forced alignment, exactly again.
 */

const pub = buildPublication(new Uint8Array(readFileSync(ALICE_EPUB)));
const sectionText = (i: number) => bodyTextWithBreaks(new TextDecoder().decode(pub.files.get(pub.sections[i]!.path))).text;
const epubAt = (section: number, offset: number): EpubLocator => ({ kind: 'epub', section, offset });
const audioAt = (ms: number, track = 0): AudioLocator => ({ kind: 'audio', track, ms });
const pdfAt = (m: number): PdfLocator => ({ kind: 'pdf', page: Math.floor(m), y: m - Math.floor(m) });
const lineOf = (e: Edition) => ({ geometry: e.geometry!, sync: e.sync! });

/** Twelve chapters of five minutes in one M4B file, as an audiobook a club rips itself. */
const CHAPTER_MS = 300_000;
const m4b = craftM4b({ chunks: (12 * CHAPTER_MS) / 128, chapters: 12, chapterSeconds: CHAPTER_MS / 1000 });

/**
 * What a recogniser would hear in that audiobook: chapter k (EPUB section k + 2) read in its own
 * five minutes, the first half of its words slowly (three minutes) and the rest quickly, so the
 * chapter-level map, which assumes an even pace, puts the middle of each chapter half a minute early.
 */
function unevenNarration(): Transcript {
  const words: [number, number, string][] = [];
  for (let k = 0; k < 12; k++) {
    const text = sectionText(k + 2);
    const said = textWords(text).map((w) => text.slice(w.start, w.end));
    const half = Math.ceil(said.length / 2);
    const start = k * CHAPTER_MS;
    said.forEach((w, i) => {
      const at = i < half ? start + 500 + (i / half) * 179_500 : start + 180_000 + ((i - half) / (said.length - half)) * 119_000;
      words.push([Math.round(at), Math.round(at) + 200, w]);
    });
  }
  return { format: 'bookclub-transcript/1', engine: 'test', tracks: [{ sha256: createHash('sha256').update(m4b).digest('hex'), durationMs: 12 * CHAPTER_MS, words }] };
}

describe('notes across formats', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let book: BookDetail;
  let epub: Edition;
  let audio: Edition;
  /** Ana's notes, one in the text and one in the audiobook, both in the middle of a chapter. */
  let readersNote: CommentView;
  let listenersNote: CommentView;
  /** Where in the audiobook the listener's note is: 200 s into CHAPTER VII. */
  const LISTENERS_MS = 6 * CHAPTER_MS + 200_000;

  const member = async (name: string) => joinClub(t, club, name);
  const idOf = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/me'), 200)).user.id;
  const refresh = async () => {
    book = await bookDetail(owner, book.id);
    epub = book.editions.find((e) => e.kind === 'epub')!;
    audio = book.editions.find((e) => e.kind === 'audio')!;
  };
  const report = async (c: Client, edition: Edition, from: Locator, to: Locator) =>
    ProgressUpdateResultSchema.parse(await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: edition.id, locator: to, readSpans: [{ from, to }], at: Date.now() }), 200));
  /** Listened from `fromMs` to `toMs` of the audiobook; returns the ids of the notes that opened. */
  const hear = async (c: Client, fromMs: number, toMs: number) => (await report(c, audio, audioAt(fromMs), audioAt(toMs))).revealed.map((r) => r.id);
  const read = async (c: Client, from: EpubLocator, to: EpubLocator) => (await report(c, epub, from, to)).revealed.map((r) => r.id);
  const note = async (c: Client, edition: Edition, locator: Locator, text: string) =>
    CommentViewSchema.parse(await c.json(c.post(`/api/books/${book.id}/comments`, { editionId: edition.id, locator, text }), 201));
  const viewOf = async (c: Client, id: string) => (await c.json<CommentView[]>(c.get(`/api/books/${book.id}/comments`), 200)).find((v) => v.id === id)!;
  const isOpen = async (c: Client, id: string) => !(await viewOf(c, id)).hidden;
  /** The moment of the audiobook its map puts at a place of the timeline, and back. */
  const msAt = (t: number) => tToM(audio.sync!, t);
  const tAtMs = (ms: number) => mToT(audio.sync!, ms);
  /** The EPUB's place at t, moved on by some characters. */
  const epubPlace = (t: number, chars = 0) => {
    const place = tToLocator(lineOf(epub), t) as EpubLocator;
    return { ...place, offset: place.offset + chars };
  };
  const chapterStartMs = (n: number) => (n - 1) * CHAPTER_MS;
  const reached = async (c: Client, actorName: string, noteId: string) =>
    NotificationListSchema.parse(await c.json(c.get('/api/notifications'), 200)).items.some((n) => n.kind === 'reached' && n.commentId === noteId && n.actorName === actorName);

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', [fileOf('alice.m4b', m4b, 'track', 'audio/mp4')], { title: 'Alice', author: 'Lewis Carroll', bookId });
    await t.settle();
    book = { id: bookId } as BookDetail;
    await refresh();
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('the audiobook is lined up with the text by its chapters only, the text being the book’s reference', () => {
    expect(book.referenceEditionId).toBe(epub.id);
    expect(audio.alignment.method).toBe('number');
    expect(audio.readAlong).toBeNull();
    // Each five-minute chapter of the file starts the text's chapter of the same number.
    for (const [k, numeral] of ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'].entries()) {
      expect(tAtMs(chapterStartMs(k + 1))).toBe(book.chapters.find((c) => c.title.startsWith(`CHAPTER ${numeral}.`))!.t);
    }
  });

  describe('chapter-level sync: a margin of a minute of listening', () => {
    beforeAll(async () => {
      // In the middle of CHAPTER V (section 6, 13,883 characters).
      readersNote = await note(ana, epub, epubAt(6, 6000), 'The Caterpillar and the hookah');
      listenersNote = await note(ana, audio, audioAt(LISTENERS_MS), 'Twinkle, twinkle, little bat');
    });

    it('a reader’s note stays closed to a listener just past where the map puts it, and opens a minute of audio later', async () => {
      const mapped = msAt(readersNote.t);
      expect(mapped).toBeGreaterThan(chapterStartMs(5) + 60_000);
      expect(mapped).toBeLessThan(chapterStartMs(6) - 70_000);
      const ben = await member('Ben');
      expect(await hear(ben, chapterStartMs(5), mapped + 5000)).not.toContain(readersNote.id);
      // Under the old rule this opened it: Ben's heard range covered the place the map gives.
      const closed = await viewOf(ben, readersNote.id);
      expect(closed).toMatchObject({ hidden: true, hasText: true });
      expect(JSON.stringify(closed)).not.toContain('hookah');
      expect(await hear(ben, mapped + 5000, mapped + AUDIO_MARGIN_MS - 1000)).not.toContain(readersNote.id);
      expect(await isOpen(ben, readersNote.id)).toBe(false);
      // "Ben got to your note" is not sent before he has.
      expect(await reached(ana, 'Ben', readersNote.id)).toBe(false);
      expect(await hear(ben, mapped + AUDIO_MARGIN_MS - 1000, mapped + AUDIO_MARGIN_MS + 1000)).toContain(readersNote.id);
      expect(await viewOf(ben, readersNote.id)).toMatchObject({ hidden: false, text: 'The Caterpillar and the hookah' });
      expect(await reached(ana, 'Ben', readersNote.id)).toBe(true);
    });

    it('and from a minute before it: a listener who started just before that place may have missed it', async () => {
      const mapped = msAt(readersNote.t);
      const cleo = await member('Cleo');
      expect(await hear(cleo, mapped - 30_000, mapped + 120_000)).toEqual([]);
      expect(await isOpen(cleo, readersNote.id)).toBe(false);
      // Going back to hear the minute before it (and so what it may really be part of) opens it.
      expect(await hear(cleo, mapped - AUDIO_MARGIN_MS - 1000, mapped - 30_000)).toContain(readersNote.id);
    });

    it('a chapter’s end is placed exactly: a note in its last minute opens when the chapter has been heard', async () => {
      const late = await note(ana, epub, epubPlace(tAtMs(chapterStartMs(6) - 20_000)), 'Late in chapter V');
      const dee = await member('Dee');
      expect(await hear(dee, chapterStartMs(5), chapterStartMs(6) - 5000)).not.toContain(late.id);
      expect(await hear(dee, chapterStartMs(6) - 5000, chapterStartMs(6))).toContain(late.id);
    });

    it('a chapter’s start is placed exactly too, for a listener who starts it from the track list a moment in', async () => {
      // The player starts a chapter chosen from the track list a few milliseconds into it.
      const early = await note(ana, epub, epubPlace(tAtMs(chapterStartMs(3) + 20_000)), 'Early in chapter III');
      const oona = await member('Oona');
      expect(await hear(oona, chapterStartMs(3) + 7, chapterStartMs(3) + 15_000)).not.toContain(early.id);
      expect(await hear(oona, chapterStartMs(3) + 15_000, chapterStartMs(4))).toContain(early.id);
      // Further into a chapter it is a listener's own start again: the minute before it may hold the note.
      const later = await note(ana, epub, epubPlace(tAtMs(chapterStartMs(4) + 40_000)), 'Later in chapter IV');
      const pip = await member('Pip');
      expect(await hear(pip, chapterStartMs(4) + LISTENING_JOIN_MS + 1000, chapterStartMs(5))).not.toContain(later.id);
    });

    it('a listener’s note opens for another listener exactly at its moment', async () => {
      const eve = await member('Eve');
      expect(await hear(eve, chapterStartMs(7), LISTENERS_MS - 500)).toEqual([]);
      expect(await isOpen(eve, listenersNote.id)).toBe(false);
      expect(await hear(eve, LISTENERS_MS - 500, LISTENERS_MS + 500)).toContain(listenersNote.id);
    });

    it('a listener’s note opens for a reader only past the place a minute of audio after it', async () => {
      const fay = await member('Fay');
      const chapter = epubAt(8, 0); // CHAPTER VII
      expect(await read(fay, chapter, epubPlace(listenersNote.t, 20))).toEqual([]);
      expect(await read(fay, chapter, epubPlace(tAtMs(LISTENERS_MS + AUDIO_MARGIN_MS), -20))).toEqual([]);
      expect(await isOpen(fay, listenersNote.id)).toBe(false);
      expect(await read(fay, chapter, epubPlace(tAtMs(LISTENERS_MS + AUDIO_MARGIN_MS), 20))).toContain(listenersNote.id);
      expect(await viewOf(fay, listenersNote.id)).toMatchObject({ hidden: false, text: 'Twinkle, twinkle, little bat' });
    });

    it('a note opens for a reader exactly where the reader reads it', async () => {
      const gus = await member('Gus');
      expect(await read(gus, epubAt(6, 0), epubAt(6, 5999))).toEqual([]);
      expect(await read(gus, epubAt(6, 5999), epubAt(6, 6001))).toContain(readersNote.id);
    });

    it('a reply follows its note: a marker, and no answering, until the listener is past the margin', async () => {
      const gil = await member('Gil');
      await read(gil, epubAt(6, 0), epubAt(6, 8000));
      const reply = CommentViewSchema.parse(await gil.json(gil.post(`/api/comments/${readersNote.id}/replies`, { text: 'Who are YOU?' }), 201));
      const hal = await member('Hal');
      const mapped = msAt(readersNote.t);
      await hear(hal, chapterStartMs(5), mapped + 5000);
      expect(await viewOf(hal, reply.id)).toMatchObject({ hidden: true });
      expect((await hal.post(`/api/comments/${readersNote.id}/replies`, { text: 'What happens here?' })).statusCode).toBe(403);
      expect(await hear(hal, mapped + 5000, mapped + AUDIO_MARGIN_MS + 1000)).toEqual(expect.arrayContaining([readersNote.id, reply.id]));
      expect(await viewOf(hal, reply.id)).toMatchObject({ hidden: false, text: 'Who are YOU?' });
      expect((await hal.post(`/api/comments/${readersNote.id}/replies`, { text: 'Keep your temper' })).statusCode).toBe(201);
    });

    it('a new note is pushed to each listener as they may read it, with the same margin', async () => {
      const ivy = await member('Ivy');
      const jon = await member('Jon');
      // Ivy has heard CHAPTER VIII to its middle, Jon all of it.
      await hear(ivy, chapterStartMs(8), chapterStartMs(8) + 150_000);
      await hear(jon, chapterStartMs(8), chapterStartMs(9));
      const ivys = await openSocket(t, ivy);
      const jons = await openSocket(t, jon);
      try {
        for (const s of [ivys, jons]) {
          s.send({ type: 'subscribe', clubId: club.id });
          await s.next('presence');
        }
        // Ana writes at the place the map gives 2 minutes into the chapter: 30 s before Ivy's end.
        const croquet = await note(ana, epub, epubPlace(tAtMs(chapterStartMs(8) + 120_000)), 'Flamingos for mallets');
        const forIvy = await ivys.next('comment:new', (m) => m.comment.id === croquet.id);
        const forJon = await jons.next('comment:new', (m) => m.comment.id === croquet.id);
        expect(forIvy.comment).toMatchObject({ hidden: true, hasText: true });
        expect(JSON.stringify(forIvy)).not.toContain('Flamingos');
        expect(forJon.comment).toMatchObject({ hidden: false, text: 'Flamingos for mallets' });
      } finally {
        await ivys.close();
        await jons.close();
      }
    });

    it('reading from before ranges were kept per edition counts as if done in the other format', async () => {
      // Progress saved before migration 008: book-wide ranges only, copied to unplaced_ranges_json.
      const kim = await member('Kim');
      const lee = await member('Lee');
      const legacy = (userId: string, ranges: [number, number][]) =>
        t.ctx.db.exec(
          `INSERT INTO progress (user_id, book_id, edition_id, locator_json, t, label, client_at, read_ranges_json, furthest, coverage, finished_at, unplaced_ranges_json, updated_at)
           VALUES (?, ?, ?, NULL, ?, '', 1, ?, ?, 0, NULL, ?, 1)
           ON CONFLICT (user_id, book_id) DO UPDATE SET read_ranges_json = excluded.read_ranges_json, unplaced_ranges_json = excluded.unplaced_ranges_json`,
          [userId, book.id, epub.id, ranges.at(-1)![1], JSON.stringify(ranges), ranges.at(-1)![1], JSON.stringify(ranges)],
        );
      const kimId = await idOf(kim);
      const leeId = await idOf(lee);
      const c5 = tAtMs(chapterStartMs(5));
      const mapped = msAt(readersNote.t);
      // Read (or heard: nobody knows) from chapter V to just past the reader's note: it might have
      // been the audiobook, whose map can be a minute off there.
      legacy(kimId, [[c5, tAtMs(mapped + 5000)]]);
      expect(await isOpen(kim, readersNote.id)).toBe(false);
      legacy(kimId, [[c5, tAtMs(mapped + AUDIO_MARGIN_MS + 1000)]]);
      expect(await isOpen(kim, readersNote.id)).toBe(true);
      // A listener's note: it might have been the text, read a minute short of where the narrator is.
      const c7 = tAtMs(chapterStartMs(7));
      legacy(leeId, [[c7, tAtMs(LISTENERS_MS + 5000)]]);
      expect(await isOpen(lee, listenersNote.id)).toBe(false);
      legacy(leeId, [[c7, tAtMs(LISTENERS_MS + AUDIO_MARGIN_MS + 1000)]]);
      expect(await isOpen(lee, listenersNote.id)).toBe(true);
      // What they read from now on is placed exactly in its edition.
      expect(await hear(lee, chapterStartMs(9), chapterStartMs(9) + 1000)).toEqual([]);
      const tea = await note(ana, audio, audioAt(chapterStartMs(9) + 500), 'Treacle well');
      expect(await isOpen(lee, tea.id)).toBe(true);
    });
  });

  describe('a trusted forced alignment: exactly related, no margin', () => {
    let chapterMapped: number;

    beforeAll(async () => {
      chapterMapped = msAt(readersNote.t);
      expect((await owner.put(`/api/editions/${audio.id}/transcript`, unevenNarration())).statusCode).toBe(202);
      await t.settle();
      await refresh();
    });

    it('lines the whole audiobook up sentence by sentence', () => {
      expect(audio.alignment.method).toBe('forced');
      expect(audio.readAlong).toMatchObject({ textEditionId: epub.id });
      expect(audio.readAlong!.sentences).toBeGreaterThan(1000);
    });

    it('the narrator reads the reader’s note half a minute after the chapter map put it: the margin was not too wide', () => {
      const narrated = msAt(readersNote.t);
      // The chapter-level reveal (5 s past the map) would have come about 20 s before the narrator got there.
      expect(narrated - chapterMapped).toBeGreaterThan(15_000);
      expect(narrated - chapterMapped).toBeLessThan(AUDIO_MARGIN_MS);
    });

    it('a reader’s note opens for a listener the moment the narrator has read it', async () => {
      const narrated = msAt(readersNote.t);
      const max = await member('Max');
      expect(await hear(max, chapterStartMs(5), narrated - 1500)).not.toContain(readersNote.id);
      expect(await hear(max, narrated - 1500, narrated + 1500)).toContain(readersNote.id);
    });

    it('a listener’s note opens for a reader exactly where the text has it', async () => {
      const heard = await note(ana, audio, audioAt(chapterStartMs(10) + 100_000), 'Soup of the evening');
      const nia = await member('Nia');
      const chapter = epubAt(11, 0); // CHAPTER X
      expect(await read(nia, chapter, epubPlace(heard.t, -20))).toEqual([]);
      expect(await read(nia, chapter, epubPlace(heard.t, 20))).toContain(heard.id);
    });
  });
});

/*
 * A PDF whose text is read is lined up with the EPUB line by line, and its notes are judged with no
 * margin (D75, printed.test.ts). One whose text cannot be (it ran out of time here, as a PDF of
 * scans without a text layer would have none) keeps its chapter map, and the margin of a page.
 */
describe('notes across the EPUB and a PDF lined up by its chapters only: a margin of a page', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let book: BookDetail;
  let epub: Edition;
  let pdf: Edition;
  let people = 0;

  const member = async () => joinClub(t, club, `Reader ${++people}`);
  const report = async (c: Client, edition: Edition, from: Locator, to: Locator) =>
    ProgressUpdateResultSchema.parse(await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: edition.id, locator: to, readSpans: [{ from, to }], at: Date.now() }), 200)).revealed.map((r) => r.id);
  const note = async (c: Client, edition: Edition, locator: Locator, text: string) =>
    CommentViewSchema.parse(await c.json(c.post(`/api/books/${book.id}/comments`, { editionId: edition.id, locator, text }), 201));
  const epubPlace = (t: number, chars: number) => {
    const place = tToLocator(lineOf(epub), t) as EpubLocator;
    return { ...place, offset: place.offset + chars };
  };

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'pdf', [fileFrom(ALICE_PDF, 'main', 'application/pdf')], { title: 'Alice', author: 'Lewis Carroll', bookId });
    await t.settle();
    // Read again without the time to read its text: its outline's chapters only.
    pdf = (await bookDetail(owner, bookId)).editions.find((e) => e.kind === 'pdf')!;
    await ingestEdition(t.ctx, pdf.id, { pdfHeadings: { ms: 1, heapMb: 64 } });
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions.find((e) => e.kind === 'epub')!;
    pdf = book.editions.find((e) => e.kind === 'pdf')!;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('the PDF is lined up by its outline’s chapters', () => {
    expect(pdf.alignment.method).toBe('number');
    expect(pdf.units.find((u) => u.title.startsWith('CHAPTER III.'))!.m).toBe(13);
    expect(pdf.units.find((u) => u.title.startsWith('CHAPTER IV.'))!.m).toBe(19);
  });

  it('a note made in the PDF opens for an EPUB reader only a page past it', async () => {
    const printed = await note(ana, pdf, pdfAt(15.5), 'Mouse’s tale, in print');
    expect(printed.t).toBeCloseTo(mToT(pdf.sync!, 15.5), 12);
    const c = await member();
    const chapter = epubAt(4, 0); // CHAPTER III
    expect(await report(c, epub, chapter, epubPlace(printed.t, 20))).toEqual([]);
    expect(await report(c, epub, chapter, epubPlace(mToT(pdf.sync!, 16.5), -20))).toEqual([]);
    expect(await report(c, epub, chapter, epubPlace(mToT(pdf.sync!, 16.5), 20))).toContain(printed.id);
  });

  it('a note made in the EPUB opens for a PDF reader only a page past it; one made in the PDF, exactly where they read it', async () => {
    const written = await note(ana, epub, epubAt(5, 6000), 'The Rabbit sends in Bill');
    const page = tToM(pdf.sync!, written.t);
    expect(page).toBeGreaterThan(20);
    expect(page).toBeLessThan(25);
    const c = await member();
    expect(await report(c, pdf, pdfAt(19), pdfAt(page + 0.9))).toEqual([]);
    expect(await report(c, pdf, pdfAt(page + 0.9), pdfAt(page + 1.1))).toContain(written.id);
    const inPrint = await note(ana, pdf, pdfAt(page + 0.5), 'Same page');
    const d = await member();
    expect(await report(d, pdf, pdfAt(19), pdfAt(page + 0.49))).toEqual([]);
    expect(await report(d, pdf, pdfAt(page + 0.49), pdfAt(page + 0.51))).toContain(inPrint.id);
  });
});

describe('an audiobook whose tracks a forced alignment trusted only in part', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let book: BookDetail;
  let epub: Edition;
  let audio: Edition;
  let people = 0;

  const member = async () => joinClub(t, club, `Listener ${++people}`);
  const hear = async (c: Client, track: number, fromMs: number, toMs: number) =>
    ProgressUpdateResultSchema.parse(
      await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: audio.id, locator: audioAt(toMs, track), readSpans: [{ from: audioAt(fromMs, track), to: audioAt(toMs, track) }], at: Date.now() }), 200),
    ).revealed.map((r) => r.id);
  const trackMsAt = (t: number) => {
    const at = tToLocator(lineOf(audio), t) as AudioLocator;
    return [at.track, at.ms] as const;
  };

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    const tracks = audioTracks(ALICE_TINY_AUDIO);
    await uploadBook(owner, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId });
    await t.settle();
    book = await bookDetail(owner, bookId);
    audio = book.editions.find((e) => e.kind === 'audio')!;
    // The recogniser heard chapters I to III, each read evenly through its track, and nothing else.
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const transcript: Transcript = {
      format: 'bookclub-transcript/1',
      engine: 'test',
      tracks: audio.tracks.map((tr, k) => {
        const text = sectionText(k + 2);
        const said = k < 3 ? textWords(text).map((w) => text.slice(w.start, w.end)) : [];
        const step = (tr.durationMs - 1000) / Math.max(1, said.length);
        return { sha256: sha(tracks[k]!.bytes), durationMs: tr.durationMs, words: said.map((w, i): [number, number, string] => [Math.round(500 + i * step), Math.round(500 + (i + 0.8) * step), w]) };
      }),
    };
    expect((await owner.put(`/api/editions/${audio.id}/transcript`, transcript)).statusCode).toBe(202);
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions.find((e) => e.kind === 'epub')!;
    audio = book.editions.find((e) => e.kind === 'audio')!;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('in a trusted track a reader’s note opens for a listener exactly where the narrator reads it', async () => {
    expect(audio.alignment.method).toBe('forced');
    const written = CommentViewSchema.parse(await ana.json(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(3, 5000), text: 'Swimming in tears' }), 201));
    const [track, ms] = trackMsAt(written.t);
    expect(track).toBe(1); // CHAPTER II
    const c = await member();
    expect(await hear(c, 1, 0, ms - 50)).toEqual([]);
    expect(await hear(c, 1, ms - 50, ms + 50)).toContain(written.id);
  });

  it('in a track it did not trust the chapter map stays, and so does the margin: here, to the end of the chapter', async () => {
    const written = CommentViewSchema.parse(await ana.json(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(6, 6000), text: 'Advice from a Caterpillar' }), 201));
    const [track, ms] = trackMsAt(written.t);
    expect(track).toBe(4); // CHAPTER V, a few seconds long: a minute of audio is more than all of it
    const c = await member();
    expect(await hear(c, 4, 0, ms + 200)).toEqual([]);
    expect(await hear(c, 4, ms + 200, audio.tracks[4]!.durationMs)).toContain(written.id);
  });
});
