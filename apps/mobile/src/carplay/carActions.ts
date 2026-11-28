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
    { id: 'bookmark', symbol: 'bookmark' },
  ],
  upNext: 'Chapters',
};

export function carControlsForCal(available: boolean): CarControls {
  return available ? CAR_CONTROLS : { ...CAR_CONTROLS, buttons: CAR_CONTROLS.buttons.filter(({ id }) => id !== 'cal') };
}

const CANCEL: CarAction = { id: 'cancel', title: 'Cancel', style: 'cancel' };
const REACTION_NAMES: Record<(typeof REACTIONS)[number], string> = {
  '😱': 'Shocked', '😢': 'Sad', '😡': 'Angry', '😂': 'Funny', '❤️': 'Love', '🤯': 'Mind blown',
};
const REACTION_CHOICES = REACTIONS.map((emoji, index) => ({ id: `react:${index}`, title: `${emoji} ${REACTION_NAMES[emoji]}` }));
const QUICK_REACTION = 'react:quick';
const SLEEP_MINUTES = [15, 30, 45, 60];
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

interface CarActionDeps {
  readonly engine: Pick<NativeAudioEngine, 'livePlace' | 'playbackRate' | 'setRate' | 'setSleepTimer' | 'sleepTimer'>;
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
  if (id === 'bookmark') return car.saveBookmark(here);
  if (id === 'react') {
    if (!deps.sheets) return carControl(QUICK_REACTION, car, deps);
    return car.sheet('React to this moment', [...REACTION_CHOICES, CANCEL], QUICK_REACTION);
  }
  if (id === 'speed') {
    const rate = engine.playbackRate();
    engine.setRate(SPEEDS.find((speed) => speed > rate) ?? 1, 'car');
    return;
  }
  if (id === 'sleep') {
    if (!deps.sheets) return carControl('sleep:toggle', car, deps);
    return car.sheet('Sleep timer', [...SLEEP_MINUTES.map((minutes) => ({ id: `sleep:${minutes}`, title: `${minutes} minutes` })), { id: 'sleep:off', title: 'Off' }, CANCEL], 'sleep:toggle');
  }
  if (id === 'sleep:toggle') {
    const timer = engine.sleepTimer();
    return carControl(timer.trackEnd || (timer.at ?? 0) > deps.now() ? 'sleep:off' : 'sleep:30', car, deps);
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
  const quick = id === QUICK_REACTION;
  const reaction = quick ? '❤️' : REACTIONS[REACTION_CHOICES.findIndex((action) => action.id === id)];
  if (!reaction) return;
  const { bookId, editionId, userId, locator } = here;
  if (!userId) {
    car.message('Sign-in required');
    return;
  }
  const nav = car.model().nav;
  const confirm = (message: string) => {
    if (!deps.cal.active() && car.model().nav === nav) car.message(message);
  };
  try {
    // The sheet dismisses for feedback. The quick action has no sheet (D257).
    const saved = await deps.reactions.keep({ bookId, editionId, userId, locator, reaction, clientId: deps.newId() });
    if (saved && quick) confirm('Reaction saved');
  } catch {
    confirm('Could not save reaction');
  }
}
