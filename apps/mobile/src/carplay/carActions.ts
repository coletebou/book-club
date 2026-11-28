import { CarCalQuestionSchema, REACTIONS } from '@bookclub/shared';
import { type NativeAudioEngine } from '../audio/NativeAudioEngine';
import { type CarCal } from './CarCal';
import { type CarPlayDriver } from './CarPlayDriver';
import { type CarAction, type CarControls } from './model';
import { type ReactionOutbox } from './reactionOutbox';

export const CAR_CONTROLS: CarControls = {
  buttons: [
    { id: 'cal', symbol: 'sparkles' },
    { id: 'react', symbol: 'heart' },
    { id: 'speed', system: 'rate' },
    { id: 'sleep', symbol: 'moon.zzz' },
  ],
  upNext: 'Chapters',
};

const CANCEL: CarAction = { id: 'cancel', title: 'Cancel', style: 'cancel' };
const REACTION_CHOICES = REACTIONS.map((title, index) => ({ id: `react:${index}`, title }));
const QUICK_REACTION = `react:${REACTIONS.indexOf('❤️')}`;
const SLEEP_MINUTES = [15, 30, 45, 60];
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

interface CarActionDeps {
  readonly engine: Pick<NativeAudioEngine, 'livePlace' | 'playbackRate' | 'setRate' | 'setSleepTimer' | 'sleepDeadline'>;
  readonly reactions: ReactionOutbox;
  readonly cal: Pick<CarCal, 'open' | 'ask' | 'active'>;
  readonly sheets: boolean;
  readonly newId: () => string;
  readonly now: () => number;
}

export async function carControl(id: string, car: CarPlayDriver, deps: CarActionDeps): Promise<void> {
  const { engine } = deps;
  if (id === 'cancel') return;
  if (id === 'cal') return deps.cal.open(car, deps.sheets);
  if (deps.cal.active()) return;
  if (id.startsWith('cal:')) {
    const question = CarCalQuestionSchema.safeParse(id.slice(4));
    if (question.success) return deps.cal.ask(car, question.data);
    return;
  }
  const here = engine.livePlace();
  if (!here) {
    car.message('Nothing is playing');
    return;
  }
  if (id === 'react') {
    if (!deps.sheets) return carControl(QUICK_REACTION, car, deps);
    return car.sheet('React to this moment', [...REACTION_CHOICES, CANCEL], QUICK_REACTION);
  }
  if (id === 'speed') {
    const rate = engine.playbackRate();
    engine.setRate(SPEEDS.find((speed) => speed > rate) ?? 1);
    return;
  }
  if (id === 'sleep') {
    if (!deps.sheets) return carControl('sleep:toggle', car, deps);
    return car.sheet('Sleep timer', [...SLEEP_MINUTES.map((minutes) => ({ id: `sleep:${minutes}`, title: `${minutes} minutes` })), { id: 'sleep:off', title: 'Off' }, CANCEL], 'sleep:toggle');
  }
  if (id === 'sleep:toggle') {
    return carControl((engine.sleepDeadline() ?? 0) > deps.now() ? 'sleep:off' : 'sleep:30', car, deps);
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
