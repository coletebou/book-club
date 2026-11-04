import path from 'node:path';
import {
  type BookDetail,
  type ClubDetail,
  CommentViewSchema,
  type CommentView,
  type Edition,
  type EditionGeometry,
  type Locator,
  ProgressUpdateResultSchema,
  type Span,
  type TiePoint,
  isValidSyncMap,
  linearSyncMap,
  tToLocator,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toJson } from '../src/lib/json';
import { type AlignmentRecord, type BookRow, type EditionRow } from '../src/repos/books';
import { type Reading } from '../src/repos/progress';
import { AUDIO_MARGIN_MS, LINE_SHARE, Gate, type Gated } from '../src/services/gating';
import { craftM4b, mp3With, textFrame } from './crafted-audio';
import {
  ALICE_EPUB,
  ALICE_TINY_AUDIO,
  SYNTHETIC_AUDIO,
  type Client,
  type TestApp,
  type UploadFile,
  audioTracks,
  bookDetail,
  closeApp,
  fileFrom,
  fileOf,
  joinClub,
  makeTestApp,
  setupOwner,
  uploadBook,
} from './helpers';

/*
 * An audiobook in numbered parts (D73). A fresh reviewer joined the LibriVox Alice and cut it into
 * eight 22-minute files, "Alice - Part 1.mp3" to "Part 8.mp3", and added them to the Alice EPUB:
 * the parts were matched to chapters I to VIII by their numbers, the whole recording ended at the
 * start of chapter IX, a listener in the trial was shown in chapter VIII and his note there opened
 * for a reader who had only reached chapter IX. Parts are not chapters: such an audiobook follows
 * the book in a straight line, keeps its parts' names, and its notes open across formats only some
 * six per cent of the book late (LINE_SHARE, D74; a tenth of it at first, D73), never early.
 */

const pad = (k: number) => String(k).padStart(2, '0');
/** The LibriVox Alice, 2 h 59 min, in this many parts of the same length: crafted M4B files without chapters. */
const LIBRIVOX_MS = 10_732_377;
const m4bParts = (n: number, name: (k: number) => string) => {
  const part = craftM4b({ chunks: Math.round(LIBRIVOX_MS / n / 128), chapters: 1, chapterSeconds: Math.round(LIBRIVOX_MS / n / 1000) });
  return Array.from({ length: n }, (_, i) => fileOf(`${name(i + 1)}.m4b`, part, 'track', 'audio/mp4'));
};
/** Short MP3s of the same length, each tagged with its own title (tags win over file names). */
const mp3Parts = (n: number, file: (k: number) => string, tag: (k: number) => string) =>
  Array.from({ length: n }, (_, i) => fileOf(`${file(i + 1)}.mp3`, mp3With([textFrame('TIT2', tag(i + 1))], path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3')), 'track', 'audio/mpeg'));
const lineOf = (e: Edition) => ({ geometry: e.geometry!, sync: e.sync! });

describe('an audiobook in numbered parts, added to the Alice EPUB (D73)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let people = 0;
  const member = async () => joinClub(t, club, `Reader ${++people}`);

  /** A new book of the Alice EPUB, with these files as its audiobook. */
  const aliceWith = async (tracks: UploadFile[]) => {
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId });
    await t.settle();
    const book = await bookDetail(owner, bookId);
    return { book, epub: book.editions.find((e) => e.kind === 'epub')!, audio: book.editions.find((e) => e.kind === 'audio')! };
  };
  /** An audiobook lined up with the book in a straight line, its tracks keeping their own names. */
  const expectStraightLine = (book: BookDetail, audio: Edition, names: readonly string[]) => {
    expect(audio.status).toBe('ready');
    expect(audio.alignment).toEqual({ method: 'none', unitToChapter: names.map(() => null) });
    expect(audio.sync).toEqual(linearSyncMap(0, audio.durationMs!));
    expect(audio.tracks.map((tr) => [tr.title, tr.chapter])).toEqual(names.map((name) => [name, null]));
    // The book's chapters are the EPUB's, as they were.
    expect(book.chapters.filter((c) => c.title.startsWith('CHAPTER '))).toHaveLength(12);
    expect(book.chapters.some((c) => names.includes(c.title))).toBe(false);
  };

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
  });

  afterAll(async () => {
    await closeApp(t);
  });

  describe('eight parts of 22 minutes, "Alice - Part 1" to "Alice - Part 8"', () => {
    let book: BookDetail;
    let epub: Edition;
    let audio: Edition;
    const report = async (c: Client, edition: Edition, from: Locator, to: Locator) =>
      ProgressUpdateResultSchema.parse(await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: edition.id, locator: to, readSpans: [{ from, to }], at: Date.now() }), 200));
    /** Read in the EPUB from `from` to `to` on the timeline; the ids of the notes that opened. */
    const read = async (c: Client, from: number, to: number) => (await report(c, epub, tToLocator(lineOf(epub), from), tToLocator(lineOf(epub), to))).revealed.map((r) => r.id);
    /** Heard in the audiobook from its start to `to` on the timeline; the ids of the notes that opened. */
    const hear = async (c: Client, to: number) => (await report(c, audio, { kind: 'audio', track: 0, ms: 0 }, tToLocator(lineOf(audio), to))).revealed.map((r) => r.id);
    const note = async (c: Client, edition: Edition, locator: Locator, text: string) =>
      CommentViewSchema.parse(await c.json(c.post(`/api/books/${book.id}/comments`, { editionId: edition.id, locator, text }), 201));
    const isOpen = async (c: Client, id: string) => !(await c.json<CommentView[]>(c.get(`/api/books/${book.id}/comments`), 200)).find((v) => v.id === id)!.hidden;
    const chapterT = (numeral: string) => book.chapters.find((c) => c.title.startsWith(`CHAPTER ${numeral}.`))!.t;

    beforeAll(async () => {
      ({ book, epub, audio } = await aliceWith(m4bParts(8, (k) => `Alice - Part ${k}`)));
    });

    it('is lined up with the book in a straight line, each part keeping its name', () => {
      expect(audio.tracks).toHaveLength(8);
      for (const tr of audio.tracks) expect(Math.abs(tr.durationMs - LIBRIVOX_MS / 8)).toBeLessThan(1000);
      expectStraightLine(book, audio, Array.from({ length: 8 }, (_, i) => `Alice - Part ${i + 1}`));
      expect(isValidSyncMap(audio.sync!)).toBe(true);
    });

    it('a listener ten minutes into the eighth part is in the trial, not in chapter VIII', async () => {
      const place: Locator = { kind: 'audio', track: 7, ms: 600_000 };
      const { mine } = await report(ana, audio, { kind: 'audio', track: 7, ms: 0 }, place);
      expect(mine.t).toBeGreaterThan(chapterT('XII'));
      expect(mine.label).toMatch(/^Chapter 12 · 93%$/);
    });

    it('a listener’s note near the end opens for no reader until the book is read nearly to its end', async () => {
      const trial = await note(ana, audio, { kind: 'audio', track: 7, ms: Math.round(audio.tracks[7]!.durationMs * 0.8) }, 'Off with their heads');
      expect(trial.t).toBeCloseTo(7.8 / 8, 3);
      // Read to the start of chapter IX, where the eight parts used to end: closed.
      const ben = await member();
      expect(await read(ben, 0, chapterT('IX') + 0.001)).toEqual([]);
      expect(await isOpen(ben, trial.id)).toBe(false);
      // Read to chapter XII: still closed.
      const cleo = await member();
      expect(await read(cleo, 0, chapterT('XII') + 0.01)).toEqual([]);
      expect(await isOpen(cleo, trial.id)).toBe(false);
      // A straight line may be a few percent off anywhere (D73): its notes open once six per cent
      // of the book either side of them has been read (D74). Here that is the book's end.
      const dee = await member();
      expect(await read(dee, trial.t - LINE_SHARE + 0.005, 1)).toEqual([]);
      expect(await read(dee, trial.t - LINE_SHARE - 0.005, 1)).toContain(trial.id);
      expect(await isOpen(dee, trial.id)).toBe(true);
    });

    it('a reader’s note reaches a listener six per cent of the book after the straight line puts it, not a minute', async () => {
      // In the middle of CHAPTER VII, by a member who has read nothing further (no horizon holds it, D69).
      const writer = await member();
      const tea = await note(writer, epub, tToLocator(lineOf(epub), (chapterT('VII') + chapterT('VIII')) / 2), 'Why is a raven like a writing-desk?');
      const fay = await member();
      // A minute of listening past where the line puts it would open it from an audiobook lined up by chapters.
      const minute = AUDIO_MARGIN_MS / audio.durationMs!;
      expect(await hear(fay, tea.t + minute + 0.002)).toEqual([]);
      expect(await hear(fay, tea.t + LINE_SHARE - 0.002)).toEqual([]);
      expect(await isOpen(fay, tea.id)).toBe(false);
      expect(await hear(fay, tea.t + LINE_SHARE + 0.002)).toContain(tea.id);
    });

    it('is still the owner’s to match by hand: then it is lined up by chapters again', async () => {
      const chapterOf = (numeral: string) => book.chapters.findIndex((c) => c.title.startsWith(`CHAPTER ${numeral}.`));
      // Parts 1 to 8 start chapters I, II, III, IV, VI, VII, IX and X, as the owner hears them.
      const mapping = ['I', 'II', 'III', 'IV', 'VI', 'VII', 'IX', 'X'].map(chapterOf);
      const updated = await owner.json<Edition>(owner.put(`/api/editions/${audio.id}/alignment`, { unitToChapter: mapping }), 200);
      expect(updated.alignment).toEqual({ method: 'manual', unitToChapter: mapping });
      expect(updated.sync!.points.length).toBeGreaterThan(2);
    });
  });

  it('eight MP3s tagged "Part 1" to "Part 8" keep those names, matched to no chapter', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `Part ${i + 1}`);
    const { book, audio } = await aliceWith(mp3Parts(8, (k) => `Alice - Part ${k}`, (k) => `Part ${k}`));
    expectStraightLine(book, audio, names);
  });

  it('parts numbered like chapters ("Alice 01") are refused by what they span: eight parts 0.68 of the book, two 0.16', async () => {
    for (const n of [8, 2]) {
      const names = Array.from({ length: n }, (_, i) => `Alice ${pad(i + 1)}`);
      const { book, audio } = await aliceWith(mp3Parts(n, (k) => `alice-${k}`, (k) => `Alice ${pad(k)}`));
      expectStraightLine(book, audio, names);
    }
  });

  it('a folder tagged "Track 01" to "Track 12" (a CD’s tracks) first: a text added later is not matched to them by number', async () => {
    const trackTitles = Array.from({ length: 12 }, (_, i) => `Track ${pad(i + 1)}`);
    const { bookId } = await uploadBook(owner, club.id, 'audio', audioTracks(ALICE_TINY_AUDIO), { title: 'Tracks First', author: 'Lewis Carroll', trackTitles });
    await t.settle();
    await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Tracks First', author: 'Lewis Carroll', bookId });
    await t.settle();
    const book = await bookDetail(owner, bookId);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    expect(epub.status).toBe('ready');
    expect(epub.alignment.method).toBe('none');
    expect(book.chapters.map((c) => c.title)).toEqual(trackTitles);
  });
});

describe('the gate on an edition matched to no chapter, or to some of them (D73)', () => {
  // A book of four chapters a quarter long each, its text the reference, and a two-hour audiobook
  // (so that a minute of it, 0.008 of the book, is less than a tenth of any chapter).
  const MIN = 60_000;
  const chapters = ['One', 'Two', 'Three', 'Four'].map((title, i) => ({ index: i, title, t: i / 4 }));
  const book: BookRow = {
    id: 'b',
    club_id: 'c',
    title: 'B',
    author: '',
    cover_blob_id: null,
    reference_edition_id: 'text',
    chapters_json: toJson(chapters),
    created_by: 'u',
    created_at: 0,
  };
  const editionOf = (id: string, geometry: EditionGeometry, points: TiePoint[], units: { title: string; m: number }[], alignment: AlignmentRecord): EditionRow => ({
    id,
    book_id: 'b',
    kind: geometry.kind,
    status: 'ready',
    error: null,
    geometry_json: toJson(geometry),
    units_json: toJson(units),
    sync_json: toJson({ points }),
    alignment_json: toJson(alignment),
    meta_json: '{}',
    size_bytes: 0,
    created_by: 'u',
    created_at: 0,
  });
  const text = editionOf('text', { kind: 'epub', sectionLengths: [10_000, 10_000, 10_000, 10_000] }, [{ m: 0, t: 0 }, { m: 40_000, t: 1 }], chapters.map((c, i) => ({ title: c.title, m: i * 10_000 })), {
    method: 'reference',
    unitToChapter: [0, 1, 2, 3],
  });
  const geometry: EditionGeometry = { kind: 'audio', trackDurationsMs: [30 * MIN, 30 * MIN, 30 * MIN, 30 * MIN] };
  const units = chapters.map((_, i) => ({ title: `Part ${i + 1}`, m: i * 30 * MIN }));
  const line = editionOf('audio', geometry, [{ m: 0, t: 0 }, { m: 120 * MIN, t: 1 }], units, { method: 'none', unitToChapter: [null, null, null, null] });
  // Matched at chapters One and Three only: Two is interpolated with One, Four with Three.
  const someChapters = editionOf('audio', geometry, [{ m: 0, t: 0 }, { m: 60 * MIN, t: 0.5 }, { m: 120 * MIN, t: 1 }], units, { method: 'manual', unitToChapter: [0, null, 2, null] });
  const note = (editionId: string, locator: Locator, t: number): Gated => ({ user_id: 'author', edition_id: editionId, locator_json: toJson(locator), end_locator_json: null, t, end_t: null });
  const TOTALS: Record<string, number> = { text: 40_000, audio: 120 * MIN };
  const read = (byEdition: Record<string, Span[]>): Reading => ({
    byEdition: new Map(Object.entries(byEdition).map(([id, spans]) => [id, spans.map(([a, b]): Span => [a * TOTALS[id]!, b * TOTALS[id]!])])),
    unplaced: [],
  });
  const inText = (offset: number): Locator => ({ kind: 'epub', section: Math.floor(offset / 10_000), offset: offset % 10_000 });
  const opens = (gate: Gate, gated: Gated, reading: Reading) => gate.isOpen(gated, 'viewer', reading);

  it('a straight line is a few per cent of the book off at most: its notes open six per cent of the book late, both ways', () => {
    const gate = new Gate(book, [text, line], []);
    // More than a tenth of a chapter here, and than a minute (D74).
    expect(LINE_SHARE).toBe(0.06);
    // A reader's note at 0.6: a listener has to have heard to 0.66, and from 0.54.
    const written = note('text', inText(24_000), 0.6);
    expect(opens(gate, written, read({ audio: [[0, 0.659]] }))).toBe(false);
    expect(opens(gate, written, read({ audio: [[0, 0.661]] }))).toBe(true);
    expect(opens(gate, written, read({ audio: [[0.541, 0.661]] }))).toBe(false);
    expect(opens(gate, written, read({ audio: [[0.539, 0.661]] }))).toBe(true);
    // A listener's note at 0.6: a reader has to have read from 0.54 to 0.66.
    const heard = note('audio', { kind: 'audio', track: 2, ms: 12 * MIN }, 0.6);
    expect(opens(gate, heard, read({ text: [[0.539, 0.659]] }))).toBe(false);
    expect(opens(gate, heard, read({ text: [[0.541, 0.661]] }))).toBe(false);
    expect(opens(gate, heard, read({ text: [[0.539, 0.661]] }))).toBe(true);
    // Between two listeners of the same audiobook: exactly.
    expect(opens(gate, heard, read({ audio: [[0.5, 0.6001]] }))).toBe(true);
    // At the very end, up to the end.
    const last = note('audio', { kind: 'audio', track: 3, ms: 24 * MIN }, 0.95);
    expect(opens(gate, last, read({ text: [[0.889, 0.999]] }))).toBe(false);
    expect(opens(gate, last, read({ text: [[0.889, 1]] }))).toBe(true);
  });

  it('between chapters matched further apart than one, a tenth of all the stretch it interpolates', () => {
    const gate = new Gate(book, [text, someChapters], []);
    // At 0.375, in chapter Two, which the map interpolates with One: a tenth of [0, 0.5], not of
    // chapter Two alone (that would have opened it at 0.4).
    const written = note('text', inText(15_000), 0.375);
    expect(opens(gate, written, read({ audio: [[0, 0.424]] }))).toBe(false);
    expect(opens(gate, written, read({ audio: [[0, 0.426]] }))).toBe(true);
    // Never past a chapter start it was matched at: Three, at 0.5.
    const late = note('text', inText(19_000), 0.475);
    expect(opens(gate, late, read({ audio: [[0, 0.499]] }))).toBe(false);
    expect(opens(gate, late, read({ audio: [[0, 0.5]] }))).toBe(true);
  });
});
