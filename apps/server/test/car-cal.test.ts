import { CarCalReplySchema, type AudioLocator, type ClubDetail, type EditionTimeline, type TranscriptWord, locatorToM, tToLocator } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { insertChunks, logCost } from '../src/cal/store';
import { FakeTtsProvider } from '../src/cal/voice/fake';
import { editionFiles } from '../src/repos/books';
import { saveTranscript } from '../src/repos/readalong';
import * as aligner from '../src/services/aligner';
import { type Client, type TestApp, ALICE_TINY_AUDIO, audioTracks, bookDetail, closeApp, joinClub, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

describe('Cal’s spoken answers for CarPlay', () => {
  let app: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let bookId: string;
  let editionId: string;
  let timeline: EditionTimeline;
  let readers = 0;

  function at(t: number): AudioLocator {
    const loc = tToLocator(timeline, t);
    if (loc.kind !== 'audio') throw new Error('Expected an audio locator');
    return loc;
  }

  function question(kind = 'recap', position = at(0.55)) {
    return { question: kind, editionId, locator: position };
  }

  const ask = (client: Client, body = question()) => client.post(`/api/books/${bookId}/cal/spoken`, body);

  async function reader(): Promise<Client> {
    return joinClub(app, club, `Reader ${++readers}`);
  }

  async function savedProgress(client: Client) {
    await client.json(client.put(`/api/books/${bookId}/progress`, {
      editionId,
      locator: at(0.55),
      readSpans: [{ from: at(0.01), to: at(0.18) }, { from: at(0.45), to: at(0.55) }],
      at: Date.now(),
    }), 200);
  }

  beforeAll(async () => {
    app = await makeTestApp({
      ANTHROPIC_API_KEY: 'fake',
      CAL_TEST_FAKE_MODEL: 'true',
      CAL_TTS_PROVIDER: 'fake',
      CAL_TTS_CACHE_MB: '0',
      CAL_STT_PROVIDER: 'fake',
      CAL_RATE_LIMIT_PER_MINUTE: '2',
      CAL_MONTHLY_SPEND_CAP_USD: '1',
    });
    ({ owner, club } = await setupOwner(app));
    ({ bookId } = await uploadBook(owner, club.id, 'audio', audioTracks(ALICE_TINY_AUDIO), { title: 'Alice', author: 'Lewis Carroll' }));
    await app.settle();
    const edition = (await bookDetail(owner, bookId)).editions.find((entry) => entry.kind === 'audio')!;
    editionId = edition.id;
    timeline = { geometry: edition.geometry!, sync: edition.sync! };
    const passages = [
      { start: 0.06, end: 0.13, text: 'The silver scarf was handed over.' },
      { start: 0.25, end: 0.27, text: 'The skipped copper key escaped.' },
      { start: 0.60, end: 0.64, text: 'The future secret is the emerald crown.' },
    ];
    insertChunks(app.ctx.db, passages.map(({ start, end, text }, seq) => ({
      clubId: club.id, sourceType: 'book', bookId, editionId, shelfItemId: null,
      chapterTitle: null, tStart: start, tEnd: end, seq, text, tokenCount: 10,
    })));
    const files = editionFiles(app.ctx.db, editionId);
    const words = new Map<string, TranscriptWord[]>();
    for (const passage of passages) {
      const locator = at(passage.start);
      const file = files[locator.track]!;
      const end = Math.min(file.duration_ms!, locator.ms + 100);
      const track = words.get(file.blob_id) ?? [];
      track.push([locator.ms, end, passage.text]);
      words.set(file.blob_id, track);
    }
    saveTranscript(app.ctx.db, editionId, 'testing', [...words].map(([blobId, words]) => ({ blobId, words })));
  });

  afterAll(async () => {
    await closeApp(app);
  });

  it('requires the exact saved place and sends only passages already heard to both answer and speech', async () => {
    const member = await reader();
    const unsaved = await ask(member);
    expect(unsaved.statusCode).toBe(409);
    expect(unsaved.body).not.toContain('silver scarf');
    await savedProgress(member);
    const stale = await ask(member, question('recap', at(0.62)));
    expect(stale.statusCode).toBe(409);

    const res = await ask(member);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const answer = CarCalReplySchema.parse(res.json());
    expect(answer.answer).toContain('silver scarf');
    expect(answer.answer).not.toMatch(/copper key|emerald crown/);
    expect(Buffer.from(answer.audioBase64, 'base64').toString()).toContain('voice:cal');
  });

  it('uses the comment gate for the club’s notes and leaves hidden text out of the answer', async () => {
    for (const [position, text] of [[0.11, 'The scarf was blue.'], [0.25, 'The copper key was a decoy.']] as const) {
      await owner.json(owner.post(`/api/books/${bookId}/comments`, { editionId, locator: at(position), text, aboutHere: true }), 201);
    }
    const member = await reader();
    await savedProgress(member);
    const res = await ask(member, question('club'));
    expect(res.statusCode, res.body).toBe(200);
    expect(CarCalReplySchema.parse(res.json()).answer).toContain('scarf was blue');
    expect(res.body).not.toContain('copper key');
  });

  it('uses the original audio timings even while the existing search index is stale', async () => {
    const member = await reader();
    const locator = at(0.55);
    const measure = locatorToM(timeline.geometry, locator);
    if (timeline.geometry.kind !== 'audio') throw new Error('Expected an audio edition');
    const duration = timeline.geometry.trackDurationsMs.reduce((sum, length) => sum + length, 0);
    const changed = { points: [{ m: 0, t: 0 }, { m: measure, t: 0.82 }, { m: duration, t: 1 }] };
    app.ctx.db.exec('UPDATE editions SET sync_json = ? WHERE id = ?', [JSON.stringify(changed), editionId]);
    try {
      await member.json(member.put(`/api/books/${bookId}/progress`, {
        editionId, locator, at: Date.now(), readSpans: [{ from: at(0.01), to: locator }],
      }), 200);
      const reply = await ask(member);
      expect(reply.statusCode).toBe(200);
      expect(CarCalReplySchema.parse(reply.json()).answer).toContain('silver scarf');
      expect(reply.body).not.toContain('emerald crown');
    } finally {
      app.ctx.db.exec('UPDATE editions SET sync_json = ? WHERE id = ?', [JSON.stringify(timeline.sync), editionId]);
    }
  });

  it('refuses outsiders and signed-out callers without emitting a cacheable response', async () => {
    const out = await outsider(app, owner);
    const refused = await ask(out);
    expect(refused.statusCode).toBe(404);
    expect(refused.headers['cache-control']).toBe('private, no-store');
    expect((await ask(app.client())).statusCode).toBe(401);
  });

  it('caps the combined text and car turns for the member', async () => {
    const member = await reader();
    await savedProgress(member);
    const thread = await member.json<{ id: string }>(member.post(`/api/clubs/${club.id}/cal/conversations`, { bookId }), 201);
    expect((await member.post(`/api/cal/conversations/${thread.id}/messages`, { text: 'Who is here?' })).statusCode).toBe(200);
    expect((await ask(member)).statusCode).toBe(200);
    expect((await ask(member)).statusCode).toBe(429);
    const socket = new WebSocket(`${app.baseUrl.replace(/^http/, 'ws')}/ws/cal/voice?clubId=${club.id}&conversationId=${thread.id}`, { headers: { cookie: member.cookieHeader, origin: app.baseUrl } });
    try {
      const blocked = await new Promise<unknown>((resolve, reject) => {
        socket.once('open', () => {
          socket.send(JSON.stringify({ type: 'start', mimeType: 'audio/webm' }));
          socket.send(Buffer.from([1, 2, 3]));
          socket.send(JSON.stringify({ type: 'end' }));
        });
        socket.on('message', (data, binary) => {
          if (!binary) resolve(JSON.parse(String(data)));
        });
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Voice socket closed')));
      });
      expect(blocked).toMatchObject({ type: 'error', message: expect.stringContaining('last minute') });
    } finally {
      socket.close();
    }
  });

  it('fails privately when the provider produces more than one MiB of speech', async () => {
    const member = await reader();
    await savedProgress(member);
    const large = vi.spyOn(FakeTtsProvider.prototype, 'speak').mockImplementationOnce(async function* () { yield new Uint8Array(1_048_577); });
    try {
      const refused = await ask(member);
      expect(refused.statusCode).toBe(502);
      expect(refused.headers['cache-control']).toBe('private, no-store');
      expect(refused.json()).toMatchObject({ error: { code: 'spoken_answer_too_large' } });
      expect(refused.body).not.toContain('audioBase64');
    } finally {
      large.mockRestore();
    }
  });

  it('does not return an answer for a session revoked during speech generation', async () => {
    const member = await reader();
    await savedProgress(member);
    let begin!: () => void;
    let finish!: () => void;
    const began = new Promise<void>((resolve) => { begin = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const held = vi.spyOn(FakeTtsProvider.prototype, 'speak').mockImplementationOnce(async function* () {
      begin();
      await finished;
      yield new Uint8Array([1, 2, 3]);
    });
    const pending = ask(member);
    try {
      await began;
      expect((await member.post('/api/auth/signout')).statusCode).toBe(204);
      finish();
      const refused = await pending;
      expect(refused.statusCode).toBe(401);
      expect(refused.body).not.toContain('audioBase64');
    } finally {
      finish();
      held.mockRestore();
    }
  });

  it('aborts a slow speech provider at the thirty-second generation deadline', async () => {
    const member = await reader();
    await savedProgress(member);
    let signal!: AbortSignal;
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const provider = vi.spyOn(FakeTtsProvider.prototype, 'speak').mockImplementationOnce(async function* (_text, opts) {
      signal = opts.signal;
      signal.addEventListener('abort', release, { once: true });
      begin();
      await held;
      yield new Uint8Array([1, 2, 3]);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = ask(member);
    try {
      await started;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      const refused = await pending;
      expect(refused.statusCode).toBe(504);
      expect(refused.json()).toMatchObject({ error: { code: 'answer_timeout' } });
      expect(refused.body).not.toContain('audioBase64');
    } finally {
      release();
      vi.useRealTimers();
      await pending;
      provider.mockRestore();
    }
  });

  it('bounds simultaneous transcript reads and accepts the second reader after the first completes', async () => {
    const first = await reader();
    const second = await reader();
    await savedProgress(first);
    await savedProgress(second);
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runInWorker = aligner.runInWorker;
    const worker = vi.spyOn(aligner, 'runInWorker').mockImplementationOnce(async (task, limits) => {
      begin();
      await held;
      return runInWorker(task, limits);
    });
    const pending = ask(first);
    try {
      await started;
      const busy = await ask(second);
      expect(busy.statusCode).toBe(503);
      expect(busy.json()).toMatchObject({ error: { code: 'source_busy' } });
      expect(worker).toHaveBeenCalledTimes(1);
      release();
      expect((await pending).statusCode).toBe(200);
      expect((await ask(second)).statusCode).toBe(200);
    } finally {
      release();
      await pending;
      worker.mockRestore();
    }
  });

  it('returns 402 when the club’s logged spend has reached its cap', async () => {
    const member = await reader();
    await savedProgress(member);
    logCost(app.ctx.db, { clubId: club.id, userId: null, kind: 'chat', provider: 'test', model: 'test', inputUnits: 1, outputUnits: 1, costUsd: 1.01 });
    const refused = await ask(member);
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({ error: { code: 'spend_cap' } });
  });
});
