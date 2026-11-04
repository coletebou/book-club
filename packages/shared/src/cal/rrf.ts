/**
 * Reciprocal rank fusion: combines several ranked result lists (BM25 full-text, cosine vector
 * search, D161) into one ranking, by rank rather than by score — the two lists' scores are not on
 * comparable scales, but their orderings are.
 */

export interface RankedId {
  readonly id: string;
}

/**
 * `score(id) = Σ 1 / (k + rank)` over every list the id appears in (1-based rank; an id missing
 * from a list contributes nothing from it). `k` (default 60, the value from the original paper
 * and the common default) damps how much a single list's #1 slot can dominate; fewer total
 * results (a small shelf, a short book) are not re-weighted by it since it applies identically to
 * every candidate.
 */
export function fuseRanks(lists: readonly (readonly RankedId[])[], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, i) => {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

/** The ids of `lists`, fused by {@link fuseRanks} and sorted best-first (ties keep input order). */
export function fuseRanked<T extends RankedId>(lists: readonly (readonly T[])[], k = 60, limit?: number): string[] {
  const scores = fuseRanks(lists, k);
  const order = new Map<string, number>();
  let i = 0;
  for (const list of lists) for (const item of list) if (!order.has(item.id)) order.set(item.id, i++);
  const ids = [...scores.keys()].sort((a, b) => {
    const diff = scores.get(b)! - scores.get(a)!;
    return diff !== 0 ? diff : order.get(a)! - order.get(b)!;
  });
  return limit === undefined ? ids : ids.slice(0, limit);
}
