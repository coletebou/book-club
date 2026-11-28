import { AudioLocatorSchema, CarCalReplySchema, type CarCalQuestion, type CarCalReply } from '@bookclub/shared';
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
const MAX_PLACE_RETRY_DRIFT_MS = 1_000;

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

async function conflictCode(response: Response): Promise<unknown> {
  if (response.status !== 409) return null;
  const detail = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
  return detail?.error?.code;
}

export async function requestCarCalAvailability(serverUrl: string, fetcher: typeof fetch, signal: AbortSignal): Promise<boolean | null> {
  const response = await fetcher(`${serverUrl.replace(/\/$/, '')}/api/cal/spoken/status`, { credentials: 'include', signal });
  if (!response.ok) return null;
  const body = await response.json() as { enabled?: unknown } | null;
  return typeof body?.enabled === 'boolean' ? body.enabled : null;
}

export async function requestCarCal(
  serverUrl: string, fetcher: typeof fetch, here: LiveAudioPlace, question: CarCalQuestion, signal: AbortSignal,
): Promise<CarCalReply> {
  const userId = here.userId;
  if (!userId) throw new CarCalError('Sign-in required');
  if (signal.aborted) throw new CarCalError('Cal request cancelled');
  const bookUrl = `${serverUrl.replace(/\/$/, '')}/api/books/${encodeURIComponent(here.bookId)}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  signal.addEventListener('abort', abort, { once: true });
  const request = { signal: controller.signal, credentials: 'include' as const, headers: { 'x-bookclub-user': userId } };
  const send = (locator: LiveAudioPlace['locator']) => fetcher(`${bookUrl}/cal/spoken`, {
    ...request,
    method: 'POST',
    headers: { ...request.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ question, editionId: here.editionId, locator, audioOnly: true }),
  });
  try {
    let response = await send(here.locator);
    let conflict = await conflictCode(response);
    if (conflict === 'place_unavailable' && !controller.signal.aborted) {
      // A concurrent page save can be a little behind the tap. Read it without rewriting
      // anyone's progress, and ask from it only if it is still within the heard place (D245).
      const progress = await fetcher(`${bookUrl}/progress`, request)
        .then(async (found) => found.ok ? await found.json() as { mine?: { editionId?: unknown; locator?: unknown } } | null : null)
        .catch(() => null);
      const saved = AudioLocatorSchema.safeParse(progress?.mine?.locator);
      if (saved.success && progress?.mine?.editionId === here.editionId && saved.data.track === here.locator.track
        && saved.data.ms < here.locator.ms && here.locator.ms - saved.data.ms <= MAX_PLACE_RETRY_DRIFT_MS
        && !controller.signal.aborted) {
        response = await send(saved.data);
        conflict = await conflictCode(response);
      }
    }
    if (response.status === 401) throw new CarCalError('Sign-in required');
    if (response.status === 402) throw new CarCalError('Cal has reached the monthly budget');
    if (response.status === 404) throw new CarCalError('Cal is unavailable');
    if (response.status === 429 || response.status === 503) throw new CarCalError('Cal is busy. Try again shortly');
    if (response.status === 504) throw new CarCalError('Cal took too long to answer');
    if (response.status === 409) {
      if (conflict === 'no_passages') throw new CarCalError('No material to answer from here yet');
      if (conflict === 'session_changed') throw new CarCalError('Sign-in required');
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
