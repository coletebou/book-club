import { createHash } from 'node:crypto';
import { type BookDetail, type ClubDetail } from '@bookclub/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type WorkResult, type WorkTask } from '../src/services/align-worker';
import * as aligner from '../src/services/aligner';
import { ALICE_TINY_AUDIO, type Client, type TestApp, audioTracks, bookDetail, closeApp, joinClub, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

describe('audiobook words', () => {
  let app: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let member: Client;
  let stranger: Client;
  let book: BookDetail;
  let editionId: string;
  const files = audioTracks(ALICE_TINY_AUDIO).slice(0, 2);
  const sourceTrack = (track: number, words: [number, number, string][]) => ({
    sha256: createHash('sha256').update(files[track]!.bytes).digest('hex'),
    durationMs: book.editions[0]!.tracks[track]!.durationMs,
    words,
  });
  const giveTranscript = (tracks: ReturnType<typeof sourceTrack>[]) => owner.put(`/api/editions/${editionId}/transcript`, {
    format: 'bookclub-transcript/1', engine: 'test', tracks,
  });
  const wordsAt = (track: number) => `/media/editions/${editionId}/spoken-words?track=${track}&window=0`;

  beforeAll(async () => {
    app = await makeTestApp();
    ({ owner, club } = await setupOwner(app));
    member = await joinClub(app, club, 'Ana');
    stranger = await outsider(app, owner, 'Stu');
    const { bookId } = await uploadBook(owner, club.id, 'audio', files, { title: 'Alice' });
    await app.settle();
    book = await bookDetail(owner, bookId);
    const audio = book.editions[0]!;
    editionId = audio.id;
    const uploaded = await giveTranscript([sourceTrack(0, [[250, 490, 'White'], [500, 800, 'rabbit.'], [830, 1_030, 'Down.']])]);
    expect(uploaded.statusCode).toBe(202);
    await app.settle();
  });

  afterAll(async () => { await closeApp(app); });
  afterEach(() => { vi.restoreAllMocks(); });
  const countWindowReads = (calls: [WorkTask, aligner.WorkLimits][]) => calls.filter(([task]) => task.kind === 'spoken-words').length;

  it('serves only the source words, with durations, to an audiobook member', async () => {
    const work = vi.spyOn(aligner, 'runInWorker');
    const response = await member.get(wordsAt(0));
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({
      audioEditionId: editionId,
      track: 0,
      window: 0,
      lines: [
        { text: 'White rabbit.', startMs: 250, endMs: 800, words: [[0, 5, 250, 490], [6, 7, 500, 800]] },
        { text: 'Down.', startMs: 830, endMs: 1_030, words: [[0, 5, 830, 1_030]] },
      ],
    });
    const repeated = await owner.get(wordsAt(0));
    expect(repeated.statusCode).toBe(200);
    expect(repeated.body).toBe(response.body);
    expect(countWindowReads(work.mock.calls)).toBe(1);
    const detail = await bookDetail(member, book.id);
    expect(detail.editions[0]).toMatchObject({ readAlong: null, hasTranscript: true });
  });

  it('applies the same club access as the audio and refuses absent tracks or windows', async () => {
    const words = `/media/editions/${editionId}/spoken-words?track=0&window=0`;
    const media = `/media/editions/${editionId}/tracks/0`;
    for (const [client, code] of [[app.client(), 401], [stranger, 404]] as const) {
      expect((await client.get(media)).statusCode).toBe(code);
      const response = await client.get(words);
      expect(response.statusCode).toBe(code);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).not.toContain('rabbit');
    }
    const absent = await member.get(`/media/editions/${editionId}/spoken-words?track=1&window=0`);
    expect(absent.statusCode).toBe(404);
    expect(absent.headers['cache-control']).toBe('private, no-store');
    expect((await member.get(`/media/editions/${editionId}/spoken-words?track=0&window=1`)).statusCode).toBe(404);
    expect((await member.get(`/media/editions/${editionId}/spoken-words?track=0x&window=0`)).statusCode).toBe(404);
  });

  it('rebuilds a replaced transcript and serializes different windows', async () => {
    const replaced = await giveTranscript([sourceTrack(0, [[250, 490, 'Changed.']]), sourceTrack(1, [[250, 500, 'Second.']])]);
    expect(replaced.statusCode).toBe(202);
    await app.settle();
    const runWorker = aligner.runInWorker as (task: WorkTask, limits: aligner.WorkLimits) => Promise<WorkResult>;
    let activeReads = 0;
    let peakReads = 0;
    const observe = async (task: WorkTask, limits: aligner.WorkLimits) => {
      if (task.kind !== 'spoken-words') return runWorker(task, limits);
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      try {
        return await runWorker(task, limits);
      } finally {
        activeReads -= 1;
      }
    };
    const work = vi.spyOn(aligner, 'runInWorker').mockImplementation(observe as typeof aligner.runInWorker);
    const [first, second] = await Promise.all([member.get(wordsAt(0)), owner.get(wordsAt(1))]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ track: 0, lines: [{ text: 'Changed.' }] });
    expect(second.json()).toMatchObject({ track: 1, lines: [{ text: 'Second.' }] });
    expect(countWindowReads(work.mock.calls)).toBe(2);
    expect(peakReads).toBe(1);
    expect((await member.get(wordsAt(0))).body).toBe(first.body);
    expect(countWindowReads(work.mock.calls)).toBe(2);
  });

  it('rate limits each member independently even on cached windows', async () => {
    const reader = await joinClub(app, club, 'Ray');
    for (let attempt = 0; attempt < 12; attempt++) expect((await reader.get(wordsAt(0))).statusCode).toBe(200);
    const denied = await reader.get(wordsAt(0));
    expect(denied.statusCode).toBe(429);
    expect(denied.headers).toMatchObject({ 'cache-control': 'private, no-store', 'retry-after': '60' });
    expect((await owner.get(wordsAt(0))).statusCode).toBe(200);
  });
});
