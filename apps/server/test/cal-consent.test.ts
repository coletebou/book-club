import { type CalConsent, type ChatMessageView } from '@bookclub/shared';
import { once } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DeterministicFakeChatModel } from '../src/cal/fake-model';
import { FakeSttProvider } from '../src/cal/voice/fake';
import { mergeAccounts } from '../src/services/account-merge';
import { ALICE_TINY_AUDIO, type Client, type TestApp, allowCal, audioTracks, bookDetail, closeApp, joinClub, makeTestApp, openSocket, setupOwner, uploadBook } from './helpers';

const consentPath = '/api/cal/consent';

function voice(app: TestApp, client: Client, clubId: string, conversationId: string): WebSocket {
  const url = new URL(`/ws/cal/voice?clubId=${clubId}&conversationId=${conversationId}`, app.baseUrl);
  url.protocol = 'ws:';
  return new WebSocket(url, { headers: { Cookie: client.cookieHeader, Origin: app.baseUrl } });
}

describe('account consent for Cal', () => {
  it('names the configured AI recipients before the account has opted in', async () => {
    const app = await makeTestApp({
      ANTHROPIC_API_KEY: 'test-only',
      OPENAI_API_KEY: 'test-only',
      ELEVENLABS_API_KEY: 'test-only',
    });
    try {
      const { owner } = await setupOwner(app);
      const response = await owner.get(consentPath);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json<CalConsent>()).toMatchObject({
        allowed: false,
        providers: ['Anthropic', 'OpenAI', 'ElevenLabs'],
      });
    } finally {
      await closeApp(app);
    }
  });

  it.each([false, true])('requires the public names of custom gateways before granting consent (named %s)', async (named) => {
    const app = await makeTestApp({
      ANTHROPIC_API_KEY: 'test-only',
      ANTHROPIC_BASE_URL: 'https://gateway.example.invalid/anthropic',
      ANTHROPIC_AUTH_MODE: 'bearer',
      ANTHROPIC_TENANT_ID: 'test',
      CAL_SOL_BASE_URL: 'https://gateway.example.invalid/openai',
      CAL_SOL_INPUT_USD_PER_MILLION: '6',
      CAL_SOL_OUTPUT_USD_PER_MILLION: '20',
      CAL_WEB_SEARCH: 'false',
      ...(named ? { PRIVACY_POLICY: JSON.stringify({ endpoints: { cal: 'Example Gateway', calFallback: 'Example Gateway' } }) } : {}),
    });
    try {
      const { owner } = await setupOwner(app);
      const status = await owner.json<CalConsent>(owner.get(consentPath), 200);
      expect(status.enabled).toBe(named);
      expect(status.providers).toEqual(named ? ['Example Gateway', 'Anthropic', 'OpenAI'] : []);
      expect((await owner.put(consentPath, { allow: true, version: status.version })).statusCode).toBe(named ? 200 : 404);
    } finally {
      await closeApp(app);
    }
  });

  it('refuses unconsented text, voice and car requests, then honors Allow and revoke per account', async () => {
    const app = await makeTestApp({
      ANTHROPIC_API_KEY: 'fake',
      CAL_TEST_FAKE_MODEL: 'true',
      CAL_EMBEDDING_PROVIDER: 'fake',
      CAL_STT_PROVIDER: 'fake',
      CAL_TTS_PROVIDER: 'fake',
    });
    try {
      const { owner, club } = await setupOwner(app);
      const friend = await joinClub(app, club, 'Friend');
      const check = (client: Client) => client.json<CalConsent>(client.get(consentPath), 200);
      const spoken = (client: Client) => client.json<{ enabled: boolean }>(client.get('/api/cal/spoken/status'), 200);
      const conversationPath = `/api/clubs/${club.id}/cal/conversations`;
      const { bookId } = await uploadBook(owner, club.id, 'audio', audioTracks(ALICE_TINY_AUDIO), { title: 'Alice' });
      await app.settle();
      const editionId = (await bookDetail(owner, bookId)).editions[0]!.id;
      const carPath = `/api/books/${bookId}/cal/spoken`;
      const carBody = { question: 'recap', editionId, locator: { kind: 'audio', track: 0, ms: 1 } };
      const testCode = (result: Awaited<ReturnType<Client['post']>>, code: string) => {
        expect(result.statusCode).toBe(403);
        expect(result.json<{ error: { code: string } }>().error.code).toBe(code);
      };

      const before = await check(owner);
      expect(before).toMatchObject({ enabled: true, allowed: false });
      expect(await spoken(owner)).toEqual({ enabled: false });
      testCode(await owner.post(conversationPath, {}), 'cal_consent_required');
      testCode(await owner.post(carPath, carBody), 'cal_consent_required');
      expect((await owner.put(consentPath, { allow: true, version: '0'.repeat(64) })).statusCode).toBe(409);
      const allowed = await owner.json<CalConsent>(owner.put(consentPath, { allow: true, version: before.version }), 200);
      expect(allowed.allowed).toBe(true);
      expect((await check(friend)).allowed).toBe(false);
      expect(await spoken(owner)).toEqual({ enabled: true });
      expect(await spoken(friend)).toEqual({ enabled: false });
      const created = await owner.json<{ id: string }>(owner.post(conversationPath, {}), 201);
      const messages = `/api/cal/conversations/${created.id}/messages`;
      const answer = await owner.post(messages, { text: 'Tell me something about Alice.' });
      expect(answer.statusCode).toBe(200);
      expect(answer.headers['content-type']).toContain('text/event-stream');

      const voiceSocket = voice(app, owner, club.id, created.id);
      await once(voiceSocket, 'open');
      const voiceClosed = once(voiceSocket, 'close');
      expect((await owner.json<CalConsent>(owner.put(consentPath, { allow: false }), 200)).allowed).toBe(false);
      expect((await check(owner)).allowed).toBe(false);
      expect(await spoken(owner)).toEqual({ enabled: false });
      testCode(await owner.post(messages, { text: 'This must not be sent.' }), 'cal_consent_required');
      testCode(await owner.post(carPath, carBody), 'cal_consent_required');
      voiceSocket.send(JSON.stringify({ type: 'end' }));
      expect((await voiceClosed)[0]).toBe(4003);
      const rejected = voice(app, owner, club.id, created.id);
      expect((await once(rejected, 'close'))[0]).toBe(4003);
    } finally {
      await closeApp(app);
    }
  });

  it('keeps @Cal chat local until the account has allowed AI access', async () => {
    const app = await makeTestApp({ CAL_TEST_FAKE_MODEL: 'true', CAL_EMBEDDING_PROVIDER: 'fake' });
    try {
      const { owner, club } = await setupOwner(app);
      const socket = await openSocket(app, owner);
      try {
        const route = `/api/clubs/${club.id}/chat`;
        const first = await owner.json<ChatMessageView>(owner.post(route, { text: '@Cal Can you answer this?' }), 201);
        const notice = await socket.next('chat:notice', (message) => message.messageId === first.id);
        expect(notice.calConsentRequired).toBe(true);
        await app.settle();
        const thread = await owner.json<{ replies: ChatMessageView[] }>(owner.get(`/api/chat/${first.id}/thread`), 200);
        expect(thread.replies).toEqual([]);
        const { version } = await owner.json<CalConsent>(owner.get(consentPath), 200);
        await owner.json(owner.put(consentPath, { allow: true, version }), 200);
        const second = await owner.json<ChatMessageView>(owner.post(route, { text: '@Cal Can you answer now?' }), 201);
        await app.settle();
        const answered = await owner.json<{ replies: ChatMessageView[] }>(owner.get(`/api/chat/${second.id}/thread`), 200);
        expect(answered.replies.some((message) => message.author.agent === 'cal')).toBe(true);
      } finally {
        await socket.close();
      }
    } finally {
      await closeApp(app);
    }
  });

  it('does not send a transcript to the model when consent was revoked during transcription', async () => {
    const app = await makeTestApp({ ANTHROPIC_API_KEY: 'fake', CAL_TEST_FAKE_MODEL: 'true', CAL_STT_PROVIDER: 'fake', CAL_TTS_PROVIDER: 'fake' });
    let transcriptionStarted!: () => void;
    let finishTranscript!: (reply: { text: string; costUsd: number }) => void;
    const reachedStt = new Promise<void>((resolve) => { transcriptionStarted = resolve; });
    const transcript = new Promise<{ text: string; costUsd: number }>((resolve) => { finishTranscript = resolve; });
    const stt = vi.spyOn(FakeSttProvider.prototype, 'transcribe').mockImplementation(() => {
      transcriptionStarted();
      return transcript;
    });
    const model = vi.spyOn(DeterministicFakeChatModel.prototype, 'stream');
    try {
      const { owner, club } = await setupOwner(app);
      await allowCal(owner);
      const thread = await owner.json<{ id: string }>(owner.post(`/api/clubs/${club.id}/cal/conversations`, {}), 201);
      const socket = voice(app, owner, club.id, thread.id);
      try {
        await once(socket, 'open');
        socket.send(JSON.stringify({ type: 'start', mimeType: 'audio/webm' }));
        socket.send(Buffer.from('a demo recording'));
        socket.send(JSON.stringify({ type: 'end' }));
        await reachedStt;
        expect((await owner.put(consentPath, { allow: false })).statusCode).toBe(200);
        const reported = once(socket, 'message');
        finishTranscript({ text: 'The earlier recording must stay here.', costUsd: 0 });
        expect(JSON.parse(String((await reported)[0]))).toMatchObject({ type: 'error' });
        expect(model).not.toHaveBeenCalled();
      } finally {
        socket.close();
      }
    } finally {
      finishTranscript({ text: '', costUsd: 0 });
      model.mockRestore();
      stt.mockRestore();
      await closeApp(app);
    }
  });

  it('moves ordinary settings without granting the losing account’s AI access to the kept account', async () => {
    const app = await makeTestApp({ CAL_TEST_FAKE_MODEL: 'true' });
    try {
      const { owner, club } = await setupOwner(app);
      const other = await joinClub(app, club, 'Other account');
      await allowCal(other);
      expect((await other.put('/api/cal/settings', { wholeSeries: true })).statusCode).toBe(200);
      await mergeAccounts({
        db: app.ctx.db,
        dbFile: app.ctx.storage.dbFile,
        loserId: (await other.json<{ user: { id: string } }>(other.get('/api/session'), 200)).user.id,
        survivorId: (await owner.json<{ user: { id: string } }>(owner.get('/api/session'), 200)).user.id,
        reason: 'Test account merge',
        apply: true,
        backupDir: path.join(app.dir, 'backups'),
      });
      expect(await owner.json(owner.get('/api/cal/settings'), 200)).toEqual({ wholeSeries: true });
      expect(await owner.json<CalConsent>(owner.get(consentPath), 200)).toMatchObject({ allowed: false, hasGrant: false });
    } finally {
      await closeApp(app);
    }
  });
});
