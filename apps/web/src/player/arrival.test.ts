import { describe, expect, it } from 'vitest';
import { type PlayerMoment, followListening, listenedPast } from './arrival';

describe('arriving at a place by listening', () => {
  const stop = 0.25;
  const at = (t: number, ms: number, clock: number, track = 0) => ({ t, ms, at: clock, track });

  it('counts playing on across the place, at any speed', () => {
    expect(listenedPast(at(0.2499, 10_000, 1000), at(0.2501, 10_250, 1250), stop, 1)).toBe(true);
    // At 3× a quarter of a second plays three quarters of one.
    expect(listenedPast(at(0.2499, 10_000, 1000), at(0.2501, 10_750, 1250), stop, 3)).toBe(true);
    // Into the next track: the timeline's place where one ends is where the next begins.
    expect(listenedPast(at(0.2499, 10_000, 1000), at(0.25, 10_000, 1300, 1), stop, 1)).toBe(true);
    // A phone that slept a minute with the screen locked, playing all the while.
    expect(listenedPast(at(0.24, 10_000, 1000), at(0.26, 70_000, 61_000), stop, 1)).toBe(true);
  });

  it('does not count a jump past it: a seek, a track chosen from the list', () => {
    expect(listenedPast(at(0.2, 10_000, 1000), at(0.3, 610_000, 1250), stop, 1)).toBe(false);
    expect(listenedPast(at(0.2, 10_000, 1000), at(0.3, 610_000, 1250), stop, 3)).toBe(false);
  });

  it('counts only the crossing: not before it, not after, not going back', () => {
    expect(listenedPast(at(0.2, 10_000, 1000), at(0.2001, 10_250, 1250), stop, 1)).toBe(false);
    expect(listenedPast(at(0.2501, 10_000, 1000), at(0.2502, 10_250, 1250), stop, 1)).toBe(false);
    expect(listenedPast(at(0.2501, 10_250, 1000), at(0.2499, 10_000, 1250), stop, 1)).toBe(false);
  });
});

describe('following the player', () => {
  const stop = 0.25;
  const moment = (t: number, ms: number, clock: number, more: Partial<PlayerMoment> = {}): PlayerMoment => ({
    t,
    ms,
    at: clock,
    track: 0,
    playing: true,
    atTrackEnd: false,
    atTrackStart: false,
    ...more,
  });

  /** Feed the moments through, as the player's updates do; the moments that arrive. */
  function run(moments: PlayerMoment[]): number[] {
    let from = null as ReturnType<typeof followListening>['from'];
    const arrived: number[] = [];
    moments.forEach((m, i) => {
      const step = followListening(from, m, stop, 1);
      if (step.arrived) arrived.push(i);
      from = step.from;
    });
    return arrived;
  }

  it('arrives at a track’s end that is the stop, as the track stops by itself', () => {
    expect(run([moment(0.248, 2700, 0), moment(0.2495, 2950, 250), moment(0.25, 3000, 300, { playing: false, atTrackEnd: true })])).toEqual([2]);
  });

  it('arrives in the next track when the track’s end falls just short (the file a little shorter than measured)', () => {
    const moments = [
      moment(0.2495, 2950, 0),
      moment(0.2497, 2970, 50, { playing: false, atTrackEnd: true }),
      // The next track loads: paused for a moment at its start.
      moment(0.25, 3000, 80, { playing: false, atTrackStart: true, track: 1 }),
      moment(0.2502, 3250, 330, { track: 1 }),
    ];
    expect(run(moments)).toEqual([3]);
  });

  it('does not arrive after a pause and a move while paused, however long the pause', () => {
    const moments = [
      moment(0.2, 1000, 0),
      moment(0.2, 1000, 100, { playing: false }),
      moment(0.3, 600_000, 3_600_000, { playing: false }),
      moment(0.3001, 600_250, 3_600_250),
    ];
    expect(run(moments)).toEqual([]);
  });

  it('does not count the stop for a place that is not one', () => {
    expect(followListening(moment(0.2, 1000, 0), moment(0.3, 1250, 250), null, 1).arrived).toBe(false);
  });
});

describe('a step of listening, for anything it passes', () => {
  const moment = (t: number, ms: number, clock: number, more: Partial<PlayerMoment> = {}): PlayerMoment => ({
    t,
    ms,
    at: clock,
    track: 0,
    playing: true,
    atTrackEnd: false,
    atTrackStart: false,
    ...more,
  });

  it('says a step was heard whatever the place asked about, and not a jump or the first moment', () => {
    const first = followListening(null, moment(0.1, 1000, 0), null, 1);
    expect(first.heard).toBe(false);
    const on = followListening(first.from, moment(0.1001, 1250, 250), null, 1);
    expect(on).toMatchObject({ heard: true, arrived: false });
    const jump = followListening(on.from, moment(0.5, 900_000, 500), 0.25, 1);
    expect(jump).toMatchObject({ heard: false, arrived: false });
    // Paused at a track's end: heard to there.
    expect(followListening(on.from, moment(0.1002, 1400, 400, { playing: false, atTrackEnd: true }), null, 1).heard).toBe(true);
  });
});

