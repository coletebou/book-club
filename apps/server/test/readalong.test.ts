import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bodyTextWithBreaks, buildPublication } from '@bookclub/epub';
import { type BookDetail, type ClubDetail, type Edition, ProgressUpdateResultSchema, type ReadAlongTrack, type Transcript, chapterLabel, intToRoman, locatorToT, textWords } from '@bookclub/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { editionAlignment, editionById } from '../src/repos/books';
import { READ_ALONG_RULES, readAlongFor, transcriptionFor } from '../src/repos/readalong';
import { alignBook, realignOldReadAlongs, resumeTranscriptions, scheduleAlignment, scheduleTranscription } from '../src/services/readalong';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ALICE_EPUB,
  ALICE_TINY_AUDIO,
  type Client,
  type TestApp,
  audioTracks,
  bookDetail,
  closeApp,
  fileFrom,
  joinClub,
  makeTestApp,
  outsider,
  setupOwner,
  uploadBook,
  waitUntil,
} from './helpers';

const pub = buildPublication(new Uint8Array(readFileSync(ALICE_EPUB)));
const decoder = new TextDecoder();
const sectionText = (i: number) => bodyTextWithBreaks(decoder.decode(pub.files.get(pub.sections[i]!.path))).text;
const tracks = audioTracks(ALICE_TINY_AUDIO);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * What a recogniser would write for the tiny tracks: track k reads chapter k (EPUB section k + 2)
 * word by word, evenly over the track. Only the first `chapters` tracks are transcribed.
 */
function transcriptFor(audio: Edition, chapters: number, options: { withHashes?: boolean } = {}): Transcript {
  return {
    format: 'bookclub-transcript/1',
    engine: 'test',
    tracks: audio.tracks.slice(0, options.withHashes === false ? audio.tracks.length : chapters).map((t, k) => {
      const text = sectionText(k + 2);
      const words = k < chapters ? textWords(text).map((w) => text.slice(w.start, w.end)) : [];
      const step = (t.durationMs - 1000) / Math.max(1, words.length);
      return {
        ...(options.withHashes === false ? {} : { sha256: sha256(tracks[k]!.bytes) }),
        durationMs: t.durationMs,
        words: words.map((w, i): [number, number, string] => [Math.round(500 + i * step), Math.round(500 + (i + 0.8) * step), w]),
      };
    }),
  };
}

describe('read-along: an audiobook lined up with its text, sentence by sentence', () => {
  let t: TestApp;
  let owner: Client;
  let ana: Client;
  let club: ClubDetail;
  let book: BookDetail;
  let epub: Edition;
  let audio: Edition;

  const detail = async () => {
    book = await bookDetail(owner, book.id);
    epub = book.editions.find((e) => e.kind === 'epub')!;
    audio = book.editions.find((e) => e.kind === 'audio')!;
    return book;
  };
  const put = (c: Client, body: unknown, editionId = audio.id) => c.put(`/api/editions/${editionId}/transcript`, body);
  const readAlong = (c: Client, track: number) => c.get(`/api/editions/${audio.id}/readalong?track=${track}`);

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId });
    await t.settle();
    book = { id: bookId } as BookDetail;
    await detail();
  });

  afterAll(async () => {
    await closeApp(t);
  });

  let chapterMethod: Edition['alignment']['method'];

  it('starts with chapter-level sync and no read-along', () => {
    chapterMethod = audio.alignment.method;
    // The tracks are matched to the chapters by their numbers (the EPUB's story starts with its
    // title page and contents, so there are more chapters than tracks).
    expect(chapterMethod).toBe('number');
    expect(audio.readAlong).toBeNull();
  });

  it('only the club owner gives an audiobook its transcript, and only a valid one', async () => {
    expect((await put(ana, transcriptFor(audio, 3))).statusCode).toBe(403);
    expect((await put(t.client(), transcriptFor(audio, 3))).statusCode).toBe(401);
    const stranger = await outsider(t, owner, 'Stu');
    expect((await put(stranger, transcriptFor(audio, 3))).statusCode).toBe(404);
    // Who may is decided before the body is read: broken JSON from anyone else is never parsed.
    const raw = (c: Client) => c.request({ method: 'PUT', url: `/api/editions/${audio.id}/transcript`, payload: '{"not json', headers: { 'content-type': 'application/json' } });
    expect((await raw(t.client())).statusCode).toBe(401);
    expect((await raw(ana)).statusCode).toBe(403);
    expect((await raw(owner)).statusCode).toBe(400);
    expect((await ana.delete(`/api/editions/${audio.id}/transcript`)).statusCode).toBe(403);
    expect((await put(owner, { format: 'something else', tracks: [] })).statusCode).toBe(400);
    // Without hashes the tracks must line up one to one, with the same lengths.
    const short = transcriptFor(audio, 3, { withHashes: false });
    expect((await put(owner, { ...short, tracks: short.tracks.slice(1) })).statusCode).toBe(400);
    // Not an audiobook.
    expect((await put(owner, transcriptFor(audio, 3), epub.id)).statusCode).toBe(400);
  });

  it('a note made while listening keeps its moment, and is placed by the sentence once aligned', async () => {
    const before = await ana.json<{ id: string; t: number }>(
      ana.post(`/api/books/${book.id}/comments`, { editionId: audio.id, locator: { kind: 'audio', track: 1, ms: 3000 }, text: 'Her tears!' }),
      201,
    );
    expect((await put(owner, transcriptFor(audio, 3))).statusCode).toBe(202);
    await t.settle();
    await detail();
    expect(audio.alignment.method).toBe('forced');
    // The chapter match stays beneath: the track list still names chapters.
    expect(audio.tracks[0]!.chapter).not.toBeNull();
    expect(audio.readAlong).toMatchObject({ textEditionId: epub.id });
    expect(audio.readAlong!.sentences).toBeGreaterThan(200);
    const comments = await ana.json<{ id: string; t: number }[]>(ana.get(`/api/books/${book.id}/comments`), 200);
    const after = comments.find((c) => c.id === before.id)!;
    expect(after.t).toBeCloseTo(locatorToT({ geometry: audio.geometry!, sync: audio.sync! }, { kind: 'audio', track: 1, ms: 3000 }), 9);
  });

  it('serves each track’s sentences with their place in the text, in order, inside the track', async () => {
    const res = readAlong(ana, 0);
    const track = await ana.json<ReadAlongTrack>(res, 200);
    expect(track).toMatchObject({ audioEditionId: audio.id, textEditionId: epub.id, track: 0 });
    expect(track.sentences.length).toBeGreaterThan(50);
    expect(track.text[0]).toBe('CHAPTER I.');
    expect(track.text.slice(0, 4).join(' ')).toContain('Alice was beginning to get very tired');
    let last = -1;
    for (const [i, [section, offset, length, startMs, endMs]] of track.sentences.entries()) {
      expect(section).toBe(2);
      expect(sectionText(section).slice(offset, offset + length).replace(/\s+/g, ' ').trim()).toBe(track.text[i]);
      expect(startMs).toBeGreaterThan(last);
      expect(endMs).toBeGreaterThanOrEqual(startMs);
      expect(endMs).toBeLessThanOrEqual(audio.tracks[0]!.durationMs);
      last = startMs;
    }
    expect(track.lead).toEqual([track.sentences[0]![0], track.sentences[0]![1]]);
    expect(track.previous).toBeNull();
    expect((await readAlong(ana, 5)).statusCode).toBe(200);
    expect((await ana.json<ReadAlongTrack>(readAlong(ana, 5), 200)).sentences).toEqual([]);
    // A track that reads none of the text still says where the text was left, and where it goes on (D184).
    const third = await ana.json<ReadAlongTrack>(readAlong(ana, 2), 200);
    const silent = await ana.json<ReadAlongTrack>(readAlong(ana, 5), 200);
    const end = third.sentences.at(-1)!;
    expect(silent.previous).toEqual([end[0], end[1] + end[2]]);
    expect(silent.lead).toBeNull(); // nothing read after it: past the text's end
    expect((await readAlong(ana, 99)).statusCode).toBe(404);
    expect((await ana.get(`/api/editions/${audio.id}/readalong`)).statusCode).toBe(404);
  });

  it('measures the text it quotes once: another track is quoted from what was measured', async () => {
    // With the text's files out of reach, track 2 still reads: nothing was read again for it.
    const dir = t.ctx.storage.pubDir(epub.id);
    renameSync(dir, `${dir}.away`);
    try {
      const track = await ana.json<ReadAlongTrack>(readAlong(ana, 2), 200);
      expect(track.sentences.length).toBeGreaterThan(50);
      for (const [i, [section, offset, length]] of track.sentences.entries()) {
        expect(sectionText(section).slice(offset, offset + length).replace(/\s+/g, ' ').trim()).toBe(track.text[i]);
      }
    } finally {
      renameSync(`${dir}.away`, dir);
    }
  });

  it('puts each sentence of the audiobook where the text has it on the timeline', async () => {
    const track = await ana.json<ReadAlongTrack>(readAlong(ana, 2), 200);
    const audioLine = { geometry: audio.geometry!, sync: audio.sync! };
    const textLine = { geometry: epub.geometry!, sync: epub.sync! };
    const total = audio.durationMs!;
    for (const [section, offset, , startMs] of track.sentences) {
      const heard = locatorToT(audioLine, { kind: 'audio', track: 2, ms: startMs });
      const read = locatorToT(textLine, { kind: 'epub', section, offset });
      // Within the map's one-second tolerance (plus rounding), on a timeline of the whole book.
      expect(Math.abs(heard - read)).toBeLessThan(1100 / total);
    }
  });

  it('lines a recording that opens by naming the book up with the story only, never its title page or contents (FR154)', async () => {
    // LibriVox's way: each track says what it is, then the book's title as its title page has it.
    const titlePage = sectionText(1).slice(pub.story.start - 0, pub.toc.find((e) => e.title === 'Contents')!.offset);
    const preamble = ['Chapter', 'one', 'of', ...textWords(titlePage).map((w) => titlePage.slice(w.start, w.end)), 'This', 'is', 'a', 'LibriVox', 'recording.'];
    const doc = transcriptFor(audio, 3);
    // The tiny tracks last seconds: the preamble takes the first fifth of track 1, the chapter the rest.
    const opening = audio.tracks[0]!.durationMs / 5;
    const opened: Transcript = {
      ...doc,
      tracks: doc.tracks.map((track, k) => {
        if (k > 0) return track;
        const step = opening / preamble.length;
        const squeeze = (ms: number) => opening + ((ms - 500) * (track.durationMs - 600 - opening)) / (track.durationMs - 1500);
        const words = [...preamble.map((w, i): [number, number, string] => [i * step, i * step + step * 0.8, w]), ...track.words.map(([a, b, w]): [number, number, string] => [squeeze(a), squeeze(b), w])];
        return { ...track, words };
      }),
    };
    expect((await put(owner, opened)).statusCode).toBe(202);
    await t.settle();
    await detail();
    const first = await ana.json<ReadAlongTrack>(readAlong(ana, 0), 200);
    // At 0:00 there is no sentence yet, and the first is the story's: never the title page (section 1).
    expect(first.text[0]).toBe('CHAPTER I.');
    expect(first.sentences.every(([section]) => section >= 2)).toBe(true);
    expect(first.sentences[0]![3]).toBeGreaterThanOrEqual(opening - 50);
    // Heard at its start, the recording is at the story's first sentence on the timeline, not on its title page.
    const chapterOne = book.chapters.find((c) => c.title.startsWith('CHAPTER I.'))!;
    const atStart = locatorToT({ geometry: audio.geometry!, sync: audio.sync! }, { kind: 'audio', track: 0, ms: 0 });
    expect(atStart).toBeGreaterThanOrEqual(chapterOne.t);
    expect(atStart).toBeCloseTo(chapterOne.t, 4);
  });

  it('outsiders and the signed-out get nothing', async () => {
    const stranger = await outsider(t, owner, 'Sue');
    expect((await readAlong(stranger, 0)).statusCode).toBe(404);
    expect((await readAlong(t.client(), 0)).statusCode).toBe(401);
  });

  it('forgetting the transcript gives the audiobook its chapter map back, and the note moves with it', async () => {
    expect((await owner.delete(`/api/editions/${audio.id}/transcript`)).statusCode).toBe(204);
    await t.settle();
    await detail();
    expect(audio.alignment.method).toBe(chapterMethod);
    expect(audio.readAlong).toBeNull();
    expect((await readAlong(ana, 0)).statusCode).toBe(404);
    const comments = await ana.json<{ text: string | null; t: number }[]>(ana.get(`/api/books/${book.id}/comments`), 200);
    const note = comments.find((c) => c.text === 'Her tears!')!;
    expect(note.t).toBeCloseTo(locatorToT({ geometry: audio.geometry!, sync: audio.sync! }, { kind: 'audio', track: 1, ms: 3000 }), 9);
  });

  it('lines up again when the transcript comes back, and lets go when the text is deleted', async () => {
    expect((await put(owner, transcriptFor(audio, 2))).statusCode).toBe(202);
    await t.settle();
    await detail();
    expect(audio.alignment.method).toBe('forced');
    expect((await owner.delete(`/api/editions/${epub.id}`)).statusCode).toBe(204);
    await t.settle();
    const after = await bookDetail(owner, book.id);
    const left = after.editions.find((e) => e.kind === 'audio')!;
    expect(left.readAlong).toBeNull();
    expect(left.alignment.method).not.toBe('forced');
  });
});

describe('read-along of an audiobook whose tracks hold several chapters (FR152)', () => {
  let t: TestApp;
  let owner: Client;
  let book: BookDetail;
  /** Four tiny tracks, as LibriVox's four-file recordings are cut: each holds three of Alice's chapters. */
  const four = [tracks[2]!, tracks[1]!, tracks[0]!, tracks[3]!].map((f, k) => ({ ...f, name: `alice_${String(3 * k + 1).padStart(2, '0')}-${String(3 * k + 3).padStart(2, '0')}_carroll.mp3` }));
  const titles = ['Chapters 01 to 03', 'Chapters 04 to 06', 'Chapters 07 to 09', 'Chapters 10 to 12'];

  beforeAll(async () => {
    t = await makeTestApp();
    let club: ClubDetail;
    ({ owner, club } = await setupOwner(t));
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', four, { title: 'Alice', author: 'Lewis Carroll', bookId, trackTitles: titles });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('hears where each chapter starts in its track, and says so in the track list’s data', async () => {
    let audio = book.editions.find((e) => e.kind === 'audio')!;
    expect(audio.tracks.map((tr) => tr.title)).toEqual(titles);
    // Before a read-along, nothing is known of the chapters inside a track.
    expect(audio.tracks.every((tr) => tr.chapters === undefined)).toBe(true);
    // The first track reads chapters I to III (EPUB sections 2 to 4), word by word, evenly; the others
    // were heard as nothing (all of it would be more words than seconds of tiny tracks allow).
    const doc: Transcript = {
      format: 'bookclub-transcript/1',
      engine: 'test',
      tracks: audio.tracks.map((tr, k) => {
        const text = k === 0 ? [2, 3, 4].map((section) => sectionText(section)).join('\n') : '';
        const words = textWords(text).map((w) => text.slice(w.start, w.end));
        const step = (tr.durationMs - 1000) / Math.max(1, words.length);
        return { sha256: sha256(four[k]!.bytes), durationMs: tr.durationMs, words: words.map((w, i): [number, number, string] => [500 + i * step, 500 + (i + 0.8) * step, w]) };
      }),
    };
    expect((await owner.put(`/api/editions/${audio.id}/transcript`, doc)).statusCode).toBe(202);
    await t.settle();
    book = await bookDetail(owner, book.id);
    audio = book.editions.find((e) => e.kind === 'audio')!;
    expect(audio.alignment.method).toBe('forced');
    const named = (n: number) => book.chapters.findIndex((c) => c.title.startsWith(`CHAPTER ${intToRoman(n).toUpperCase()}.`));
    const first = audio.tracks[0]!;
    expect(first.chapters!.map((c) => c.chapter)).toEqual([named(1), named(2), named(3)]);
    // In the order they are heard, inside the track, the first at its start.
    const ms = first.chapters!.map((c) => c.ms);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
    expect(ms[0]!).toBeLessThan(600);
    expect(ms[2]!).toBeLessThan(first.durationMs);
    // A track heard as nothing says nothing of the chapters inside it.
    expect(audio.tracks.slice(1).every((tr) => tr.chapters === undefined)).toBe(true);
    // Where the second chapter is heard, the timeline has its start (the sentence-level map).
    const there = locatorToT({ geometry: audio.geometry!, sync: audio.sync! }, { kind: 'audio', track: 0, ms: ms[1]! + 30 });
    expect(chapterLabel(book.chapters, there)).toMatch(/^Chapter 2 · /);
  });
});

describe('read-along of an audiobook that opens with a track of credits (D184)', () => {
  let t: TestApp;
  let owner: Client;
  let book: BookDetail;

  beforeAll(async () => {
    t = await makeTestApp();
    let club: ClubDetail;
    ({ owner, club } = await setupOwner(t));
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    // As a commercial audiobook names its files: its credits first, then its chapters.
    const trackTitles = tracks.map((_, k) => (k === 0 ? 'Opening Credits' : `Chapter ${k}`));
    await uploadBook(owner, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId, trackTitles });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('a track of credits reads no sentence, and says the text begins where the next track takes it up', async () => {
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const credits = 'This recording was made in a small room with a good microphone by someone reading for pleasure'.split(' ');
    const doc: Transcript = {
      format: 'bookclub-transcript/1',
      engine: 'test',
      tracks: audio.tracks.slice(0, 3).map((tr, k) => {
        const text = k === 0 ? null : sectionText(k + 1);
        const words = text ? textWords(text).map((w) => text.slice(w.start, w.end)) : credits;
        const step = (tr.durationMs - 1000) / words.length;
        return { sha256: sha256(tracks[k]!.bytes), durationMs: tr.durationMs, words: words.map((w, i): [number, number, string] => [Math.round(500 + i * step), Math.round(500 + (i + 0.8) * step), w]) };
      }),
    };
    expect((await owner.put(`/api/editions/${audio.id}/transcript`, doc)).statusCode).toBe(202);
    await t.settle();
    const lined = (await bookDetail(owner, book.id)).editions.find((e) => e.kind === 'audio')!;
    expect(lined.alignment.method).toBe('forced');
    const opening = await owner.json<ReadAlongTrack>(owner.get(`/api/editions/${audio.id}/readalong?track=0`), 200);
    const next = await owner.json<ReadAlongTrack>(owner.get(`/api/editions/${audio.id}/readalong?track=1`), 200);
    expect(opening.sentences).toEqual([]);
    expect(next.sentences.length).toBeGreaterThan(10);
    expect(opening.lead).toEqual([next.sentences[0]![0], next.sentences[0]![1]]);
    expect(opening.previous).toBeNull();
    expect(next.text[0]).toBe('CHAPTER I.');
  });
});

describe('read-along of an audiobook numbered its own way: each track named by the chapter it opens with (FR161)', () => {
  let t: TestApp;
  let owner: Client;
  let ana: Client;
  let book: BookDetail;
  // As a recording's own count of its files, which no chapter of the book is matched to (D73): the
  // Time Machine's "06 - Chapter 6" holds its chapter IX; here "Part 1"…"Part 12".
  const titles = tracks.map((_, k) => `Part ${k + 1}`);
  const audioOf = async () => (book = await bookDetail(owner, book.id)).editions.find((e) => e.kind === 'audio')!;
  const named = (n: number) => book.chapters.findIndex((c) => c.title.startsWith(`CHAPTER ${intToRoman(n).toUpperCase()}.`));

  beforeAll(async () => {
    t = await makeTestApp();
    let club: ClubDetail;
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId, trackTitles: titles });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('knows no track’s chapter before; lined up, the chapter each opens with, and none for a track heard as nothing', async () => {
    let audio = await audioOf();
    expect(audio.alignment.method).toBe('none');
    expect(audio.tracks.every((tr) => tr.chapter === null)).toBe(true);
    // The first three tracks read chapters I to III; the others were heard as nothing.
    expect((await owner.put(`/api/editions/${audio.id}/transcript`, transcriptFor(audio, 3))).statusCode).toBe(202);
    await t.settle();
    audio = await audioOf();
    expect(audio.alignment.method).toBe('forced');
    expect(audio.alignment.unitToChapter.every((c) => c === null)).toBe(true);
    expect(audio.tracks.map((tr) => tr.chapter)).toEqual([named(1), named(2), named(3), ...titles.slice(3).map(() => null)]);
    expect(audio.tracks.slice(0, 3).map((tr) => tr.chapters?.map((c) => c.chapter))).toEqual([[named(1)], [named(2)], [named(3)]]);
    expect(audio.tracks.map((tr) => tr.title)).toEqual(titles);
  });

  it('names a place in a track’s opening, before its first sentence, by that track’s chapter, as friends see it', async () => {
    const audio = await audioOf();
    const at = { kind: 'audio' as const, track: 1, ms: 100 };
    const saved = ProgressUpdateResultSchema.parse(await ana.json(ana.put(`/api/books/${book.id}/progress`, { editionId: audio.id, locator: at, readSpans: [{ from: at, to: at }], at: Date.now() }), 200));
    // On the timeline it is still a moment before the chapter's heading, the end of the one before.
    expect(chapterLabel(book.chapters, locatorToT({ geometry: audio.geometry!, sync: audio.sync! }, at))).toMatch(/^Chapter 1 · /);
    expect(saved.mine.label).toMatch(/^Chapter 2 · /);
  });

  it('lines a read-along up again at a start when it was lined up by older rules, once', async () => {
    const audio = await audioOf();
    // As one lined up before the rules were counted: no count in its stats, no track's chapter kept.
    const row = readAlongFor(t.ctx.db, audio.id)!;
    const { rules, ...older } = JSON.parse(row.stats_json) as { rules?: number };
    expect(rules).toBe(READ_ALONG_RULES);
    t.ctx.db.exec('UPDATE readalong SET stats_json = ? WHERE audio_edition_id = ?', [JSON.stringify(older), audio.id]);
    const { opensWith, ...record } = editionAlignment(editionById(t.ctx.db, audio.id)!);
    expect(opensWith).toBeDefined();
    t.ctx.db.exec('UPDATE editions SET alignment_json = ? WHERE id = ?', [JSON.stringify(record), audio.id]);
    expect((await audioOf()).tracks[1]!.chapter).toBeNull();
    expect(realignOldReadAlongs(t.ctx)).toBe(1);
    await t.settle();
    expect((await audioOf()).tracks.map((tr) => tr.chapter).slice(0, 3)).toEqual([named(1), named(2), named(3)]);
    expect((JSON.parse(readAlongFor(t.ctx.db, audio.id)!.stats_json) as { rules?: number }).rules).toBe(READ_ALONG_RULES);
    expect(realignOldReadAlongs(t.ctx)).toBe(0);
  });
});

/** Whether a process is still at work (on Linux, a zombie nobody has reaped yet has ended). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2] !== 'Z';
  } catch {
    return true;
  }
}

describe('read-along from a transcriber the server runs (TRANSCRIBE_COMMAND)', () => {
  const fake = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'fake-transcriber.mjs');
  /** Scratch space outside the source tree (fake recognisers, data kept across a restart). */
  const dirs: string[] = [];
  const scratch = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-transcriber-'));
    dirs.push(dir);
    return dir;
  };
  let t: TestApp;
  let owner: Client;
  let bookId: string;
  let audioId: string;
  const audioOf = async () => (await bookDetail(owner, bookId)).editions.find((e) => e.kind === 'audio')!;

  afterAll(async () => {
    if (t) await closeApp(t);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('transcribes a new audiobook in the background and lines it up, with no one uploading anything', async () => {
    const dir = scratch();
    // The fake recogniser hears chapters I and II (it knows their words) in tracks 1 and 2.
    const heard = [0, 1].map((k) => textWords(sectionText(k + 2)).map((w) => sectionText(k + 2).slice(w.start, w.end)));
    const wordsFile = path.join(dir, 'words.json');
    writeFileSync(wordsFile, JSON.stringify(heard));
    t = await makeTestApp({ TRANSCRIBE_COMMAND: `${process.execPath} ${fake} --words ${wordsFile}` });
    let club: ClubDetail;
    ({ owner, club } = await setupOwner(t));
    ({ bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' }));
    await t.settle();
    await uploadBook(owner, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId });
    await t.settle();
    const audio = await audioOf();
    audioId = audio.id;
    expect(audio.alignment.method).toBe('forced');
    expect(audio.readAlong!.sentences).toBeGreaterThan(100);
    const track = await owner.json<ReadAlongTrack>(owner.get(`/api/editions/${audio.id}/readalong?track=1`), 200);
    expect(track.text[0]).toBe('CHAPTER II.');
    // The scratch file is gone.
    expect(readdirSync(t.ctx.storage.tmpDir).filter((f) => f.startsWith('transcript-'))).toEqual([]);

    // A restart before a transcription finished. A server that died while its recogniser ran
    // leaves the audiobook as it was before (no transcript, chapter-level sync) with that run
    // counted: this puts it back in that state, as removing the transcript would but without the
    // owner's say, which the server keeps to (next test). The server really stopping mid-run is
    // the last test.
    t.ctx.db.exec('DELETE FROM transcripts WHERE edition_id = ?', [audio.id]);
    await alignBook(t.ctx, bookId);
    expect((await audioOf()).readAlong).toBeNull();
    expect(transcriptionFor(t.ctx.db, audio.id)).toMatchObject({ runs: 1, last_error: null, removed_at: null });
    expect(resumeTranscriptions(t.ctx)).toBe(1);
    await t.settle();
    expect((await audioOf()).readAlong!.sentences).toBeGreaterThan(100);
    expect(resumeTranscriptions(t.ctx)).toBe(0);
  });

  it('never transcribes an audiobook again once its owner removed the transcript; the owner can still give it one', async () => {
    expect((await owner.delete(`/api/editions/${audioId}/transcript`)).statusCode).toBe(204);
    await t.settle();
    expect((await audioOf()).readAlong).toBeNull();
    // Neither a start nor a new ingest of the audiobook sends it to the recogniser.
    expect(resumeTranscriptions(t.ctx)).toBe(0);
    expect(scheduleTranscription(t.ctx, editionById(t.ctx.db, audioId)!)).toBe(false);
    expect(t.ctx.slowJobs.pending).toBe(0);
    expect(transcriptionFor(t.ctx.db, audioId)?.removed_at).toEqual(expect.any(Number));
    // What the owner uploads is taken, and lined up.
    expect((await owner.put(`/api/editions/${audioId}/transcript`, transcriptFor(await audioOf(), 2))).statusCode).toBe(202);
    await t.settle();
    expect((await audioOf()).readAlong!.sentences).toBeGreaterThan(100);
    expect(resumeTranscriptions(t.ctx)).toBe(0);
  });

  it('lines a transcribed audiobook up on the alignment queue, together with an alignment of its book waiting there, and the next recogniser waits for it', async () => {
    const dir = scratch();
    const heard = [0, 1].map((k) => textWords(sectionText(k + 2)).map((w) => sectionText(k + 2).slice(w.start, w.end)));
    const wordsFile = path.join(dir, 'words.json');
    writeFileSync(wordsFile, JSON.stringify(heard));
    const app = await makeTestApp({ TRANSCRIBE_COMMAND: `${process.execPath} ${fake} --words ${wordsFile}` });
    const info = vi.spyOn(app.ctx.log, 'info');
    const enqueue = vi.spyOn(app.ctx.jobs, 'enqueue');
    let release = () => {};
    try {
      const aligned = () => info.mock.calls.filter((call) => call[1] === 'audiobook aligned with its text');
      const { owner, club } = await setupOwner(app);
      const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await app.settle();
      await uploadBook(owner, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId });
      // Read, and its recogniser started. The alignment queue is held up meanwhile (a long ingest),
      // with an alignment of the book already waiting there (an edit, say).
      await app.ctx.jobs.idle();
      app.ctx.jobs.enqueue('ingest:long', () => new Promise<void>((resolve) => (release = resolve)));
      scheduleAlignment(app.ctx, bookId);
      const asked = () => enqueue.mock.calls.filter(([name]) => name === `align:${bookId}`).length;
      await waitUntil(() => asked() === 2, 20_000, 'the transcription to ask for its alignment');
      // It took the place of the one waiting; nothing was lined up beside the queue; and the
      // transcription is not done until its book is lined up.
      expect(app.ctx.jobs.pending).toBe(2);
      expect(aligned()).toHaveLength(0);
      expect(app.ctx.slowJobs.pending).toBe(1);
      release();
      await app.settle();
      expect(aligned()).toHaveLength(1);
      const audio = (await bookDetail(owner, bookId)).editions.find((e) => e.kind === 'audio')!;
      expect(audio.readAlong!.sentences).toBeGreaterThan(100);
    } finally {
      release();
      info.mockRestore();
      await closeApp(app);
    }
  });

  it('runs a recogniser that failed once more at a later start, and then no more', async () => {
    const dir = scratch();
    const ran = path.join(dir, 'ran');
    const failing = path.join(dir, 'failing-recogniser.mjs');
    writeFileSync(failing, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], 'ran\\n');\nconsole.error('cannot make sense of this file');\nprocess.exit(3);\n");
    const env = { DATA_DIR: path.join(dir, 'data'), TRANSCRIBE_COMMAND: `${process.execPath} ${failing} ${ran}` };
    const runs = () => readFileSync(ran, 'utf8').trim().split('\n').length;
    let app = await makeTestApp(env);
    try {
      const first = await setupOwner(app);
      const { editionId } = await uploadBook(first.owner, first.club.id, 'audio', tracks.slice(0, 1), { title: 'Unheard', author: '' });
      await app.settle();
      expect(runs()).toBe(1);
      expect(transcriptionFor(app.ctx.db, editionId)).toMatchObject({ runs: 1, last_error: 'transcriber exited with 3: cannot make sense of this file' });
      // The next start tries once more; the one after leaves it alone.
      for (const [queued, total] of [
        [1, 2],
        [0, 2],
      ] as const) {
        await closeApp(app);
        app = await makeTestApp(env);
        expect(resumeTranscriptions(app.ctx)).toBe(queued);
        await app.settle();
        expect(runs()).toBe(total);
      }
      expect(transcriptionFor(app.ctx.db, editionId)).toMatchObject({ runs: 2, last_error: 'transcriber exited with 3: cannot make sense of this file' });
    } finally {
      await closeApp(app);
    }
  });

  it('keeps the real recogniser error when stderr is full of PROGRESS lines', async () => {
    const dir = scratch();
    const failing = path.join(dir, 'progress-then-fail.mjs');
    writeFileSync(
      failing,
      [
        "const doc = JSON.stringify({ format: 'bookclub-transcribe-progress/1', stage: 'transcribing_cpu', tracksDone: 0, tracksTotal: 1 });",
        "console.error('PROGRESS ' + doc);",
        "console.error('cannot make sense of this file');",
        "console.error('PROGRESS ' + doc);",
        'process.exit(3);',
        '',
      ].join('\n'),
    );
    const env = { DATA_DIR: path.join(dir, 'data'), TRANSCRIBE_COMMAND: `${process.execPath} ${failing}` };
    const app = await makeTestApp(env);
    try {
      const first = await setupOwner(app);
      const { editionId } = await uploadBook(first.owner, first.club.id, 'audio', tracks.slice(0, 1), { title: 'Unheard', author: '' });
      await app.settle();
      expect(transcriptionFor(app.ctx.db, editionId)).toMatchObject({
        runs: 1,
        last_error: 'transcriber exited with 3: cannot make sense of this file',
      });
    } finally {
      await closeApp(app);
    }
  });

  it('stops at once with transcriptions queued: the recogniser running stops, with what it started, no other starts, and the next start does them all', async () => {
    const dir = scratch();
    const data = path.join(dir, 'data');
    const started = path.join(dir, 'started');
    // A recogniser that does not finish while the test runs (a minute, so that none outlives a
    // failed one), run the way a wrapper script runs one (`sh -c` without exec): its work is done
    // by a child, which shares its standard error.
    const slow = path.join(dir, 'slow-recogniser.mjs');
    writeFileSync(
      slow,
      [
        "import { spawn } from 'node:child_process';",
        "import { appendFileSync } from 'node:fs';",
        "const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'ignore', 'inherit'] });",
        'appendFileSync(process.argv[2], `${process.pid} ${worker.pid}\\n`);',
        'setTimeout(() => process.exit(1), 60000);',
        '',
      ].join('\n'),
    );
    const before = await makeTestApp({ DATA_DIR: data, TRANSCRIBE_COMMAND: `${process.execPath} ${slow} ${started}` });
    const first = await setupOwner(before);
    for (const title of ['One', 'Two', 'Three']) await uploadBook(first.owner, first.club.id, 'audio', tracks.slice(0, 1), { title, author: 'Lewis Carroll' });
    await before.ctx.jobs.idle();
    await waitUntil(() => existsSync(started), 5000, 'the recogniser to start');
    // One running, two waiting behind it.
    expect(before.ctx.slowJobs.pending).toBe(3);
    const stopping = Date.now();
    await closeApp(before);
    expect(Date.now() - stopping).toBeLessThan(4000);
    // Only one recogniser ever started, and it is gone with its child.
    const lines = readFileSync(started, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const [leader, worker] = lines[0]!.split(' ').map(Number);
    await waitUntil(() => !alive(leader!) && !alive(worker!), 3000, 'the recogniser and its child to end');

    // The next start, with a recogniser that finishes, transcribes all three.
    const wordsFile = path.join(dir, 'words.json');
    writeFileSync(wordsFile, '[]');
    const after = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', DATA_DIR: data, LOG_LEVEL: 'silent', SCRYPT_LOG_N: '12', TRANSCRIBE_COMMAND: `${process.execPath} ${fake} --words ${wordsFile}` }),
      logger: false,
    });
    try {
      expect(after.ctx.slowJobs.pending).toBe(3);
      await after.ctx.slowJobs.idle();
      expect(after.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transcripts')?.n).toBe(3);
      // Each in one run: the one the server stopped was not held against its audiobook.
      expect(after.ctx.db.all('SELECT runs, last_error FROM transcriptions')).toEqual(Array.from({ length: 3 }, () => ({ runs: 1, last_error: null })));
    } finally {
      await after.close();
    }
  });

  it('stops the recogniser when the owner gives the audiobook a transcript as it runs: theirs stands, at once', async () => {
    const dir = scratch();
    const started = path.join(dir, 'started');
    const slow = path.join(dir, 'slow-transcriber.mjs');
    writeFileSync(slow, ["import { appendFileSync } from 'node:fs';", 'appendFileSync(process.argv[2], `${process.pid}\\n`);', 'setTimeout(() => process.exit(1), 60000);', ''].join('\n'));
    const app = await makeTestApp({ TRANSCRIBE_COMMAND: `${process.execPath} ${slow} ${started}` });
    try {
      const { owner: cole, club } = await setupOwner(app);
      const { bookId: book } = await uploadBook(cole, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await app.settle();
      await uploadBook(cole, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId: book });
      await app.ctx.jobs.idle();
      await waitUntil(() => existsSync(started), 5000, 'the recogniser to start');
      const pid = Number(readFileSync(started, 'utf8').trim());
      const audio = (await bookDetail(cole, book)).editions.find((e) => e.kind === 'audio')!;
      const given = Date.now();
      expect((await cole.put(`/api/editions/${audio.id}/transcript`, transcriptFor(audio, 2))).statusCode).toBe(202);
      await waitUntil(() => !alive(pid), 7000, 'the recogniser to stop');
      expect(Date.now() - given).toBeLessThan(7000);
      await app.ctx.slowJobs.idle();
      await app.settle();
      const lined = (await bookDetail(cole, book)).editions.find((e) => e.kind === 'audio')!;
      expect(lined.readAlong?.sentences).toBeGreaterThan(0);
      expect(app.ctx.db.all('SELECT runs, last_error FROM transcriptions')).toEqual([{ runs: 1, last_error: 'stopped: its owner gave it a transcript, or removed it' }]);
    } finally {
      await closeApp(app);
    }
  });

  it('exposes live transcription progress on the book while the recogniser runs', async () => {
    const dir = scratch();
    const started = path.join(dir, 'started');
    const slow = path.join(dir, 'progress-transcriber.mjs');
    writeFileSync(
      slow,
      `import { appendFileSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const marker = process.env.TRANSCRIBE_FAKE_STARTED;
const { values, positionals } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true });
if (marker) appendFileSync(marker, 'go\\n');
const progressFile = process.env.TRANSCRIBE_PROGRESS_FILE;
const writeProgress = (partial) => {
  if (!progressFile) return;
  const doc = {
    format: 'bookclub-transcribe-progress/1', stage: 'transcribing_cpu', engine: 'cpu',
    startedAt: Date.now() / 1000, updatedAt: Date.now() / 1000, tracksTotal: positionals.length,
    audioMsTotal: Number(process.env.TRANSCRIBE_AUDIO_MS_TOTAL || 8000), ...partial,
  };
  writeFileSync(progressFile + '.tmp', JSON.stringify(doc));
  renameSync(progressFile + '.tmp', progressFile);
  console.error('PROGRESS ' + JSON.stringify(doc));
};
writeProgress({ tracksDone: 0, audioMsDone: 0 });
await new Promise((r) => setTimeout(r, 1200));
writeProgress({ tracksDone: 1, audioMsDone: 4000 });
await new Promise((r) => setTimeout(r, 400));
const doc = {
  format: 'bookclub-transcript/1', engine: 'fake',
  tracks: positionals.map((file) => ({
    file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    durationMs: 4000, words: [[0, 500, 'Alice', 0.9]],
  })),
};
writeFileSync(values.out, JSON.stringify(doc));
`,
    );
    process.env.TRANSCRIBE_FAKE_STARTED = started;
    const app = await makeTestApp({ TRANSCRIBE_COMMAND: `${process.execPath} ${slow}` });
    try {
      const { owner: cole, club } = await setupOwner(app);
      const { bookId: book } = await uploadBook(cole, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await app.settle();
      await uploadBook(cole, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll', bookId: book });
      await app.ctx.jobs.idle();
      await waitUntil(() => existsSync(started), 5000, 'the recogniser to start');
      await waitUntil(async () => {
        const audio = (await bookDetail(cole, book)).editions.find((e) => e.kind === 'audio')!;
        return Boolean(audio.transcription);
      }, 5000, 'book detail to show transcription progress');
      const during = (await bookDetail(cole, book)).editions.find((e) => e.kind === 'audio')!;
      expect(during.transcription?.stage).toMatch(/queued|transcribing_cpu|aligning/);
      expect(typeof during.transcription?.tracksTotal).toBe('number');
      expect(during.transcription?.etaMs == null || during.transcription.etaMs >= 0).toBe(true);
      await app.ctx.slowJobs.idle();
      await app.settle();
      const done = (await bookDetail(cole, book)).editions.find((e) => e.kind === 'audio')!;
      expect(done.transcription ?? null).toBeNull();
    } finally {
      delete process.env.TRANSCRIBE_FAKE_STARTED;
      await closeApp(app);
    }
  });

  it('leaves an audiobook longer than TRANSCRIBE_MAX_HOURS to its owner', async () => {
    const dir = scratch();
    const started = path.join(dir, 'started');
    const record = path.join(dir, 'record-transcriber.mjs');
    writeFileSync(record, ["import { appendFileSync } from 'node:fs';", "appendFileSync(process.argv[2], 'ran\\n');", 'process.exit(1);', ''].join('\n'));
    // The tiny tracks last under a minute: a limit of 36 s leaves them out.
    const app = await makeTestApp({ TRANSCRIBE_COMMAND: `${process.execPath} ${record} ${started}`, TRANSCRIBE_MAX_HOURS: '0.01' });
    try {
      const { owner: cole, club } = await setupOwner(app);
      await uploadBook(cole, club.id, 'audio', tracks, { title: 'Alice', author: 'Lewis Carroll' });
      await app.settle();
      await app.ctx.slowJobs.idle();
      expect(existsSync(started)).toBe(false);
      expect(app.ctx.db.all('SELECT edition_id FROM transcriptions')).toEqual([]);
    } finally {
      await closeApp(app);
    }
  });
});
