import { type CarCalReply } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type NativeAudioEngine } from '../audio/NativeAudioEngine';
import { CarCal, requestCarCal } from './CarCal';
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
      body: '{"question":"scene","editionId":"edition01","locator":{"kind":"audio","track":1,"ms":42500}}',
    });
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
});
