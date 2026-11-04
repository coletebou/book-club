import { type FastifyBaseLogger } from 'fastify';

/**
 * A tiny in-process job runner for ingest work (EPUB normalisation, audio durations). One job at
 * a time keeps CPU and memory predictable on a small box; jobs survive nothing but are re-queued
 * on boot for editions still marked `processing`.
 */
export class Jobs {
  private queue: { name: string; run: () => Promise<void> }[] = [];
  private running = false;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly log: FastifyBaseLogger) {}

  /**
   * Queue a job. A job's name says what it does to what (`align:<book>`), so a job of the same name
   * still waiting would do the same work: the later one takes its place in the queue instead of
   * waiting behind it. One of that name already running is not replaced, since it may have started
   * from what has changed since: the later one is queued after it.
   */
  enqueue(name: string, run: () => Promise<void>): void {
    const waiting = this.queue.find((job) => job.name === name);
    if (waiting) waiting.run = run;
    else this.queue.push({ name, run });
    void this.pump();
  }

  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** Resolves once every queued job has finished (used by tests and the seed). */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        const started = Date.now();
        try {
          await job.run();
          this.log.info({ job: job.name, ms: Date.now() - started }, 'job done');
        } catch (err) {
          this.log.error({ job: job.name, err }, 'job failed');
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }
}
