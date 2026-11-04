import { describe, expect, it } from 'vitest';
import { LoadSequencer, isCacheableDownload, nativeRate } from './native-engine';

describe('LoadSequencer (PR #13: native load race plays wrong track)', () => {
  it('is current immediately after begin, with nothing newer started', () => {
    const s = new LoadSequencer();
    const token = s.begin();
    expect(s.isCurrent(token)).toBe(true);
  });

  it('an earlier token is stale once a later load has begun', () => {
    const s = new LoadSequencer();
    const first = s.begin();
    const second = s.begin();
    expect(s.isCurrent(first)).toBe(false);
    expect(s.isCurrent(second)).toBe(true);
  });

  it('models the real race: load(A) then load(B) started before A finishes its async file lookup; only B wins', () => {
    const s = new LoadSequencer();
    const tokenA = s.begin(); // load(A) starts, then awaits FileSystem.getInfoAsync
    const tokenB = s.begin(); // load(B) starts before A's await resolves
    // B's await resolves first and it is still current: it proceeds.
    expect(s.isCurrent(tokenB)).toBe(true);
    // A's await resolves after B already won: A must not assign its (wrong, stale) player.
    expect(s.isCurrent(tokenA)).toBe(false);
  });

  it('three overlapping loads: only the last one started ever wins, regardless of resolve order', () => {
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
  it('accepts a normal 200', () => {
    expect(isCacheableDownload(200)).toBe(true);
  });

  it('accepts other 2xx (e.g. 206 partial content)', () => {
    expect(isCacheableDownload(206)).toBe(true);
  });

  it('rejects a 401 (expired/missing auth) so its error body is never cached as the track', () => {
    expect(isCacheableDownload(401)).toBe(false);
  });

  it('rejects a 404', () => {
    expect(isCacheableDownload(404)).toBe(false);
  });

  it('rejects a 5xx server error', () => {
    expect(isCacheableDownload(500)).toBe(false);
  });

  it('rejects a redirect left unresolved (3xx)', () => {
    expect(isCacheableDownload(302)).toBe(false);
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
