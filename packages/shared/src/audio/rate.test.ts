import { describe, expect, it } from 'vitest';
import { BookPlaybackSchema, PlaybackRateSchema, SetBookPlaybackBodySchema, SetListeningSettingsBodySchema } from '../api/schemas';
import { PartyControlBodySchema } from '../live/party';
import { DEFAULT_RATE, RATE_MAX, RATE_MIN, RATE_PRESETS, formatRate, isRateStep, newerRate, normalizeRate, rateLabel, resolveRate, stepRate } from './rate';

describe('listening speed (D195)', () => {
  it('snaps to 0.05 steps within 0.5–3.0, without float noise', () => {
    expect(normalizeRate(1.35)).toBe(1.35);
    expect(normalizeRate(1.1)).toBe(1.1);
    expect(normalizeRate(1.37)).toBe(1.35);
    expect(normalizeRate(1.38)).toBe(1.4);
    expect(normalizeRate(0.1 + 0.2 + 1.05)).toBe(1.35);
    expect(normalizeRate(0.2)).toBe(RATE_MIN);
    expect(normalizeRate(9)).toBe(RATE_MAX);
    expect(normalizeRate(Number.NaN)).toBe(DEFAULT_RATE);
    expect(normalizeRate(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RATE);
    // A lower ceiling (a native player that plays no faster than 2×) caps it there.
    expect(normalizeRate(2.5, 2)).toBe(2);
  });

  it('every step from 0.5 to 3.0 is exact, 51 of them', () => {
    const steps: number[] = [];
    for (let r = RATE_MIN; r <= RATE_MAX; r = stepRate(r, 1)) {
      steps.push(r);
      if (r === RATE_MAX) break;
    }
    expect(steps).toHaveLength(51);
    expect(steps.every(isRateStep)).toBe(true);
    expect(steps.map((r) => Math.round(r * 100))).toEqual(Array.from({ length: 51 }, (_, i) => 50 + i * 5));
  });

  it('steps by 0.05 and stops at the ends', () => {
    expect(stepRate(1, 1)).toBe(1.05);
    expect(stepRate(1, -1)).toBe(0.95);
    expect(stepRate(1.3, 1)).toBe(1.35);
    expect(stepRate(RATE_MAX, 1)).toBe(RATE_MAX);
    expect(stepRate(RATE_MIN, -1)).toBe(RATE_MIN);
    expect(stepRate(2, 1, 2)).toBe(2);
    // From between steps (a party's drift nudge, 1.5 × 1.03): from the nearest step, never a fraction.
    expect(stepRate(1.545, 1)).toBe(1.6);
    expect(stepRate(1.545, -1)).toBe(1.5);
  });

  it('shows speeds cleanly, and says them plainly', () => {
    expect(formatRate(1)).toBe('1.0×');
    expect(formatRate(1.5)).toBe('1.5×');
    expect(formatRate(1.35)).toBe('1.35×');
    expect(formatRate(1.1)).toBe('1.1×');
    expect(formatRate(2)).toBe('2.0×');
    expect(formatRate(0.75)).toBe('0.75×');
    expect(formatRate(1.3500000000000001)).toBe('1.35×');
    expect(rateLabel(1.35)).toBe('1.35 times');
  });

  it('accepts exactly the offered speeds', () => {
    for (const r of [0.5, 0.55, 1, 1.05, 1.1, 1.35, 2.95, 3]) expect(isRateStep(r)).toBe(true);
    for (const r of [0.45, 1.07, 1.333, 3.05, Number.NaN, -1]) expect(isRateStep(r)).toBe(false);
    expect(RATE_PRESETS.every(isRateStep)).toBe(true);
    expect(PlaybackRateSchema.safeParse(1.35).success).toBe(true);
    expect(PlaybackRateSchema.safeParse(1.37).success).toBe(false);
    expect(PlaybackRateSchema.safeParse(3.5).success).toBe(false);
    expect(PlaybackRateSchema.safeParse('1.5').success).toBe(false);
    expect(SetBookPlaybackBodySchema.safeParse({ rate: 1.35, at: 1 }).success).toBe(true);
    expect(SetBookPlaybackBodySchema.safeParse({ rate: 1.35 }).success).toBe(false);
    expect(SetBookPlaybackBodySchema.safeParse({ rate: 1.35, at: 0 }).success).toBe(false);
    expect(SetListeningSettingsBodySchema.safeParse({ defaultRate: 1.25, at: Date.now() }).success).toBe(true);
    expect(BookPlaybackSchema.safeParse({ rate: 1.1, at: 5 }).success).toBe(true);
    // A party's speed is someone's choice too: one of the steps.
    expect(PartyControlBodySchema.safeParse({ action: 'rate', rate: 1.35 }).success).toBe(true);
    expect(PartyControlBodySchema.safeParse({ action: 'rate', rate: 1.545 }).success).toBe(false);
  });

  it("opens a book at its own speed, else your default, else 1.0×", () => {
    expect(resolveRate(1.35, 1.25)).toBe(1.35);
    expect(resolveRate(null, 1.25)).toBe(1.25);
    expect(resolveRate(undefined, undefined)).toBe(1);
    expect(resolveRate(null, null)).toBe(1);
    // A corrupt remembered value is ignored, not played.
    expect(resolveRate(7, 1.25)).toBe(1.25);
    expect(resolveRate(Number.NaN, 0.01)).toBe(1);
  });

  it('the newest choice wins', () => {
    const a = { rate: 1.5, at: 100 };
    const b = { rate: 1.1, at: 200 };
    expect(newerRate(a, b)).toBe(b);
    expect(newerRate(b, a)).toBe(b);
    expect(newerRate(a, null)).toBe(a);
    expect(newerRate(undefined, b)).toBe(b);
    expect(newerRate(null, undefined)).toBeNull();
    expect(newerRate(a, { rate: 2, at: 100 })).toBe(a);
  });
});
