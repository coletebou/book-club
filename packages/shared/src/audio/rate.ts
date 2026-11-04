/**
 * Listening speed (D195): any rate from half speed to triple speed, in steps of 0.05, so a
 * listener can settle on 1.35× rather than choose between 1.25× and 1.5×. The same rules on the
 * server (what it accepts), on the web (the stepper and presets) and in the iOS app (what native
 * plays), so a speed chosen on one is the speed heard on another.
 */

export const RATE_MIN = 0.5;
export const RATE_MAX = 3;
export const RATE_STEP = 0.05;
/** The speed everyone starts at, until they choose their own default. */
export const DEFAULT_RATE = 1;
/** One tap to the speeds most people use; the stepper reaches every other one. */
export const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

/** Steps per unit: rates are kept as whole twentieths, so 1.35 is exactly 27 steps. */
const PER_UNIT = 1 / RATE_STEP;

/** Hundredths, never float noise: 0.1 + 0.2 style sums would otherwise show as 1.3500000000000001×. */
const clean = (x: number): number => Math.round(x * 100) / 100;

/**
 * The nearest speed this app plays: snapped to a 0.05 step and kept within [min, max]. Anything
 * not a finite number (a corrupt saved value, a missing one) becomes the default speed.
 */
export function normalizeRate(rate: number, max: number = RATE_MAX): number {
  if (!Number.isFinite(rate)) return DEFAULT_RATE;
  const top = Math.max(RATE_MIN, Math.min(RATE_MAX, max));
  const snapped = Math.round(rate * PER_UNIT) / PER_UNIT;
  return clean(Math.min(top, Math.max(RATE_MIN, snapped)));
}

/** Whether `rate` is exactly one of the speeds offered (what the server accepts). */
export function isRateStep(rate: number): boolean {
  if (!Number.isFinite(rate) || rate < RATE_MIN - 1e-9 || rate > RATE_MAX + 1e-9) return false;
  return Math.abs(rate * PER_UNIT - Math.round(rate * PER_UNIT)) < 1e-6;
}

/**
 * One step slower (-1) or faster (+1), from the nearest step: a rate between steps (a party's
 * drift nudge) steps from where it would snap, never by a fraction of a step.
 */
export function stepRate(rate: number, direction: 1 | -1, max: number = RATE_MAX): number {
  return normalizeRate(normalizeRate(rate, max) + direction * RATE_STEP, max);
}

/** "1.0×", "1.35×", "2.0×": at least one decimal so the label keeps its width as it steps. */
export function formatRate(rate: number): string {
  const fixed = normalizeRate(rate).toFixed(2);
  return `${fixed.endsWith('0') ? fixed.slice(0, -1) : fixed}×`;
}

/** What a screen reader says for a speed: "1.35 times". */
export function rateLabel(rate: number): string {
  return `${formatRate(rate).slice(0, -1)} times`;
}

/**
 * The speed a book opens at (D195): the last speed you used for this book, else your default,
 * else 1.0×. A value that is not a speed this app plays counts as missing.
 */
export function resolveRate(bookRate: number | null | undefined, defaultRate: number | null | undefined): number {
  if (typeof bookRate === 'number' && isRateStep(bookRate)) return normalizeRate(bookRate);
  if (typeof defaultRate === 'number' && isRateStep(defaultRate)) return normalizeRate(defaultRate);
  return DEFAULT_RATE;
}

/** A remembered speed and when it was chosen (client clock, ms): the newest choice wins. */
export interface ChosenRate {
  readonly rate: number;
  readonly at: number;
}

/** The newer of two remembered choices (either may be missing); on a tie, the first. */
export function newerRate<T extends ChosenRate>(a: T | null | undefined, b: T | null | undefined): T | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.at > a.at ? b : a;
}
