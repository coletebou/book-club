import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ClubDetail } from '@bookclub/shared';
import { logCost } from '../src/cal/store';
import * as decoder from '../src/cal/voice/dictation-audio';
import { FIXTURES, type Client, type TestApp, closeApp, joinClub, makeTestApp, setupOwner } from './helpers';

const tone = readFileSync(path.join(FIXTURES, 'audio/voice-tone.wav'));

function dictate(client: Client, clubId: string, audio: Buffer = tone, mime = 'audio/wav', headers?: Record<string, string>) {
  const boundary = 'dictation-test-boundary';
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
    app = await makeTestApp({ CAL_STT_PROVIDER: 'fake', CAL_RATE_LIMIT_PER_MINUTE: '2', CAL_MONTHLY_SPEND_CAP_USD: '1', CAL_INSTANCE_MONTHLY_SPEND_CAP_USD: '2' });
    const setup = await setupOwner(app, 'Alice', 'Dictation Club');
    owner = setup.owner;
    club = setup.club;
    clubId = club.id;
    ownerId = (await owner.json<{ user: { id: string } }>(owner.get('/api/me'), 200)).user.id;
  });

  afterEach(async () => {
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

    // A small valid WAV whose header describes 31 seconds of 16 kHz mono PCM.
    const long = Buffer.alloc(44 + 31 * 16_000 * 2);
    tone.copy(long, 0, 0, 44);
    long.writeUInt32LE(long.length - 8, 4);
    long.writeUInt32LE(long.length - 44, 40);
    const reader = await joinClub(app, club, 'Dana');
    const tooLong = await dictate(reader, clubId, long);
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: { message: 'Recordings can be up to 30 seconds long.' } });
    expect(app.ctx.db.all('SELECT id FROM cal_cost_log WHERE club_id = ?', [clubId])).toHaveLength(0);
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
});
