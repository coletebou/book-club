import { describe, expect, it } from 'vitest';
import { LoadSequencer, isCacheableDownload, nativeRate } from './native-engine';

describe('LoadSequencer (PR #13: native load race plays wrong track)', () => {
  it('is current immediately after begin, with nothing newer started', () => {
    const s = new LoadSequencer();
    const token = s.begin();
    expect(s.isCurrent(token)).toBe(true);
  });

  it('three overlapping loads: only the last one started ever wins, regardless of resolve order', () => {
    // The real race: load(A), then load(B) and load(C) start before A's async file lookup
    // (FileSystem.getInfoAsync) resolves. Whichever await resolves first, only C may assign its player.
    const s = new LoadSequencer();
    const a = s.begin();
    const b = s.begin();
    const c = s.begin();
    expect(s.isCurrent(a)).toBe(false);
    expect(s.isCurrent(b)).toBe(false);
    expect(s.isCurrent(c)).toBe(true);
  });
});

describe('isCacheableDownload (PR #13: failed downloads poison offline audio)', () => {
  // Only a 2xx is kept: a 401 (expired or missing auth), 404, 5xx or unresolved redirect would
  // otherwise be cached as the track, its error body replacing the real audio for good.
  it.each([[200, true], [206, true], [302, false], [401, false], [404, false], [500, false]])('status %i is cacheable: %s', (status, cacheable) => {
    expect(isCacheableDownload(status)).toBe(cacheable);
  });
});

describe('nativeRate (D195: what the iOS player is given)', () => {
  it('passes every offered speed through exactly, and a drift nudge too', () => {
    for (const r of [0.5, 0.55, 1, 1.05, 1.35, 2.95, 3, 1.545]) expect(nativeRate(r)).toBe(r);
  });
  it('keeps to the range, and ignores what is not a rate', () => {
    expect(nativeRate(4)).toBe(3);
    expect(nativeRate(0.2)).toBe(0.5);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1.5', null, undefined]) expect(nativeRate(bad)).toBeNull();
  });
});
