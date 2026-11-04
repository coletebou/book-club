/** A small in-memory sliding-window limiter (one process, a handful of users). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record an attempt; returns false when the key is over its limit. */
  attempt(key: string, now = Date.now()): boolean {
    if (this.blocked(key, now)) return false;
    this.record(key, now);
    return true;
  }

  /** Whether the key is at its limit, recording nothing (to count failures only). */
  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, recent);
    return recent.length >= this.limit;
  }

  record(key: string, now = Date.now()): void {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Take back the latest attempt (one that turned out fine). */
  forgive(key: string): void {
    const recent = this.hits.get(key);
    if (recent && recent.length > 0) recent.pop();
  }

  prune(now = Date.now()): void {
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}
