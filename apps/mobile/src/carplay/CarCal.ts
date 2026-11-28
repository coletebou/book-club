import { CarCalReplySchema, type CarCalQuestion, type CarCalReply } from '@bookclub/shared';
import { type LiveAudioPlace, type NativeAudioEngine } from '../audio/NativeAudioEngine';
import { type CarPlayDriver } from './CarPlayDriver';
import { type CarVoice } from './model';
import { ONE_MOMENT_MP3 } from './oneMoment';

type SpokenAudio = Pick<CarCalReply, 'mimeType' | 'audioBase64'>;
type VoiceEvent = 'shown' | 'unavailable' | 'cancel' | 'closed';

const STATES = [
  { id: 'thinking', title: 'Preparing answer', symbol: 'sparkles' },
  { id: 'answering', title: 'Cal is speaking', symbol: 'waveform' },
] as const;
const QUESTIONS = [
  { id: 'cal:recap', title: 'Recap the last ten minutes' },
  { id: 'cal:scene', title: 'Who is in this scene?' },
  { id: 'cal:club', title: 'What did the club say here?' },
  { id: 'cancel', title: 'Cancel', style: 'cancel' },
] as const;

const WAIT_CUE_MS = 2_000;
const REQUEST_TIMEOUT_MS = 35_000;

interface Turn {
  readonly controller: AbortController;
  screen: 'opening' | 'shown' | 'unavailable';
  phase: typeof STATES[number]['id'];
}

interface CarCalDeps {
  readonly engine: Pick<NativeAudioEngine, 'livePlace' | 'flushPlace' | 'withCarSpeech'>;
  readonly request: (here: LiveAudioPlace, question: CarCalQuestion, signal: AbortSignal) => Promise<CarCalReply>;
  readonly playAudio: (audio: SpokenAudio, play: (uri: string) => Promise<void>, signal: AbortSignal) => Promise<void>;
}

class CarCalError extends Error {}

/** Prepared spoken answers while audiobook playback is paused (D245). */
export class CarCal {
  private turn: Turn | null = null;

  constructor(private readonly deps: CarCalDeps) {}

  active(): boolean {
    return this.turn !== null;
  }

  open(car: CarPlayDriver, sheets: boolean): void | Promise<void> {
    if (this.turn) { this.cancel(); return; }
    if (!sheets) return this.ask(car, 'recap');
    car.sheet('Ask Cal', QUESTIONS, 'cal:recap');
  }

  cancel(): void {
    this.turn?.controller.abort();
  }

  voice(event: VoiceEvent, car: CarPlayDriver): void {
    const turn = this.turn;
    if (!turn) return;
    if (event === 'cancel' || event === 'closed') this.cancel();
    else if (event === 'unavailable') turn.screen = 'unavailable';
    else {
      turn.screen = 'shown';
      if (turn.phase === 'answering') car.voice(voice(turn));
    }
  }

  async ask(car: CarPlayDriver, question: CarCalQuestion): Promise<void> {
    if (this.turn) return;
    const { engine, request, playAudio } = this.deps;
    const here = engine.livePlace();
    if (!here) { car.message('Nothing is playing'); return; }
    if (!here.userId) { car.message('Sign-in required'); return; }
    const turn: Turn = { controller: new AbortController(), screen: 'opening', phase: 'thinking' };
    const signal = turn.controller.signal;
    this.turn = turn;
    car.voice(voice(turn));
    let errorMessage: string | null = null;
    try {
      await engine.withCarSpeech(here, turn.controller, async (play) => {
        let cue: Promise<void> | null = null;
        const timer = setTimeout(() => {
          if (!signal.aborted) cue = playAudio({ mimeType: 'audio/mpeg', audioBase64: ONE_MOMENT_MP3 }, play, signal).catch(() => undefined);
        }, WAIT_CUE_MS);
        let reply: CarCalReply;
        try {
          if (!(await engine.flushPlace(here, signal))) throw new CarCalError('Listening place has not synced');
          if (signal.aborted) return;
          reply = await request(here, question, signal);
        } finally {
          clearTimeout(timer);
          await cue;
        }
        if (signal.aborted) return;
        turn.phase = 'answering';
        if (turn.screen === 'shown') car.voice(voice(turn));
        await playAudio(reply, play, signal);
      });
    } catch (error) {
      if (!signal.aborted) errorMessage = error instanceof CarCalError ? error.message : 'Cal could not answer';
    } finally {
      this.turn = null;
      if (errorMessage) car.message(errorMessage);
      else if (turn.screen !== 'unavailable') car.dismiss();
    }
  }
}

function voice(turn: Turn): CarVoice {
  return { states: STATES, state: turn.phase, cancel: 'Cancel' };
}

export async function requestCarCal(
  serverUrl: string, fetcher: typeof fetch, here: LiveAudioPlace, question: CarCalQuestion, signal: AbortSignal,
): Promise<CarCalReply> {
  if (!here.userId) throw new CarCalError('Sign-in required');
  if (signal.aborted) throw new CarCalError('Cal request cancelled');
  const url = `${serverUrl.replace(/\/$/, '')}/api/books/${encodeURIComponent(here.bookId)}/cal/spoken`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetcher(url, {
      method: 'POST', signal: controller.signal, credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-bookclub-user': here.userId },
      body: JSON.stringify({ question, editionId: here.editionId, locator: here.locator }),
    });
    if (response.status === 401) throw new CarCalError('Sign-in required');
    if (response.status === 402) throw new CarCalError('Cal has reached the monthly budget');
    if (response.status === 404) throw new CarCalError('Cal is unavailable');
    if (response.status === 429 || response.status === 503) throw new CarCalError('Cal is busy. Try again shortly');
    if (response.status === 504) throw new CarCalError('Cal took too long to answer');
    if (response.status === 409) {
      const detail = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
      if (detail?.error?.code === 'no_passages') throw new CarCalError('No material to answer from here yet');
      if (detail?.error?.code === 'session_changed') throw new CarCalError('Sign-in required');
      throw new CarCalError('Listening place has not synced');
    }
    if (!response.ok) throw new CarCalError('Cal could not answer');
    return CarCalReplySchema.parse(await response.json());
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw new CarCalError('Cal took too long to answer');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
