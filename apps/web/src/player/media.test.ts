import { describe, expect, it } from 'vitest';
import { lockScreenActions } from './media';

describe('the lock screen’s controls', () => {
  it('offers play, pause, the skips and seeking everywhere', () => {
    for (const ios of [true, false]) expect(lockScreenActions(ios)).toEqual(expect.arrayContaining(['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto']));
  });

  it('offers the chapters as tracks, except on iOS, where they would take the skips’ place', () => {
    expect(lockScreenActions(false)).toEqual(expect.arrayContaining(['previoustrack', 'nexttrack']));
    expect(lockScreenActions(true)).not.toContain('previoustrack');
    expect(lockScreenActions(true)).not.toContain('nexttrack');
  });
});
