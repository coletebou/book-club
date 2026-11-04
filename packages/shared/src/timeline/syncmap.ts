/**
 * Sync maps: monotone piecewise-linear maps from an edition's own linear measure `m`
 * (EPUB characters, PDF pages, audio milliseconds) onto the book timeline `t ∈ [0, 1]`.
 *
 * Invariants of a valid map:
 * - at least two tie points;
 * - `m` strictly increasing;
 * - `t` non-decreasing and inside [0, 1].
 */

export interface TiePoint {
  m: number;
  t: number;
}

export interface SyncMap {
  points: TiePoint[];
}

export class SyncMapError extends Error {
  override name = 'SyncMapError';
}

export function assertValidSyncMap(map: SyncMap): void {
  const { points } = map;
  if (points.length < 2) throw new SyncMapError('a sync map needs at least two tie points');
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!Number.isFinite(p.m) || !Number.isFinite(p.t)) throw new SyncMapError(`tie point ${i} is not finite`);
    if (p.t < 0 || p.t > 1) throw new SyncMapError(`tie point ${i} has t outside [0, 1]`);
    if (i > 0) {
      const prev = points[i - 1]!;
      if (!(p.m > prev.m)) throw new SyncMapError(`tie point ${i} does not increase m`);
      if (p.t < prev.t) throw new SyncMapError(`tie point ${i} decreases t`);
    }
  }
}

export function isValidSyncMap(map: SyncMap): boolean {
  try {
    assertValidSyncMap(map);
    return true;
  } catch {
    return false;
  }
}

/** A linear map: `m ∈ [m0, m1]` onto `t ∈ [0, 1]`. */
export function linearSyncMap(m0: number, m1: number): SyncMap {
  if (!(m1 > m0)) throw new SyncMapError('linear map needs m1 > m0');
  return { points: [{ m: m0, t: 0 }, { m: m1, t: 1 }] };
}

/** Index i of the segment [points[i], points[i+1]] that contains m (m inside the map's domain). */
function segmentForM(points: readonly TiePoint[], m: number): number {
  let lo = 0;
  let hi = points.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid]!.m <= m) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Map an edition measure onto the timeline. Values outside the map are clamped. */
export function mToT(map: SyncMap, m: number): number {
  const { points } = map;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (m <= first.m) return first.t;
  if (m >= last.m) return last.t;
  const i = segmentForM(points, m);
  const a = points[i]!;
  const b = points[i + 1]!;
  return a.t + ((b.t - a.t) * (m - a.m)) / (b.m - a.m);
}

/**
 * Map a timeline position onto an edition measure. Inverse of {@link mToT} on the parts of the
 * map where `t` increases; on a flat stretch (several `m` with the same `t`) the start of the
 * stretch is returned. Positions before or after the map clamp to its ends.
 */
export function tToM(map: SyncMap, t: number): number {
  const { points } = map;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (t <= first.t) return first.m;
  if (t >= last.t) return last.m;
  // First tie point whose t is >= the target.
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t >= t) hi = mid;
    else lo = mid + 1;
  }
  const b = points[lo]!;
  if (b.t === t) {
    // Walk back to the first point of a flat stretch at this t.
    let j = lo;
    while (j > 0 && points[j - 1]!.t === t) j--;
    return points[j]!.m;
  }
  const a = points[lo - 1]!;
  return a.m + ((b.m - a.m) * (t - a.t)) / (b.t - a.t);
}

/** Build a map from tie points, dropping any that would break monotonicity. */
export function syncMapFromTiePoints(candidates: readonly TiePoint[]): SyncMap {
  const sorted = [...candidates]
    .filter((p) => Number.isFinite(p.m) && Number.isFinite(p.t))
    .map((p) => ({ m: p.m, t: Math.min(1, Math.max(0, p.t)) }))
    .sort((a, b) => a.m - b.m || a.t - b.t);
  const points: TiePoint[] = [];
  for (const p of sorted) {
    const prev = points[points.length - 1];
    if (prev && p.m <= prev.m) continue;
    if (prev && p.t < prev.t) continue;
    points.push(p);
  }
  const map = { points };
  assertValidSyncMap(map);
  return map;
}
