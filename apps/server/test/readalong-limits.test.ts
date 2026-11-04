import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bodyTextWithBreaks, buildPublication } from '@bookclub/epub';
import { type BookDetail, type ClubDetail, type Edition, type Transcript, formatDuration, linearSyncMap, textWords } from '@bookclub/shared';
import { type FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { hasTranscript, saveTranscript, transcriptionFor } from '../src/repos/readalong';
import { MAX_WORDS_PER_SECOND, SPARE_WORDS, alignText, matchTranscript, readTranscript, wordsAllowed } from '../src/services/align-worker';
import { WorkLimitError, runInWorker } from '../src/services/aligner';
import { Jobs } from '../src/services/jobs';
import { READ_ALONG_LIMITS, TRANSCRIPT_MAX_BYTES, scheduleAlignment, setReadAlongLimits, uploadDeadlineMs } from '../src/services/readalong';
import {
  ALICE_EPUB,
  ALICE_TINY_AUDIO,
  Client,
  type TestApp,
  type ThreadWatch,
  type UploadFile,
  audioTracks,
  bookDetail,
  closeApp,
  fileFrom,
  joinClub,
  makeTestApp,
  rawRequest,
  setupOwner,
  uploadBook,
  waitUntil,
  watchThread,
} from './helpers';

/*
 * A transcript can neither stall the server nor exhaust its memory (REVIEW: a 50 MB transcript
 * lined up on the server's thread stalled every club for 24 s): it is bounded before it is read,
 * read and lined up in worker threads with time and memory limits, uploaded only so often, and a
 * book waiting to be lined up is lined up once.
 */

const pub = buildPublication(new Uint8Array(readFileSync(ALICE_EPUB)));
const decoder = new TextDecoder();
const sectionText = (i: number) => bodyTextWithBreaks(decoder.decode(pub.files.get(pub.sections[i]!.path))).text;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const tiny = audioTracks(ALICE_TINY_AUDIO);

/** Every word of the book, as written, for transcripts that hear them in no order at all. */
const vocabulary = pub.sections.flatMap((_, i) => {
  const text = sectionText(i);
  return textWords(text).map((w) => text.slice(w.start, w.end));
});

/** `n` words of the book in a random order (the same for the same seed). */
function randomWords(n: number, seed: number): string[] {
  let a = seed >>> 0;
  const next = () => (a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296;
  return Array.from({ length: n }, () => vocabulary[Math.floor(next() * vocabulary.length)]!);
}

/**
 * A fixture track that says it lasts `seconds`: the frame count in its Info header is raised, and
 * music-metadata takes the duration from it. The tiny tracks are MPEG-2 Layer III at 22.05 kHz
 * (scripts/fixtures/make-audio.mjs), 576 samples a frame.
 */
function lasting(track: UploadFile, seconds: number): UploadFile {
  const bytes = Buffer.from(track.bytes);
  const tagEnd = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
  const info = bytes.indexOf('Info', tagEnd);
  if (info < 0 || (bytes.readUInt32BE(info + 4) & 1) === 0) throw new Error(`${track.name} has no frame count to raise`);
  bytes.writeUInt32BE(Math.round((seconds * 22050) / 576), info + 8);
  return { ...track, bytes: new Uint8Array(bytes) };
}

/** Twelve tracks of three hours each: room for a million words. */
const long = tiny.map((track) => lasting(track, 3 * 3600));

/**
 * What a recogniser might write for the long audiobook: chapter I read in track 1 at 2.5 words a
 * second, and `noise` words of the book in no order in the other eleven (nothing a book lines up with).
 */
function noisyTranscript(audio: Edition, noise: number): string {
  const text = sectionText(2);
  const chapterOne = textWords(text).map((w) => text.slice(w.start, w.end));
  const per = Math.ceil(noise / (audio.tracks.length - 1));
  const tracks = audio.tracks.map((track, k) => {
    const words = k === 0 ? chapterOne : randomWords(per, k);
    const step = Math.min(400, (track.durationMs - 2000) / words.length);
    return {
      sha256: sha256(long[k]!.bytes),
      durationMs: track.durationMs,
      words: words.map((w, i): [number, number, string] => [Math.round(1000 + i * step), Math.round(1000 + (i + 0.8) * step), w]),
    };
  });
  return JSON.stringify({ format: 'bookclub-transcript/1', engine: 'test', tracks } satisfies Transcript);
}

/** A transcript of the tiny audiobook naming no files, its tracks as long as the audiobook's: `words` words in all. */
function evenTranscript(audio: Edition, words: number): string {
  const per = Math.ceil(words / audio.tracks.length);
  const tracks = audio.tracks.map((track, k) => {
    const said = randomWords(Math.max(0, Math.min(per, words - k * per)), 100 + k);
    return { durationMs: track.durationMs, words: said.map((w, i): [number, number, string] => [i % track.durationMs, i % track.durationMs, w]) };
  });
  return JSON.stringify({ format: 'bookclub-transcript/1', engine: 'test', tracks } satisfies Transcript);
}

const putTranscript = (c: Client, editionId: string, body: string | Uint8Array) =>
  c.request({ method: 'PUT', url: `/api/editions/${editionId}/transcript`, payload: body, headers: { 'content-type': 'application/json' } });

/** A transcript upload that declares `length` bytes, sends one, and waits: until it is destroyed, it is being received. */
function holdUpload(t: TestApp, c: Client, editionId: string, length: number): http.ClientRequest {
  const url = new URL(t.baseUrl);
  const req = http.request({
    host: url.hostname,
    port: url.port,
    method: 'PUT',
    path: `/api/editions/${editionId}/transcript`,
    headers: { cookie: c.cookieHeader, 'content-type': 'application/json', 'content-length': String(length) },
  });
  req.on('error', () => undefined);
  req.write('{');
  return req;
}

/** How a request is answered (status 0: its connection closed unanswered), and how long after `since`. */
function answerTo(req: http.ClientRequest, since: number): Promise<{ status: number; body: string; ms: number }> {
  return new Promise((resolve) => {
    const done = (status: number, body: string) => resolve({ status, body, ms: performance.now() - since });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => done(res.statusCode ?? 0, body));
      res.on('error', () => done(res.statusCode ?? 0, body));
    });
    req.on('close', () => done(0, ''));
  });
}

/** A transcript upload whose body comes in two halves, `pauseMs` apart. */
function uploadInHalves(t: TestApp, c: Client, editionId: string, body: string, pauseMs: number): Promise<{ status: number; body: string; ms: number }> {
  const url = new URL(t.baseUrl);
  const bytes = Buffer.from(body);
  const req = http.request({
    host: url.hostname,
    port: url.port,
    method: 'PUT',
    path: `/api/editions/${editionId}/transcript`,
    headers: { cookie: c.cookieHeader, 'content-type': 'application/json', 'content-length': String(bytes.byteLength) },
  });
  req.on('error', () => undefined);
  const answer = answerTo(req, performance.now());
  req.write(bytes.subarray(0, bytes.byteLength >> 1));
  setTimeout(() => req.end(bytes.subarray(bytes.byteLength >> 1)), pauseMs);
  return answer;
}

const NOT_ALIGNED = 'audiobook not aligned: its transcript could not be lined up within the limits';
const ALIGNED = 'audiobook aligned with its text';

describe('a transcript cannot stall the server or exhaust its memory', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  /** Alice with an audiobook of twelve three-hour tracks. */
  let book: BookDetail;
  let audio: Edition;
  /** An audiobook of the twelve tiny tracks (55 s in all), in a book of its own. */
  let small: Edition;

  const refresh = async () => {
    book = await bookDetail(owner, book.id);
    audio = book.editions.find((e) => e.kind === 'audio')!;
    return audio;
  };

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', long, { title: 'Alice', author: 'Lewis Carroll', bookId });
    const tinyBook = await uploadBook(owner, club.id, 'audio', tiny, { title: 'Alice, very short', author: 'Lewis Carroll' });
    await t.settle();
    book = { id: bookId } as BookDetail;
    await refresh();
    small = (await bookDetail(owner, tinyBook.bookId)).editions[0]!;
    expect(audio.tracks.map((tr) => Math.round(tr.durationMs / 1000))).toEqual(Array.from({ length: 12 }, () => 3 * 3600));
  });

  afterAll(async () => {
    setReadAlongLimits(t.ctx, READ_ALONG_LIMITS);
    await closeApp(t);
  });

  it('refuses, before reading a byte of it, a transcript bigger than any may be, or than this audiobook’s can be, and one sent without its length', async () => {
    // Only the headers are ever sent: each answer comes without the body. (The connection is not
    // used again: the server is still owed the declared bytes on it.)
    const declared = (editionId: string, headers: Record<string, string>) =>
      rawRequest(t.baseUrl, 'PUT', `/api/editions/${editionId}/transcript`, { cookie: owner.cookieHeader, 'content-type': 'application/json', connection: 'close', ...headers });
    const huge = await declared(audio.id, { 'content-length': String(50 * 1024 * 1024) });
    expect(huge.statusCode).toBe(413);
    expect(JSON.parse(huge.body)).toMatchObject({ error: { message: 'That transcript is 50 MB: a transcript may be 32 MB at most.' } });
    // The reviewer's case: tens of megabytes for a minute of audio.
    const tooMuch = await declared(small.id, { 'content-length': String(30 * 1024 * 1024) });
    expect(tooMuch.statusCode).toBe(413);
    const smallMs = small.tracks.reduce((n, tr) => n + tr.durationMs, 0);
    expect((JSON.parse(tooMuch.body) as { error: { message: string } }).error.message).toMatch(new RegExp(`^That transcript is 30 MB: one of this audiobook \\(${formatDuration(smallMs)} of audio\\) is never more than 2\\.\\d MB\\.$`));
    expect((await declared(small.id, { 'transfer-encoding': 'chunked' })).statusCode).toBe(411);
    expect(hasTranscript(t.ctx.db, small.id)).toBe(false);
  });

  it('refuses more words than anyone can say in the audiobook’s length, as the server measured it', async () => {
    const totalMs = small.tracks.reduce((n, tr) => n + tr.durationMs, 0);
    const allowed = wordsAllowed(totalMs);
    expect(allowed).toBe(Math.floor((totalMs / 1000) * MAX_WORDS_PER_SECOND) + SPARE_WORDS);
    const over = await putTranscript(owner, small.id, evenTranscript(small, allowed + 1));
    expect(over.statusCode).toBe(400);
    expect(over.json<{ error: { message: string } }>().error.message).toBe(
      `The transcript has ${(allowed + 1).toLocaleString('en')} words for ${formatDuration(totalMs)} of audio: more than anyone says in that time (8 words a second at most).`,
    );
    expect(hasTranscript(t.ctx.db, small.id)).toBe(false);
    // As many as that is taken.
    expect((await putTranscript(owner, small.id, evenTranscript(small, allowed))).statusCode).toBe(202);
    await t.settle();
    expect(hasTranscript(t.ctx.db, small.id)).toBe(true);
  });

  it('reads a long transcript and lines the book up in worker threads: the server keeps answering throughout', async () => {
    // 400,000 words, 10 MB: parsed and lined up on the server's thread, this held it for about two
    // seconds. Encoded beforehand, so that only the server's work is measured (the client is in
    // this process too).
    const body = new TextEncoder().encode(noisyTranscript(audio, 400_000));
    expect(body.byteLength).toBeGreaterThan(9_000_000);
    let answered = 0;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const res = await fetch(`${t.baseUrl}/healthz`);
        if (res.ok) answered++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const watch = watchThread();
    const began = performance.now();
    let took: number;
    let thread: ThreadWatch;
    try {
      expect((await putTranscript(owner, audio.id, body)).statusCode).toBe(202);
      await t.settle();
    } finally {
      took = performance.now() - began;
      thread = watch.stop();
      polling = false;
      await poll;
    }
    const measured = `took ${Math.round(took)} ms; ${JSON.stringify(thread, (_, v: unknown) => (typeof v === 'number' ? Math.round(v) : v))}`;
    // The work took seconds. The server's thread was never held for more than a fraction of it,
    // counted in the work it did there, whatever else the box was doing: what it does is mostly keep
    // the 10 MB of words in the database and index them for Cal, and the most of that it did from one
    // turn to the next is under a tenth of all the CPU time the process spent meanwhile (1 to 4 per
    // cent on every box this was measured on, idle or loaded with other work, memory pressure and
    // disk writes); all of it, under half (a fifth). Read and lined up on the server's thread, the
    // work held it for 34 to 47 per cent of it at a stretch, and the thread did more than half.
    expect(took).toBeGreaterThan(1000);
    expect(thread.busiestCpuMs, measured).toBeLessThan(thread.processCpuMs / 10);
    expect(thread.threadCpuMs, measured).toBeLessThan(thread.processCpuMs / 2);
    // On the wall clock, what anyone waiting on the server waits: a quarter of a second at most
    // here. A shared CI runner (CI is set) can stop any thread for a second and more on its own
    // account, with other jobs' work, its memory limit's reclaim, its disk and swap (this clock
    // read 1036 and 330 ms there on 2026-11-02; a box loaded so for this test, 5 s, with the
    // thread's work at 4 per cent). What the thread worked is held above; there the clock has only
    // to show that the server was never stopped for half of the run.
    expect(thread.longest.wallMs, measured).toBeLessThan(process.env.CI ? took / 2 : Math.min(250, took / 10));
    expect(answered).toBeGreaterThan(10);
    // And it was done: chapter I, read in track 1, reads along; the noise lined up with nothing.
    await refresh();
    expect(audio.alignment.method).toBe('forced');
    expect(audio.readAlong!.sentences).toBeGreaterThan(50);
    const track = await owner.json<{ text: string[] }>(owner.get(`/api/editions/${audio.id}/readalong?track=0`), 200);
    expect(track.text[0]).toBe('CHAPTER I.');
  });

  /** Line the book up within a third of a second: what 400,000 words never are. */
  const TOO_SLOW = { align: { ms: 300, heapMb: READ_ALONG_LIMITS.align.heapMb } };

  /** The book's warnings that an alignment ran out of its limits, and its alignments done, from now on. */
  const watchAlignments = () => {
    const warn = vi.spyOn(t.ctx.log, 'warn');
    const info = vi.spyOn(t.ctx.log, 'info');
    return {
      notAligned: () => warn.mock.calls.filter((call) => call[1] === NOT_ALIGNED).map((call) => call[0] as { audio: string; err: string; again: boolean }),
      aligned: () => info.mock.calls.filter((call) => call[1] === ALIGNED && (call[0] as { audio?: string }).audio === audio.id),
      done: () => {
        warn.mockRestore();
        info.mockRestore();
      },
    };
  };

  it('stops a book’s alignment at its time limit keeping what the book had, and tries it once more later', async () => {
    const { notAligned, aligned, done } = watchAlignments();
    // The second try is set for an hour later, caught as it is set, and run once this test has seen
    // all that comes before it: on a busy box that can take longer than any wait the test could set
    // (on 2026-11-02 Cal's index of the transcript, which t.settle() waits for, took a CI runner
    // past the two seconds the second try was set for then, and the second try came first).
    const AN_HOUR = 60 * 60_000;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      // From the test before: the book reads along.
      const before = (await refresh()).readAlong!;
      expect(before.sentences).toBeGreaterThan(50);
      const sync = audio.sync;
      // A box too busy to line it up keeps the read-along it had, and the map that one refined.
      setReadAlongLimits(t.ctx, { ...TOO_SLOW, alignAgainMs: AN_HOUR });
      expect((await putTranscript(owner, audio.id, noisyTranscript(audio, 400_000))).statusCode).toBe(202);
      await t.settle();
      expect(notAligned()).toEqual([expect.objectContaining({ audio: audio.id, err: 'it took longer than 0.3 s', again: true })]);
      const secondTry = timers.mock.calls.filter(([, ms]) => ms === AN_HOUR).map(([run]) => run);
      timers.mockRestore();
      expect(secondTry).toHaveLength(1);
      await refresh();
      expect(audio.readAlong).toEqual(before);
      expect(audio.alignment.method).toBe('forced');
      expect(audio.sync).toEqual(sync);
      // Whatever lines the book up meanwhile leaves that transcript alone, even with room to spare...
      setReadAlongLimits(t.ctx, { align: READ_ALONG_LIMITS.align });
      scheduleAlignment(t.ctx, book.id);
      await t.settle();
      expect(notAligned()).toHaveLength(1);
      expect(aligned()).toHaveLength(0);
      // ...until it is tried once more, a while later: the box was only busy, and it lines up.
      secondTry[0]!();
      await waitUntil(() => aligned().length === 1, 20_000, 'the book to be lined up once more');
      await t.settle();
      expect(notAligned()).toHaveLength(1);
      expect((await refresh()).readAlong!.sentences).toBeGreaterThan(50);
    } finally {
      timers.mockRestore();
      setReadAlongLimits(t.ctx, READ_ALONG_LIMITS);
      done();
    }
  });

  it('stopped at its limits on its second try too, a transcript is not lined up again until it changes', async () => {
    const { notAligned, aligned, done } = watchAlignments();
    const body = noisyTranscript(audio, 400_000);
    try {
      setReadAlongLimits(t.ctx, { ...TOO_SLOW, alignAgainMs: 300 });
      expect((await putTranscript(owner, audio.id, body)).statusCode).toBe(202);
      await waitUntil(() => notAligned().length === 2, 20_000, 'its second try');
      await t.settle();
      expect(notAligned().map((n) => n.again)).toEqual([true, false]);
      // Not a third time, whatever lines the book up, even with room to spare; nor later (three
      // times its wait for a second try goes by). What it had stays.
      setReadAlongLimits(t.ctx, { align: READ_ALONG_LIMITS.align });
      scheduleAlignment(t.ctx, book.id);
      await t.settle();
      await new Promise((resolve) => setTimeout(resolve, 900));
      await t.settle();
      expect(notAligned()).toHaveLength(2);
      expect(aligned()).toHaveLength(0);
      expect((await refresh()).readAlong!.sentences).toBeGreaterThan(50);
      // Given again, it is tried afresh (and stopped again here, with a second try to come).
      setReadAlongLimits(t.ctx, { ...TOO_SLOW, alignAgainMs: 60 * 60_000 });
      expect((await putTranscript(owner, audio.id, body)).statusCode).toBe(202);
      await t.settle();
      expect(notAligned().map((n) => n.again)).toEqual([true, false, true]);
    } finally {
      setReadAlongLimits(t.ctx, READ_ALONG_LIMITS);
      done();
    }
  });

  it('stops a worker at its memory limit, reading a transcript (413) or lining a book up, and the server goes on', async () => {
    const warn = vi.spyOn(t.ctx.log, 'warn');
    try {
      const body = noisyTranscript(audio, 400_000);
      setReadAlongLimits(t.ctx, { read: { ms: READ_ALONG_LIMITS.read.ms, heapMb: 32 } });
      const unread = await putTranscript(owner, audio.id, body);
      expect(unread.statusCode).toBe(413);
      expect(unread.json<{ error: { message: string } }>().error.message).toBe('That transcript is too big to read: it needed more than 32 MB.');
      setReadAlongLimits(t.ctx, { read: READ_ALONG_LIMITS.read, align: { ms: READ_ALONG_LIMITS.align.ms, heapMb: 32 } });
      expect((await putTranscript(owner, audio.id, body)).statusCode).toBe(202);
      await t.settle();
      expect(warn.mock.calls.filter((call) => call[1] === NOT_ALIGNED).map((call) => call[0])).toEqual([expect.objectContaining({ err: 'it needed more than 32 MB', again: true })]);
      // What the book read along with before stays (tried once more later, as at its time limit).
      expect((await refresh()).readAlong!.sentences).toBeGreaterThan(50);
      expect((await t.client().get('/healthz')).statusCode).toBe(200);
    } finally {
      setReadAlongLimits(t.ctx, READ_ALONG_LIMITS);
      warn.mockRestore();
    }
  });
});

describe('how often, and how many at once, transcripts are taken', () => {
  const dirs: string[] = [];
  let t: TestApp;
  let first: ClubDetail;

  /** Someone invited to a club, who starts one of their own (anyone can) and adds the tiny audiobook to it. */
  const ownerWithAudiobook = async (name: string) => {
    const owner = await joinClub(t, first, name);
    const club = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: `${name}’s club` }), 201);
    const { bookId } = await uploadBook(owner, club.id, 'audio', tiny, { title: 'Alice, very short', author: 'Lewis Carroll' });
    await t.settle();
    return { owner, audio: (await bookDetail(owner, bookId)).editions[0]! };
  };

  beforeAll(async () => {
    // The server's recogniser hears twenty thousand words in the first tiny track.
    const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-limits-'));
    dirs.push(dir);
    const words = path.join(dir, 'words.json');
    writeFileSync(words, JSON.stringify([randomWords(20_000, 7)]));
    const fake = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'fake-transcriber.mjs');
    t = await makeTestApp({ TRANSCRIBE_COMMAND: `${process.execPath} ${fake} --words ${words}` });
    ({ club: first } = await setupOwner(t));
  });

  afterAll(async () => {
    await closeApp(t);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('holds what the server’s own recogniser writes to the same limits as an upload', async () => {
    const { audio } = await ownerWithAudiobook('Bea');
    const totalMs = audio.tracks.reduce((n, tr) => n + tr.durationMs, 0);
    expect(hasTranscript(t.ctx.db, audio.id)).toBe(false);
    expect(transcriptionFor(t.ctx.db, audio.id)).toMatchObject({
      runs: 1,
      last_error: `The transcript has 20,000 words for ${formatDuration(totalMs)} of audio: more than anyone says in that time (8 words a second at most).`,
    });
  });

  it('lets an owner upload ten transcripts an hour; a refusal before the body is read costs no try', async () => {
    const { owner, audio } = await ownerWithAudiobook('Eve');
    for (let i = 0; i < 3; i++) {
      const res = await rawRequest(t.baseUrl, 'PUT', `/api/editions/${audio.id}/transcript`, {
        cookie: owner.cookieHeader,
        'content-type': 'application/json',
        'content-length': String(TRANSCRIPT_MAX_BYTES),
        connection: 'close',
      });
      expect(res.statusCode).toBe(413);
    }
    for (let i = 0; i < 10; i++) expect((await putTranscript(owner, audio.id, '{}')).statusCode).toBe(400);
    const res = await putTranscript(owner, audio.id, '{}');
    expect(res.statusCode).toBe(429);
    expect(res.json<{ error: { message: string } }>().error.message).toBe('That is a lot of transcripts in an hour. Try again later.');
  });

  it('receives two transcripts at once over the whole server, one at most of anyone’s; a third is asked to come back', async () => {
    // Someone who has had their ten tries asks again and again: they hear that the server is busy
    // (503) or that they have had their tries (429), and their asking never takes any room.
    const asker = await ownerWithAudiobook('Gil');
    for (let i = 0; i < 10; i++) expect((await putTranscript(asker.owner, asker.audio.id, '{}')).statusCode).toBe(400);
    const ask = () => putTranscript(asker.owner, asker.audio.id, '{}');
    expect((await ask()).statusCode).toBe(429);
    const dee = await ownerWithAudiobook('Dee');
    const fay = await ownerWithAudiobook('Fay');
    const hal = await ownerWithAudiobook('Hal');
    const held = [holdUpload(t, fay.owner, fay.audio.id, 64 * 1024), holdUpload(t, hal.owner, hal.audio.id, 64 * 1024)];
    try {
      await waitUntil(async () => (await ask()).statusCode === 503, 5000, 'two transcripts to be received');
      const busy = await putTranscript(dee.owner, dee.audio.id, '{}');
      expect(busy.statusCode).toBe(503);
      expect(busy.json()).toMatchObject({ error: { code: 'busy', message: 'The server is reading other transcripts. Try again in a minute.' } });
      // Hal's goes, and a place is free: Fay, who holds the other, cannot have it too. Her second is
      // answered from its headers alone (its body is never sent).
      held[1]!.destroy();
      await waitUntil(async () => (await ask()).statusCode === 429, 5000, 'room for a transcript');
      const second = await rawRequest(t.baseUrl, 'PUT', `/api/editions/${fay.audio.id}/transcript`, {
        cookie: fay.owner.cookieHeader,
        'content-type': 'application/json',
        'content-length': String(64 * 1024),
        connection: 'close',
      });
      expect(second.statusCode).toBe(429);
      expect(JSON.parse(second.body)).toMatchObject({ error: { code: 'already_sending', message: 'You are already sending a transcript. Try again once it is in.' } });
      // The place is someone else's to take.
      held.push(holdUpload(t, hal.owner, hal.audio.id, 64 * 1024));
      await waitUntil(async () => (await ask()).statusCode === 503, 5000, 'Hal’s transcript to be received again');
    } finally {
      for (const req of held) req.destroy();
    }
    // Once they are gone there is room again, and Dee's turn was not counted against her.
    await waitUntil(async () => (await ask()).statusCode === 429, 5000, 'room for a transcript');
    for (let i = 0; i < 10; i++) expect((await putTranscript(dee.owner, dee.audio.id, '{}')).statusCode).toBe(400);
  });

  it('cuts off an upload whose body stops coming, at a deadline that grows with its length, and gives its place to someone else', async () => {
    // A kilobyte is given the floor, a second here; 128 KiB the time it takes at 64 KiB a second, two.
    setReadAlongLimits(t.ctx, { upload: { bytesPerSecond: 64 * 1024, minMs: 1000 } });
    try {
      const asker = await ownerWithAudiobook('Ivy');
      for (let i = 0; i < 10; i++) expect((await putTranscript(asker.owner, asker.audio.id, '{}')).statusCode).toBe(400);
      const ask = async () => (await putTranscript(asker.owner, asker.audio.id, '{}')).statusCode;
      const jon = await ownerWithAudiobook('Jon');
      const kim = await ownerWithAudiobook('Kim');
      const lee = await ownerWithAudiobook('Lee');
      // Each sends one byte of what it declares, and stops.
      const sent = performance.now();
      const small = answerTo(holdUpload(t, jon.owner, jon.audio.id, 1024), sent);
      const large = answerTo(holdUpload(t, kim.owner, kim.audio.id, 128 * 1024), sent);
      await waitUntil(async () => (await ask()) === 503, 5000, 'two transcripts to be received');
      // The small one is cut off first, and told why; its place is someone else's at once. (The
      // clocks run from when the server let them in, after they were sent: never early, here.)
      const tooSlow = { error: { code: 'too_slow', message: 'The transcript took too long to arrive. Try again on a faster connection.' } };
      const first = await small;
      expect(first.status).toBe(408);
      expect(JSON.parse(first.body)).toEqual(tooSlow);
      expect(first.ms).toBeGreaterThan(1000 - 25);
      await waitUntil(async () => (await ask()) === 429, 5000, 'room for a transcript');
      expect((await putTranscript(lee.owner, lee.audio.id, evenTranscript(lee.audio, 100))).statusCode).toBe(202);
      // One whose body comes slowly, but in time, is read like any other. (Given ten seconds here,
      // the others' clocks having been set as they were let in: its pause and the clock that would
      // cut it off both run on this thread, and a busy box can stop it for longer than the 600 ms a
      // second leaves between them; both then come due in one turn, and the clock fires before the
      // rest of the body, sent meanwhile, is read.)
      setReadAlongLimits(t.ctx, { upload: { bytesPerSecond: 64 * 1024, minMs: 10_000 } });
      const halves = await uploadInHalves(t, jon.owner, jon.audio.id, evenTranscript(jon.audio, 100), 400);
      expect(halves.status).toBe(202);
      // The large one was given longer.
      const second = await large;
      expect(second.status).toBe(408);
      expect(JSON.parse(second.body)).toEqual(tooSlow);
      expect(second.ms).toBeGreaterThan(2000 - 25);
      expect(second.ms).toBeGreaterThan(first.ms);
      await waitUntil(async () => (await ask()) === 429, 5000, 'room again');
    } finally {
      setReadAlongLimits(t.ctx, READ_ALONG_LIMITS);
    }
  });

  it('gives any request ten minutes to come in (Fastify’s default is never), more than any transcript’s body is given', () => {
    const server = t.app.server;
    // An upload chunk of the web app's (8 MiB) takes 67 s at 1 Mbit/s: minutes are left.
    const chunkMs = ((8 * 1024 * 1024 * 8) / 1_000_000) * 1000;
    expect(server.requestTimeout - chunkMs).toBeGreaterThan(5 * 60_000);
    // The longest a transcript's body may take (32 MiB at 64 KiB a second) is inside it.
    expect(uploadDeadlineMs(t.ctx, TRANSCRIPT_MAX_BYTES)).toBe(512_000);
    expect(server.requestTimeout).toBeGreaterThan(512_000);
    // Node would hold the whole request to the larger of the two were the headers' the larger.
    expect(server.headersTimeout).toBeLessThan(server.requestTimeout);
  });
});

describe('an upload whose connection goes while it is being signed in', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-gone-'));
  let t: TestApp;
  /** Requests signed in slowly so far (each goes on at once to be let in, or not). */
  let slowlySignedIn = 0;

  beforeAll(async () => {
    const built = await buildApp({ config: loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, LOG_LEVEL: 'silent', SCRYPT_LOG_N: '12' }), logger: false, background: false });
    // Signing a request in may wait on something (it did while an upstream's token was checked,
    // D52): here a third of a second, for requests that ask for it.
    built.app.addHook('onRequest', async (request) => {
      if (request.headers['x-slow-sign-in'] === undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
      slowlySignedIn++;
    });
    const baseUrl = await built.app.listen({ host: '127.0.0.1', port: 0 });
    t = {
      ...built,
      dir,
      baseUrl,
      client: () => new Client(baseUrl),
      settle: async () => {
        do {
          await built.ctx.jobs.idle();
          await built.ctx.slowJobs.idle();
        } while (built.ctx.jobs.pending > 0 || built.ctx.slowJobs.pending > 0);
      },
      close: async () => {
        await built.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('gives its place back at once: two of them leave room for two transcripts', async () => {
    const { club } = await setupOwner(t);
    const ownerWithAudiobook = async (name: string) => {
      const owner = await joinClub(t, club, name);
      const own = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: `${name}’s club` }), 201);
      const { bookId } = await uploadBook(owner, own.id, 'audio', tiny, { title: 'Alice, very short', author: 'Lewis Carroll' });
      await t.settle();
      return { owner, audio: (await bookDetail(owner, bookId)).editions[0]! };
    };
    const asker = await ownerWithAudiobook('Gil');
    for (let i = 0; i < 10; i++) expect((await putTranscript(asker.owner, asker.audio.id, '{}')).statusCode).toBe(400);
    const ask = async () => (await putTranscript(asker.owner, asker.audio.id, '{}')).statusCode;
    const [ann, bob, cat, dan] = [await ownerWithAudiobook('Ann'), await ownerWithAudiobook('Bob'), await ownerWithAudiobook('Cat'), await ownerWithAudiobook('Dan')];
    // Two uploads go before they are signed in: each is let in only once its connection is gone.
    for (const { owner, audio } of [ann, bob]) {
      const url = new URL(t.baseUrl);
      const req = http.request({
        host: url.hostname,
        port: url.port,
        method: 'PUT',
        path: `/api/editions/${audio.id}/transcript`,
        headers: { cookie: owner.cookieHeader, 'content-type': 'application/json', 'content-length': '1024', 'x-slow-sign-in': '1' },
      });
      req.on('error', () => undefined);
      req.write('{');
      setTimeout(() => req.destroy(), 50);
    }
    // Once both have been signed in, and so let in (the same turn), there is room, and for two.
    await waitUntil(() => slowlySignedIn === 2, 5000, 'both to be signed in');
    expect(await ask()).toBe(429);
    const held = [holdUpload(t, cat.owner, cat.audio.id, 1024), holdUpload(t, dan.owner, dan.audio.id, 1024)];
    try {
      await waitUntil(async () => (await ask()) === 503, 5000, 'two transcripts to be received');
    } finally {
      for (const req of held) req.destroy();
    }
  });
});

describe('the alignment queue', () => {
  const log = { info: () => undefined, error: () => undefined } as unknown as FastifyBaseLogger;

  it('lines a book up once however many times it was queued while waiting, and again after one already running', async () => {
    const jobs = new Jobs(log);
    const ran: string[] = [];
    let release = () => {};
    const blocking = new Promise<void>((resolve) => (release = resolve));
    jobs.enqueue('ingest:e1', () => blocking);
    for (const n of [1, 2, 3]) {
      jobs.enqueue('align:b1', async () => {
        ran.push(`align ${n}`);
      });
    }
    jobs.enqueue('align:b2', async () => {
      ran.push('other book');
    });
    expect(jobs.pending).toBe(3);
    release();
    await jobs.idle();
    // The last one queued, in the place of the first.
    expect(ran).toEqual(['align 3', 'other book']);

    let finish = () => {};
    const running = new Promise<void>((resolve) => (finish = resolve));
    jobs.enqueue('align:b1', () => running);
    await waitUntil(() => jobs.pending === 1, 1000, 'the alignment to start');
    jobs.enqueue('align:b1', async () => {
      ran.push('after the running one');
    });
    expect(jobs.pending).toBe(2);
    finish();
    await jobs.idle();
    expect(ran).toEqual(['align 3', 'other book', 'after the running one']);
  });
});

describe('the worker’s own work, run here', () => {
  const files = [
    { blobId: 'a', sha256: 'a'.repeat(64), durationMs: 600_000 },
    { blobId: 'b', sha256: 'b'.repeat(64), durationMs: 600_000 },
  ];
  const bytes = (doc: unknown) => new TextEncoder().encode(typeof doc === 'string' ? doc : JSON.stringify(doc));

  it('reads a transcript, refusing what is not one, and keeps only the words of the tracks it matches', () => {
    expect(readTranscript({ kind: 'read', body: bytes('{"not json'), files })).toEqual({ refused: 'That is not a transcript: it is not JSON.' });
    const wrong = readTranscript({ kind: 'read', body: bytes({ format: 'other', tracks: [] }), files });
    expect(wrong).toHaveProperty('refused');
    expect(wrong).toHaveProperty('fields.format');
    const read = readTranscript({
      kind: 'read',
      body: bytes({ format: 'bookclub-transcript/1', engine: 'whisper', model: 'small.en', tracks: [{ sha256: 'b'.repeat(64), durationMs: 600_000, words: [[0, 300, 'Alice', 0.9]] }, { sha256: 'c'.repeat(64), durationMs: 1, words: [[0, 1, 'stray']] }] }),
      files,
    });
    expect(read).toEqual({ engine: 'whisper small.en', tracks: JSON.stringify([{ blobId: 'b', words: [[0, 300, 'Alice']] }]), words: 1 });
  });

  it('matches by content or in order, counting the words against the lengths the server measured', () => {
    const doc = (tracks: Transcript['tracks']): Transcript => ({ format: 'bookclub-transcript/1', engine: 'test', tracks });
    // The transcript says its track is a second long; the file is ten minutes, which is what counts.
    const allowed = wordsAllowed(600_000);
    expect(matchTranscript(doc([{ sha256: 'a'.repeat(64), durationMs: 1000, words: Array.from({ length: allowed }, () => [0, 1, 'w'] as [number, number, string]) }]), files)).toHaveLength(1);
    expect(() => matchTranscript(doc([{ sha256: 'a'.repeat(64), durationMs: 600_000, words: Array.from({ length: allowed + 1 }, () => [0, 1, 'w'] as [number, number, string]) }]), files)).toThrow(/more than anyone says/);
    expect(() => matchTranscript(doc([{ sha256: 'c'.repeat(64), durationMs: 1000, words: [] }]), files)).toThrow('None of the transcript’s tracks is a track of this audiobook.');
    expect(() => matchTranscript(doc([{ durationMs: 600_000, words: [] }]), files)).toThrow('The transcript has 1 tracks; this audiobook has 2.');
    expect(() => matchTranscript(doc([{ durationMs: 600_000, words: [] }, { durationMs: 500_000, words: [] }]), files)).toThrow('Track 2 of the transcript is not as long as track 2 of this audiobook.');
    expect(matchTranscript(doc([{ durationMs: 599_000, words: [[0, 1, 'a', 0.5]] }, { durationMs: 601_000, words: [] }]), files)).toEqual([
      { blobId: 'a', words: [[0, 1, 'a']] },
      { blobId: 'b', words: [] },
    ]);
  });

  it('lines a text up with what was heard, from the text’s files', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-align-'));
    // What was heard is read from the database by the worker, as the server keeps it.
    const database = path.join(dir, 'bookclub.db');
    const db = openDb(database);
    try {
      const sections = pub.sections.map((s, index) => {
        const file = path.join(dir, `${index}.xhtml`);
        writeFileSync(file, pub.files.get(s.path)!);
        return { index, file, textLength: sectionText(index).length };
      });
      const total = sections.reduce((n, s) => n + s.textLength, 0);
      const text = sectionText(2);
      const heard = textWords(text).map((w, i): [number, number, string] => [1000 + i * 400, 1300 + i * 400, text.slice(w.start, w.end)]);
      const durationMs = 2000 + heard.length * 400;
      db.raw.exec('PRAGMA foreign_keys = OFF');
      saveTranscript(db, 'audio', 'test', [{ blobId: 'a', words: heard }]);
      const map = linearSyncMap(0, durationMs);
      const task = {
        kind: 'align' as const,
        textEditionId: 'text',
        sections,
        story: { start: 0, end: total },
        database,
        audioEditionId: 'audio',
        tracks: [{ blobId: 'a', durationMs }],
        chapters: [{ title: 'Everything', t: 0 }],
        audioIsReference: true,
        audioSync: map,
        textSync: linearSyncMap(0, total),
        fallback: linearSyncMap(0, total),
        total,
      };
      const result = await alignText(task);
      expect(result.stats).toMatchObject({ alignedTracks: 1, tracks: 1 });
      expect((JSON.parse(result.sentences!) as unknown[][])[0]!.length).toBeGreaterThan(50);
      expect(result.sync!.points.length).toBeGreaterThan(2);
      // A text that does not measure as readers measure it is refused, in a worker as here.
      const changed = { ...task, sections: sections.map((s, i) => (i === 2 ? { ...s, textLength: s.textLength + 1 } : s)) };
      await expect(alignText(changed)).rejects.toThrow('section 2 of text measures');
      await expect(runInWorker(changed, READ_ALONG_LIMITS.align)).rejects.toThrow('section 2 of text measures');
      await expect(runInWorker(task, { ms: 1, heapMb: 64 })).rejects.toThrow(WorkLimitError);
      // In a worker, as here, what was heard is all read from the database.
      expect((await runInWorker(task, READ_ALONG_LIMITS.align)).stats).toEqual(result.stats);
      // A transcript removed meanwhile heard nothing.
      expect((await alignText({ ...task, audioEditionId: 'gone' })).sentences).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the server’s thread, watched (watchThread)', () => {
  const cpuMs = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
  };
  /** Work on this thread for `ms` of its own CPU time, however long the box takes to give it that. */
  const work = (ms: number) => {
    const from = cpuMs();
    while (cpuMs() - from < ms) {
      // working
    }
  };

  it('counts the work done from one turn to the next, and not the time spent waiting (the check that this can fail)', async () => {
    const watch = watchThread();
    // A third of a second of work, then as long waiting with nothing to do, as a thread waits for a
    // busy box: one stretch, without a turn.
    work(300);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    // A turn, then a tenth of a second more.
    await new Promise((resolve) => setTimeout(resolve, 50));
    work(100);
    const watched = watch.stop();
    expect(watched.longest.wallMs).toBeGreaterThan(550);
    expect(watched.busiestCpuMs).toBeGreaterThanOrEqual(300);
    // Counted with the wait it would be 600 ms; with the work after the turn, 400.
    expect(watched.busiestCpuMs).toBeLessThan(350);
    expect(watched.threadCpuMs).toBeGreaterThanOrEqual(400);
  });
});
