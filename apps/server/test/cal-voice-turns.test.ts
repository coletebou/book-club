import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { FakeSttProvider, FakeTtsProvider } from '../src/cal/voice/fake';
import { type Client, type TestApp, allowCal, closeApp, joinClub, makeTestApp, setupOwner } from './helpers';

interface VoiceEvent {
  readonly type: string;
  readonly outcome?: string;
  readonly text?: string;
}

function nextEvents(socket: WebSocket, final: (event: VoiceEvent) => boolean): Promise<VoiceEvent[]> {
  return new Promise((resolve, reject) => {
    const events: VoiceEvent[] = [];
    const close = (code: number, reason: Buffer) => {
      detach();
      reject(new Error(`Closed ${code} ${reason.toString()}`));
    };
    const message = (data: WebSocket.RawData, binary: boolean) => {
      const event = binary ? { type: 'audio' } : JSON.parse(data.toString()) as VoiceEvent;
      events.push(event);
      if (final(event)) {
        detach();
        resolve(events);
      }
    };
    const detach = () => {
      socket.off('message', message);
      socket.off('close', close);
    };
    socket.on('message', message);
    socket.once('close', close);
  });
}

function sendTurn(socket: WebSocket, { handsFree = true, silent = false } = {}) {
  socket.send(JSON.stringify({ type: 'start', mimeType: 'audio/mp4', handsFree }));
  if (!silent) socket.send(Buffer.from('test recording'));
  socket.send(JSON.stringify({ type: 'end' }));
}

function pauseTranscription(text: string) {
  let entered!: () => void;
  const transcribing = new Promise<void>((resolve) => { entered = resolve; });
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  vi.spyOn(FakeSttProvider.prototype, 'transcribe').mockImplementationOnce(async () => {
    entered();
    await pending;
    return { text, costUsd: 0 };
  });
  return { transcribing, complete };
}

describe('Cal voice turns', () => {
  let app: TestApp;
  let owner: Client;
  let club: Awaited<ReturnType<typeof setupOwner>>['club'];
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    app = await makeTestApp({ CAL_TEST_FAKE_MODEL: 'true', CAL_EMBEDDING_PROVIDER: 'fake', CAL_STT_PROVIDER: 'fake', CAL_TTS_PROVIDER: 'fake' });
    ({ owner, club } = await setupOwner(app));
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    vi.restoreAllMocks();
    await closeApp(app);
  });

  const open = async (member: Client) => {
    await allowCal(member);
    const url = `/api/clubs/${club.id}/cal/conversations`;
    const { id } = await member.json<{ id: string }>(member.post(url, {}), 201);
    const socketUrl = `${app.baseUrl.replace(/^http/, 'ws')}/ws/cal/voice?clubId=${club.id}&conversationId=${id}`;
    const socket = new WebSocket(socketUrl, { headers: { cookie: member.cookieHeader, origin: app.baseUrl } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return { socket, id };
  };

  it('ends a silent turn, answers a question, then takes a follow-up on the same connection', async () => {
    const { socket, id } = await open(owner);
    const silent = nextEvents(socket, (e) => e.type === 'turnDone');
    sendTurn(socket, { silent: true });
    expect(await silent).toEqual([{ type: 'turnDone', outcome: 'silent' }]);
    expect(app.ctx.db.all('SELECT id FROM cal_cost_log')).toHaveLength(0);

    for (let i = 0; i < 2; i += 1) {
      const turn = nextEvents(socket, (e) => e.type === 'turnDone');
      sendTurn(socket);
      const events = await turn;
      expect(events[0]).toEqual({ type: 'transcript', text: 'Tell me about chapter one.' });
      expect(events.find((e) => e.type === 'audio')).toBeDefined();
      expect(events.slice(-2)).toEqual([{ type: 'speakingEnd' }, { type: 'turnDone', outcome: 'answered' }]);
    }
    const detail = await owner.json<{ messages: { role: string }[] }>(owner.get(`/api/cal/conversations/${id}`), 200);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('recognizes a spoken stop only in hands-free mode and does not save it as a question', async () => {
    vi.spyOn(FakeSttProvider.prototype, 'transcribe').mockResolvedValue({ text: ' Stop! ', costUsd: 0 });
    const { socket, id } = await open(owner);
    const stop = nextEvents(socket, (e) => e.type === 'turnDone');
    sendTurn(socket);
    expect(await stop).toEqual([{ type: 'turnDone', outcome: 'stopped' }]);
    const detail = await owner.json<{ messages: unknown[] }>(owner.get(`/api/cal/conversations/${id}`), 200);
    expect(detail.messages).toEqual([]);
    expect(app.ctx.db.all("SELECT kind FROM cal_cost_log WHERE kind = 'voice_stt'")).toHaveLength(1);

    const question = nextEvents(socket, (e) => e.type === 'turnDone');
    sendTurn(socket, { handsFree: false });
    const events = await question;
    expect(events.at(-1)).toEqual({ type: 'turnDone', outcome: 'answered' });
    expect(events.find((e) => e.type === 'transcript')).toMatchObject({ text: ' Stop! ' });
  });

  it('acknowledges interruption and saves no question from the interrupted transcription', async () => {
    const { transcribing, complete } = pauseTranscription('This question has been interrupted.');
    const { socket, id } = await open(owner);
    sendTurn(socket);
    await transcribing;
    const stopped = nextEvents(socket, (e) => e.type === 'turnDone');
    socket.send(JSON.stringify({ type: 'bargeIn' }));
    expect(await stopped).toEqual([{ type: 'turnDone', outcome: 'aborted' }]);
    complete();

    const next = nextEvents(socket, (e) => e.type === 'turnDone');
    sendTurn(socket);
    const events = await next;
    expect(events.filter((e) => e.type === 'transcript')).toEqual([{ type: 'transcript', text: 'Tell me about chapter one.' }]);
    const detail = await owner.json<{ messages: { role: string }[] }>(owner.get(`/api/cal/conversations/${id}`), 200);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(app.ctx.db.all("SELECT kind FROM cal_cost_log WHERE kind = 'voice_stt'")).toHaveLength(2);
  });

  it('closes the spoken reply before announcing interruption to a legacy client', async () => {
    vi.spyOn(FakeTtsProvider.prototype, 'speak').mockImplementationOnce(async function* (_text, { signal }) {
      yield new Uint8Array([1]);
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const { socket } = await open(owner);
    const before = nextEvents(socket, (e) => e.type === 'speakingStart');
    sendTurn(socket, { handsFree: false });
    await before;

    const after = nextEvents(socket, (e) => e.type === 'turnDone');
    socket.send(JSON.stringify({ type: 'bargeIn' }));
    expect((await after).slice(-2)).toEqual([{ type: 'speakingEnd' }, { type: 'turnDone', outcome: 'aborted' }]);
  });

  it('does not persist or answer a question transcribed after the member has been removed', async () => {
    const member = await joinClub(app, club, 'June');
    const { transcribing, complete } = pauseTranscription('This came back after removal.');
    const { socket, id } = await open(member);
    sendTurn(socket);
    await transcribing;
    const { user } = await member.json<{ user: { id: string } }>(member.get('/api/me'), 200);
    expect((await owner.delete(`/api/clubs/${club.id}/members/${user.id}`)).statusCode).toBe(204);
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    complete();
    expect(await closed).toBe(4003);
    expect(app.ctx.db.all('SELECT role FROM cal_messages WHERE conversation_id = ?', [id])).toHaveLength(0);
    expect(app.ctx.db.all('SELECT kind FROM cal_cost_log')).toEqual([{ kind: 'voice_stt' }]);
  });

  it('refuses a new turn on a connection whose session signed out', async () => {
    const { socket } = await open(owner);
    const answered = nextEvents(socket, (e) => e.type === 'turnDone');
    sendTurn(socket);
    expect((await answered).at(-1)).toEqual({ type: 'turnDone', outcome: 'answered' });
    expect((await owner.post('/api/auth/signout')).statusCode).toBe(204);
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    sendTurn(socket);
    expect(await closed).toBe(4001);
    expect(app.ctx.db.all("SELECT kind FROM cal_cost_log WHERE kind = 'voice_stt'")).toHaveLength(1);
  });

  it('rechecks membership before accepting another turn on an open connection', async () => {
    const member = await joinClub(app, club, 'Bea');
    const { socket } = await open(member);
    const answered = nextEvents(socket, (e) => e.type === 'turnDone');
    sendTurn(socket);
    expect((await answered).at(-1)).toEqual({ type: 'turnDone', outcome: 'answered' });
    const { user } = await member.json<{ user: { id: string } }>(member.get('/api/me'), 200);
    expect((await owner.delete(`/api/clubs/${club.id}/members/${user.id}`)).statusCode).toBe(204);
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    sendTurn(socket);
    expect(await closed).toBe(4003);
    expect(app.ctx.db.all("SELECT kind FROM cal_cost_log WHERE kind = 'voice_stt'")).toHaveLength(1);
  });
});
