import { describe, expect, it } from 'vitest';
import { AutoPauseEngine } from './autopause';
import { DEFAULT_PARTY_SETTINGS, type PartySettings } from './party';

function engine(overrides: Partial<PartySettings> = {}) {
  let settings: PartySettings = { ...DEFAULT_PARTY_SETTINGS, autoPauseSensitivityMs: 700, autoResumeAfterMs: 4000, rewindOnResumeMs: 2000, ...overrides };
  const e = new AutoPauseEngine(() => settings);
  return { e, set: (patch: Partial<PartySettings>) => (settings = { ...settings, ...patch }) };
}

describe('AutoPauseEngine (D158)', () => {
  it('does nothing for a speaker under the sensitivity threshold', () => {
    const { e } = engine();
    expect(e.speaking('grant', 'Grant', true, 1000)).toBeNull();
    expect(e.speaking('grant', 'Grant', true, 1000 + 699)).toBeNull();
    expect(e.reason).toBeNull();
  });

  it('pauses once one speaker crosses the threshold continuously, naming who', () => {
    const { e } = engine();
    expect(e.speaking('grant', 'Grant', true, 1000)).toBeNull();
    expect(e.speaking('grant', 'Grant', true, 1000 + 700)).toBe('pause');
    expect(e.reason).toEqual({ userId: 'grant', displayName: 'Grant' });
  });

  it('a gap under the threshold resets the clock: starting over must cross it again', () => {
    const { e } = engine();
    expect(e.speaking('grant', 'Grant', true, 1000)).toBeNull();
    expect(e.speaking('grant', 'Grant', false, 1000 + 300)).toBeNull();
    // Speaking again starts a fresh countdown, not a continuation of the first.
    expect(e.speaking('grant', 'Grant', true, 1000 + 350)).toBeNull();
    expect(e.speaking('grant', 'Grant', true, 1000 + 350 + 699)).toBeNull();
    expect(e.speaking('grant', 'Grant', true, 1000 + 350 + 700)).toBe('pause');
  });

  it('crosses the threshold on tick alone, for unbroken speech that sends no second event (LiveKit fires isSpeakingChanged once per transition, not repeatedly)', () => {
    const { e } = engine();
    expect(e.speaking('grant', 'Grant', true, 1000)).toBeNull();
    expect(e.tick(1000 + 699)).toBeNull();
    expect(e.tick(1000 + 700)).toBe('pause');
    expect(e.reason).toEqual({ userId: 'grant', displayName: 'Grant' });
  });

  it('does not pause twice for the same interruption, even if the speaker keeps going', () => {
    const { e } = engine();
    e.speaking('grant', 'Grant', true, 0);
    expect(e.speaking('grant', 'Grant', true, 700)).toBe('pause');
    expect(e.speaking('grant', 'Grant', true, 1400)).toBeNull();
  });

  it('a second speaker crossing the threshold while already paused changes nothing', () => {
    const { e } = engine();
    e.speaking('grant', 'Grant', true, 0);
    e.speaking('grant', 'Grant', true, 700);
    expect(e.speaking('ana', 'Ana', true, 1000)).toBeNull();
    expect(e.speaking('ana', 'Ana', true, 1701)).toBeNull();
    expect(e.reason?.userId).toBe('grant');
  });

  it('resumes only after the configured quiet, not the instant everyone stops', () => {
    const { e } = engine();
    e.speaking('grant', 'Grant', true, 0);
    e.speaking('grant', 'Grant', true, 700);
    e.speaking('grant', 'Grant', false, 800);
    expect(e.tick(800 + 3999)).toBeNull();
    expect(e.tick(800 + 4000)).toBe('resume');
    expect(e.reason).toBeNull();
  });

  it('quiet does not start counting until the last speaker stops', () => {
    const { e } = engine();
    e.speaking('grant', 'Grant', true, 0);
    e.speaking('grant', 'Grant', true, 700);
    e.speaking('ana', 'Ana', true, 750);
    e.speaking('grant', 'Grant', false, 800);
    // Ana is still speaking: no quiet has started yet.
    expect(e.tick(800 + 4000)).toBeNull();
    e.speaking('ana', 'Ana', false, 900);
    expect(e.tick(900 + 3999)).toBeNull();
    expect(e.tick(900 + 4000)).toBe('resume');
  });

  it('never auto-resumes when autoResume is off: only a manual clear() lifts the hold', () => {
    const { e } = engine({ autoResume: false });
    e.speaking('grant', 'Grant', true, 0);
    e.speaking('grant', 'Grant', true, 700);
    e.speaking('grant', 'Grant', false, 800);
    expect(e.tick(1_000_000)).toBeNull();
    expect(e.reason).not.toBeNull();
    e.clear();
    expect(e.reason).toBeNull();
  });

  it('autoPause off clears any in-progress countdown and never pauses', () => {
    const { e, set } = engine();
    e.speaking('grant', 'Grant', true, 0);
    set({ autoPause: false });
    expect(e.speaking('grant', 'Grant', true, 700)).toBeNull();
    expect(e.reason).toBeNull();
  });
});
