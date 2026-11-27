import { REACTIONS } from '@bookclub/shared';
import { type NativeAudioEngine } from '../audio/NativeAudioEngine';
import { type CarPlayDriver } from './CarPlayDriver';
import { type CarAction, type CarControls } from './model';
import { type ReactionOutbox } from './reactionOutbox';

const CAR_CONTROLS: CarControls = {
  buttons: [
    { id: 'cal', symbol: 'sparkles' },
    { id: 'react', symbol: 'heart' },
    { id: 'speed', system: 'rate' },
    { id: 'sleep', symbol: 'moon.zzz' },
  ],
  upNext: 'Chapters',
};

/** Audio apps can present an action sheet from iOS 17 (D235). */
export function carControls(iosMajor: number): CarControls {
  return iosMajor >= 17 ? CAR_CONTROLS : { ...CAR_CONTROLS, buttons: CAR_CONTROLS.buttons.filter(({ id }) => id !== 'react' && id !== 'sleep') };
}

const CANCEL: CarAction = { id: 'cancel', title: 'Cancel', style: 'cancel' };
const REACTION_CHOICES = REACTIONS.map((title, index) => ({ id: `react:${index}`, title }));
const SLEEP_MINUTES = [15, 30, 45, 60];
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

interface CarActionDeps {
  readonly engine: Pick<NativeAudioEngine, 'livePlace' | 'playbackRate' | 'setRate' | 'setSleepTimer'>;
  readonly reactions: ReactionOutbox;
  readonly newId: () => string;
  readonly now: () => number;
}

export async function carControl(id: string, car: CarPlayDriver, deps: CarActionDeps): Promise<void> {
  const { engine } = deps;
  if (id === 'cancel') return;
  if (id === 'cal') {
    car.message('Ask Cal is coming soon');
    return;
  }
  const here = engine.livePlace();
  if (!here) {
    car.message('Open an audiobook first');
    return;
  }
  if (id === 'react') {
    car.sheet('React to this moment', [...REACTION_CHOICES, CANCEL]);
    return;
  }
  if (id === 'speed') {
    const rate = engine.playbackRate();
    engine.setRate(SPEEDS.find((speed) => speed > rate) ?? 1);
    return;
  }
  if (id === 'sleep') {
    car.sheet('Sleep timer', [...SLEEP_MINUTES.map((minutes) => ({ id: `sleep:${minutes}`, title: `${minutes} minutes` })), { id: 'sleep:off', title: 'Off' }, CANCEL]);
    return;
  }
  if (id === 'sleep:off') {
    engine.setSleepTimer(null);
    car.message('Sleep timer off');
    return;
  }
  const minutes = SLEEP_MINUTES.find((minutes) => id === `sleep:${minutes}`);
  if (minutes) {
    engine.setSleepTimer(deps.now() + minutes * 60_000);
    car.message(`Sleep timer set for ${minutes} minutes`);
    return;
  }
  const index = REACTION_CHOICES.findIndex((action) => action.id === id);
  const reaction = REACTIONS[index];
  if (!reaction) return;
  const { bookId, editionId, userId, locator } = here;
  if (!userId) {
    car.message('Sign-in required');
    return;
  }
  try {
    if (await deps.reactions.keep({ bookId, editionId, userId, locator, reaction, clientId: deps.newId() })) car.message('Reaction saved');
  } catch {
    car.message('Could not save reaction');
  }
}
