import { type ChildProcess, execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ClubDetail } from '@bookclub/shared';
import WebSocket from 'ws';
import { logCost } from '../src/cal/store';
import * as decoder from '../src/cal/voice/dictation-audio';
import { ElevenLabsSttProvider } from '../src/cal/voice/elevenlabs';
import { setFfmpegAvailableForTests } from '../src/services/note-media';
import { FIXTURES, type Client, type TestApp, closeApp, joinClub, makeTestApp, setupOwner } from './helpers';

const tone = readFileSync(path.join(FIXTURES, 'audio/voice-tone.wav'));
const boundary = 'dictation-test-boundary';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile: vi.fn(original.execFile) };
});

function uploadWithoutEnding(app: TestApp, client: Client, clubId: string, body: 'headers' | 'recording' | 'invalid') {
  const outgoing = request(`${app.baseUrl}/api/clubs/${clubId}/dictation`, {
    method: 'POST', agent: false,
    headers: {
      cookie: client.cookieHeader, origin: app.baseUrl,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': '10000', connection: 'keep-alive',
    },
  });
  const result = new Promise<{ status: number | undefined; connection: string | undefined } | string | undefined>((resolve) => {
    outgoing.once('response', (res) => { res.resume(); resolve({ status: res.statusCode, connection: res.headers.connection }); });
    outgoing.once('error', (err: NodeJS.ErrnoException) => resolve(err.code));
  });
  outgoing.flushHeaders();
  if (body !== 'headers') {
    const field = body === 'invalid' ? 'wrong-field' : 'file';
    outgoing.write(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="in.wav"\r\nContent-Type: audio/wav\r\n\r\nsample`);
    if (body === 'invalid') outgoing.write(`\r\n--${boundary}--\r\n`);
  }
  return { outgoing, result };
}

function dictate(client: Client, clubId: string, audio: Buffer = tone, mime = 'audio/wav', headers?: Record<string, string>) {
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: ${mime}\r\n\r\n`),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return client.post(`/api/clubs/${clubId}/dictation`, payload, { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers });
}

describe('dictation', () => {
  let app: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let clubId: string;
  let ownerId: string;

  beforeEach(async () => {
    app = await makeTestApp({ ANTHROPIC_API_KEY: 'test-only', CAL_TEST_FAKE_MODEL: 'true', CAL_STT_PROVIDER: 'fake', CAL_TTS_PROVIDER: 'fake', CAL_RATE_LIMIT_PER_MINUTE: '2', CAL_MONTHLY_SPEND_CAP_USD: '1', CAL_INSTANCE_MONTHLY_SPEND_CAP_USD: '2' });
    const setup = await setupOwner(app, 'Alice', 'Dictation Club');
    owner = setup.owner;
    club = setup.club;
    clubId = club.id;
    ownerId = (await owner.json<{ user: { id: string } }>(owner.get('/api/me'), 200)).user.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setFfmpegAvailableForTests(null);
    await closeApp(app);
  });

  it('returns a private transcript and counts the speech call without creating a Cal conversation or message', async () => {
    const res = await dictate(owner, clubId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toEqual({ text: 'Tell me about chapter one.' });
    expect(app.ctx.db.all('SELECT club_id, user_id, kind, provider, model FROM cal_cost_log')).toEqual([
      { club_id: clubId, user_id: ownerId, kind: 'voice_stt', provider: 'fake', model: 'fake-stt' },
    ]);
    expect(app.ctx.db.all('SELECT id FROM cal_conversations')).toHaveLength(0);
  });

  it('requires sign-in and refuses a signed-in member of another club', async () => {
    expect((await dictate(app.client(), clubId)).statusCode).toBe(401);
    const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Other Club' }), 201);
    const outside = await joinClub(app, other, 'Bess');
    expect((await dictate(outside, clubId)).statusCode).toBe(404);
    expect((await dictate(outside, other.id)).statusCode).toBe(200);
  });

  it('accepts fragmented MP4 and requires the posting session to match the draft owner', async () => {
    const member = await joinClub(app, club, 'Bea');
    const stale = await dictate(member, clubId, tone, 'audio/wav', { 'x-bookclub-user': ownerId });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'session_changed' } });
    expect(app.ctx.db.all('SELECT id FROM cal_cost_log')).toHaveLength(0);

    const mp4 = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { input: tone, timeout: 5000 });
    const res = await dictate(member, clubId, mp4, 'audio/mp4');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'Tell me about chapter one.' });
  });

  it('cancels decoding on disconnect before the clip can reach the speech provider', async () => {
    let entered!: (signal: AbortSignal) => void;
    const decoding = new Promise<AbortSignal>((resolve) => { entered = resolve; });
    const mock = vi.spyOn(decoder, 'decodeDictationAudio').mockImplementationOnce(async (_clip, _mime, signal) => {
      entered(signal);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { audio: tone, durationSeconds: 2 };
    });
    const controller = new AbortController();
    const body = new FormData();
    body.append('file', new Blob([new Uint8Array(tone)], { type: 'audio/wav' }), 'clip.wav');
    const response = fetch(`${app.baseUrl}/api/clubs/${clubId}/dictation`, {
      method: 'POST',
      headers: { cookie: owner.cookieHeader, origin: app.baseUrl },
      body,
      signal: controller.signal,
    }).catch((err: unknown) => err);
    try {
      const signal = await decoding;
      controller.abort();
      expect(await response).toMatchObject({ name: 'AbortError' });
      await expect.poll(() => signal.aborted).toBe(true);
      expect(app.ctx.db.all('SELECT id FROM cal_cost_log')).toHaveLength(0);
    } finally {
      controller.abort();
      mock.mockRestore();
    }
  });

  it('bounds what is uploaded and decoded before calling the provider', async () => {
    expect((await dictate(owner, clubId, Buffer.alloc(2 * 1024 * 1024 + 1))).statusCode).toBe(413);
    expect((await dictate(owner, clubId, Buffer.from('not a recording'))).statusCode).toBe(400);

    // 31 seconds of audio compressed to a small fraction of the wire limit.
    const long = Buffer.alloc(44 + 31 * 16_000 * 2);
    tone.copy(long, 0, 0, 44);
    long.writeUInt32LE(long.length - 8, 4);
    long.writeUInt32LE(long.length - 44, 40);
    const compressed = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { input: long, timeout: 5000 });
    expect(compressed.length).toBeLessThan(32_000);
    const reader = await joinClub(app, club, 'Dana');
    const tooLong = await dictate(reader, clubId, compressed, 'audio/ogg');
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: { message: 'Recordings can be up to 30 seconds long.' } });
    expect(app.ctx.db.all('SELECT id FROM cal_cost_log WHERE club_id = ?', [clubId])).toHaveLength(0);
  });

  it('shares the rate limit with spoken Cal on the same instance', async () => {
    expect((await dictate(owner, clubId)).statusCode).toBe(200);
    expect((await dictate(owner, clubId)).statusCode).toBe(200);
    const { id } = await owner.json<{ id: string }>(owner.post(`/api/clubs/${clubId}/cal/conversations`, {}), 201);
    const socket = new WebSocket(`${app.baseUrl.replace('http:', 'ws:')}/ws/cal/voice?clubId=${clubId}&conversationId=${id}`, {
      headers: { cookie: owner.cookieHeader, origin: app.baseUrl },
    });
    try {
      await once(socket, 'open');
      const next = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'start', mimeType: 'audio/wav' }));
      socket.send(tone);
      socket.send(JSON.stringify({ type: 'end' }));
      const [event] = await next;
      expect(JSON.parse(String(event))).toMatchObject({ type: 'error', message: expect.stringContaining('last minute') });
    } finally {
      socket.terminate();
    }
    expect(app.ctx.db.all('SELECT id FROM cal_cost_log')).toHaveLength(2);
  });

  it('limits requests per member and enforces both monthly spend caps', async () => {
    const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Other Club' }), 201);
    expect((await dictate(owner, clubId)).statusCode).toBe(200);
    expect((await dictate(owner, clubId)).statusCode).toBe(200);
    expect((await dictate(owner, clubId)).statusCode).toBe(429);
    const reader = await joinClub(app, club, 'Gina');
    logCost(app.ctx.db, { clubId: clubId, userId: null, kind: 'voice_stt', provider: 'test', model: 'test', inputUnits: 0, outputUnits: 0, costUsd: 1 });
    const clubCap = await dictate(reader, clubId);
    expect(clubCap.statusCode).toBe(402);
    expect(clubCap.json()).toMatchObject({ error: { code: 'spend_cap', message: 'This club has reached its Cal budget for this month.' } });
    logCost(app.ctx.db, { clubId: other.id, userId: null, kind: 'voice_stt', provider: 'test', model: 'test', inputUnits: 0, outputUnits: 0, costUsd: 1 });
    const fresh = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Fresh Club' }), 201);
    const freshReader = await joinClub(app, fresh, 'Hana');
    const instanceCap = await dictate(freshReader, fresh.id);
    expect(instanceCap.statusCode).toBe(402);
    expect(instanceCap.json()).toMatchObject({ error: { code: 'spend_cap', message: "Cal has reached this month's budget for every club here." } });
  });

  it('rejects a club at its spend cap as soon as upload headers arrive', async () => {
    logCost(app.ctx.db, { clubId, userId: null, kind: 'voice_stt', provider: 'test', model: 'test', inputUnits: 0, outputUnits: 0, costUsd: 1 });
    const upload = uploadWithoutEnding(app, owner, clubId, 'headers');
    try {
      expect(await upload.result).toEqual({ status: 402, connection: 'close' });
    } finally {
      upload.outgoing.destroy();
    }
  });

  it('closes the connection after rejecting a bad multipart field with bytes still outstanding', async () => {
    const upload = uploadWithoutEnding(app, owner, clubId, 'invalid');
    try {
      expect(await upload.result).toEqual({ status: 400, connection: 'close' });
    } finally {
      upload.outgoing.destroy();
    }
  });

  it('closes incomplete uploads even before the first multipart boundary or after a file starts', { timeout: 18_000 }, async () => {
    const uploads = [uploadWithoutEnding(app, owner, clubId, 'headers'), uploadWithoutEnding(app, owner, clubId, 'recording')];
    try {
      const started = performance.now();
      expect(await Promise.all(uploads.map((upload) => upload.result))).toEqual(['ECONNRESET', 'ECONNRESET']);
      expect(performance.now() - started).toBeGreaterThanOrEqual(9_500);
      expect(app.ctx.db.all('SELECT id FROM cal_cost_log')).toHaveLength(0);
    } finally {
      for (const upload of uploads) upload.outgoing.destroy();
    }
  });

  it('bounds concurrent decodes and releases the slots when their children finish', async () => {
    const member = await joinClub(app, club, 'Other dictation member');
    const pending: (() => void)[] = [];
    const heldChild: typeof execFile = ((...args: unknown[]) => {
      const done = args.at(-1) as (err: null, stdout: Buffer, stderr: Buffer) => void;
      pending.push(() => done(null, tone.subarray(44), Buffer.alloc(0)));
      return { kill: vi.fn() } as unknown as ChildProcess;
    }) as typeof execFile;
    vi.mocked(execFile).mockImplementationOnce(heldChild).mockImplementationOnce(heldChild);
    const started = [dictate(owner, clubId), dictate(owner, clubId)];
    try {
      await expect.poll(() => pending.length).toBe(2);
      const busy = await dictate(member, clubId);
      expect(busy.statusCode).toBe(503);
      expect(busy.headers['retry-after']).toBe('5');
      expect(app.ctx.db.all('SELECT id FROM cal_cost_log')).toHaveLength(0);
    } finally {
      for (const finish of pending) finish();
      await Promise.all(started);
    }
    expect((await dictate(member, clubId)).statusCode).toBe(200);
  });

  it('returns 415 for unsupported audio and marks a killed decoder as temporarily unavailable', async () => {
    expect((await dictate(owner, clubId, tone, 'audio/flac')).statusCode).toBe(415);
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
      const done = args.at(-1) as (err: Error, stdout: Buffer, stderr: Buffer) => void;
      queueMicrotask(() => done(Object.assign(new Error('decoder timeout'), { killed: true }), Buffer.alloc(0), Buffer.alloc(0)));
      return { kill: vi.fn() } as unknown as ChildProcess;
    }) as typeof execFile);
    const timedOut = await dictate(owner, clubId);
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.json()).toMatchObject({ error: { code: 'decoder_timeout' } });
  });

  it('hides dictation and refuses uploads when the decoder is unavailable', async () => {
    setFfmpegAvailableForTests(false);
    const noDecoder = await makeTestApp({ CAL_STT_PROVIDER: 'fake' });
    try {
      const { owner: member, club: testClub } = await setupOwner(noDecoder);
      const status = await member.json(member.get(`/api/clubs/${testClub.id}/cal/status`), 200);
      expect(status).toMatchObject({ dictation: false });
      expect((await dictate(member, testClub.id)).statusCode).toBe(503);
    } finally {
      await closeApp(noDecoder);
    }
  });

  it('answers 404 with no configured speech provider', async () => {
    const unconfigured = await makeTestApp({ CAL_STT_PROVIDER: 'elevenlabs' });
    try {
      const { owner: member, club: testClub } = await setupOwner(unconfigured);
      expect(await member.json(member.get(`/api/clubs/${testClub.id}/cal/status`), 200)).toMatchObject({ dictation: false });
      expect((await dictate(member, testClub.id)).statusCode).toBe(404);
    } finally {
      await closeApp(unconfigured);
    }
  });

  it('logs the estimated cost when a paid speech request fails', async () => {
    const provider = vi.spyOn(ElevenLabsSttProvider.prototype, 'transcribe').mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
    const paid = await makeTestApp({ CAL_STT_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'test-only' });
    try {
      const { owner: member, club: testClub } = await setupOwner(paid);
      expect((await dictate(member, testClub.id)).statusCode).toBe(502);
      expect(provider).toHaveBeenCalledOnce();
      const costs = paid.ctx.db.all<{ cost_usd: number }>("SELECT cost_usd FROM cal_cost_log WHERE provider = 'elevenlabs' AND kind = 'voice_stt'");
      expect(costs).toHaveLength(1);
      expect(costs[0]!.cost_usd).toBeCloseTo(2 / 60 * 0.04, 8);
    } finally {
      await closeApp(paid);
    }
  });
});
