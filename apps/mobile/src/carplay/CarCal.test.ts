import { type CarCalReply } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type NativeAudioEngine } from '../audio/NativeAudioEngine';
import { CarCal, requestCarCal, requestCarCalAvailability } from './CarCal';
import { CarPlayDriver } from './CarPlayDriver';
import { KeptQueues } from './keptQueues';

const here = { bookId: 'book01', editionId: 'edition01', userId: 'reader-a', trackUrl: 'https://books.test/media/editions/edition01/tracks/1', locator: { kind: 'audio', track: 1, ms: 42_500 }, playing: true } as const;
const reply: CarCalReply = { answer: 'A private answer about the book.', mimeType: 'audio/mpeg', audioBase64: 'AQID' };

function setup() {
  const effects: string[] = [];
  const engine = {
    playFromCar: vi.fn().mockResolvedValue(true), carDisconnected: vi.fn(), keptPlace: vi.fn(async () => null),
    livePlace: vi.fn(() => here),
    flushPlace: vi.fn<NativeAudioEngine['flushPlace']>().mockResolvedValue(true),
    withCarSpeech: vi.fn<NativeAudioEngine['withCarSpeech']>(async (_here, _turn, work) => {
      effects.push('pause');
      try { await work(async (uri) => { effects.push(uri); }); }
      finally { effects.push('resume'); }
    }),
  };
  const request = vi.fn<ConstructorParameters<typeof CarCal>[0]['request']>().mockResolvedValue(reply);
  const playAudio = vi.fn<ConstructorParameters<typeof CarCal>[0]['playAudio']>((audio, play) => play(audio.audioBase64 === 'AQID' ? 'answer' : 'waiting cue'));
  const cal = new CarCal({ engine, request, playAudio });
  const driven = new CarPlayDriver({
    native: { setCarPlayModel: vi.fn(), widgetSnapshot: () => null }, engine,
    queues: new KeptQueues({ read: async () => null, write: async () => {}, remove: async () => {} }),
    serverPlace: async () => null,
    onControl: (id, car) => id === 'cal' ? cal.open(car, true) : cal.ask(car, 'recap'),
    onVoice: (event, car) => cal.voice(event, car),
  });
  return { effects, engine, cal, driven, request, playAudio };
}

afterEach(() => vi.useRealTimers());

describe('tap a car question and hear the answer', () => {
  it('offers prepared questions, awaits the current place and keeps the answer off the display', async () => {
    const { driven, engine, request, effects } = setup();
    let flush!: (saved: boolean) => void;
    engine.flushPlace.mockReturnValue(new Promise((resolve) => { flush = resolve; }));
    await driven.command('control:cal');
    const nav = driven.model().nav;
    expect(nav?.to === 'sheet' && nav.actions.map((action) => action.title)).toEqual([
      'Recap the last ten minutes', 'Who is in this scene?', 'What did the club say here?', 'Cancel',
    ]);
    const answer = driven.command('control:cal:recap');
    await driven.command('voice:shown');
    expect(effects).toEqual(['pause']);
    expect(engine.flushPlace).toHaveBeenCalledWith(here, expect.any(AbortSignal));
    expect(request).not.toHaveBeenCalled();
    flush(true);
    await answer;
    expect(request).toHaveBeenCalledWith(here, 'recap', expect.any(AbortSignal));
    expect(effects).toEqual(['pause', 'answer', 'resume']);
    expect(driven.model().nav).toMatchObject({ to: 'dismiss' });
    expect(JSON.stringify(driven.model())).not.toContain(reply.answer);
    expect(JSON.stringify(driven.model())).not.toMatch(/phone/i);
  });

  it('returns to the book without asking when progress cannot be confirmed', async () => {
    const { driven, engine, request, effects } = setup();
    engine.flushPlace.mockResolvedValue(false);
    await driven.command('control:cal:recap');
    expect(request).not.toHaveBeenCalled();
    expect(effects).toEqual(['pause', 'resume']);
    expect(driven.model().nav).toMatchObject({ to: 'message', message: 'Listening place has not synced' });
  });

  it('reads current progress after a conflict and retries a nearby earlier place without rewriting it', async () => {
    const { driven, engine, request, effects } = setup();
    const saved = { ...here.locator, ms: 42_200 };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: 'place_unavailable' } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ mine: { editionId: here.editionId, locator: saved } }))
      .mockResolvedValueOnce(Response.json(reply));
    request.mockImplementation((place, question, signal) => requestCarCal('https://books.test', fetch, place, question, signal));

    await driven.command('control:cal:recap');
    expect(engine.flushPlace).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['https://books.test/api/books/book01/cal/spoken', 'POST'],
      ['https://books.test/api/books/book01/progress', 'GET'],
      ['https://books.test/api/books/book01/cal/spoken', 'POST'],
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ credentials: 'include', headers: { 'x-bookclub-user': 'reader-a' } });
    expect(JSON.parse(fetch.mock.calls[2]?.[1]?.body as string)).toMatchObject({ locator: saved, editionId: here.editionId });
    expect(effects).toEqual(['pause', 'answer', 'resume']);
  });

  it.each([42_501, 40_000])('keeps a different saved place of %i ms untouched and refuses to ask from it', async (ms) => {
    const { driven, engine, request, effects } = setup();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: 'place_unavailable' } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ mine: { editionId: here.editionId, locator: { ...here.locator, ms } } }));
    request.mockImplementation((place, question, signal) => requestCarCal('https://books.test', fetch, place, question, signal));

    await driven.command('control:cal:recap');
    expect(engine.flushPlace).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['POST', 'GET']);
    expect(effects).toEqual(['pause', 'resume']);
    expect(driven.model().nav).toMatchObject({ to: 'message', message: 'Listening place has not synced' });
  });

  it.each([
    { code: 'place_unavailable', attempts: 3, message: 'Listening place has not synced' },
    { code: 'no_passages', attempts: 1, message: 'No material to answer from here yet' },
    { code: 'session_changed', attempts: 1, message: 'Sign-in required' },
  ])('limits retry when the server reports $code', async ({ code, attempts, message }) => {
    const { driven, engine, request, effects } = setup();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => init?.method === 'POST'
      ? Response.json({ error: { code } }, { status: 409 })
      : Response.json({ mine: { editionId: here.editionId, locator: here.locator } }));
    request.mockImplementation((place, question, signal) => requestCarCal('https://books.test', fetch, place, question, signal));

    await driven.command('control:cal:recap');
    expect(fetch).toHaveBeenCalledTimes(attempts);
    expect(engine.flushPlace).toHaveBeenCalledOnce();
    expect(effects).toEqual(['pause', 'resume']);
    expect(driven.model().nav).toMatchObject({ to: 'message', message });
  });

  it('plays one waiting cue after two seconds and answers when there is no voice template', async () => {
    vi.useFakeTimers();
    const { driven, request, playAudio, effects } = setup();
    let finish!: (reply: CarCalReply) => void;
    request.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const answer = driven.command('control:cal:recap');
    await driven.command('voice:unavailable');
    await vi.advanceTimersByTimeAsync(1999);
    expect(playAudio).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(effects).toEqual(['pause', 'waiting cue']);
    finish(reply);
    await answer;
    expect(effects).toEqual(['pause', 'waiting cue', 'answer', 'resume']);
    expect(playAudio).toHaveBeenCalledTimes(2);
  });

  it.each(['cancel', 'closed'] as const)('cancels an in-flight answer on voice:%s and resumes', async (event) => {
    const { driven, request, playAudio, effects } = setup();
    request.mockImplementation((_here, _question, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const answer = driven.command('control:cal:recap');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await driven.command(`voice:${event}`);
    await answer;
    expect(playAudio).not.toHaveBeenCalled();
    expect(effects).toEqual(['pause', 'resume']);
  });

  it('sends the exact location and original account with a single authenticated request', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(reply));
    const signal = new AbortController().signal;
    await expect(requestCarCal('https://books.test/', fetch, here, 'scene', signal)).resolves.toEqual(reply);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://books.test/api/books/book01/cal/spoken', {
      method: 'POST', signal: expect.any(AbortSignal), credentials: 'include', headers: { 'content-type': 'application/json', 'x-bookclub-user': 'reader-a' },
      body: '{"question":"scene","editionId":"edition01","locator":{"kind":"audio","track":1,"ms":42500},"audioOnly":true}',
    });
  });

  it('distinguishes a server with Cal off from one with no status route', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ enabled: false }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const signal = new AbortController().signal;
    await expect(requestCarCalAvailability('https://books.test/', fetch, signal)).resolves.toBe(false);
    await expect(requestCarCalAvailability('https://books.test/', fetch, signal)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledWith('https://books.test/api/cal/spoken/status', { credentials: 'include', signal });
  });

  it('resumes narration and gives a short message if the answer request never reaches the server', async () => {
    vi.useFakeTimers();
    const { driven, request, effects } = setup();
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    request.mockImplementation((place, question, signal) => requestCarCal('https://books.test', fetch, place, question, signal));
    const answer = driven.command('control:cal:recap');
    let returned = false;
    void answer.then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(34_999);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(returned).toBe(true);
    expect(effects).toEqual(['pause', 'waiting cue', 'resume']);
    expect(driven.model().nav).toMatchObject({ to: 'message', message: 'Cal took too long to answer' });
  });

  it('keeps the same 35-second deadline when the stale place is confirmed and retried', async () => {
    vi.useFakeTimers();
    const { driven, request, effects } = setup();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve(Response.json({ error: { code: 'place_unavailable' } }, { status: 409 })), 34_000);
      }))
      .mockResolvedValueOnce(Response.json({ mine: { editionId: here.editionId, locator: here.locator } }))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
    request.mockImplementation((place, question, signal) => requestCarCal('https://books.test', fetch, place, question, signal));
    const answer = driven.command('control:cal:recap');
    await vi.advanceTimersByTimeAsync(34_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(effects).toEqual(['pause', 'waiting cue']);
    await vi.advanceTimersByTimeAsync(1);
    await answer;
    expect(effects).toEqual(['pause', 'waiting cue', 'resume']);
    expect(driven.model().nav).toMatchObject({ to: 'message', message: 'Cal took too long to answer' });
  });
});
