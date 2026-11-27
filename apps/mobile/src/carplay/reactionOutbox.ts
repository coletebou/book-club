import { ApiErrorSchema, type Reaction } from '@bookclub/shared';
import { type AudioPlace } from '../audio/BackgroundProgress';

export interface PendingReaction {
  readonly userId: string;
  readonly bookId: string;
  readonly editionId: string;
  readonly locator: AudioPlace;
  readonly reaction: Reaction;
  readonly clientId: string;
}

export interface ReactionFile {
  read(accept: (entry: PendingReaction) => void): Promise<void>;
  write(entry: PendingReaction): Promise<void>;
  remove(clientId: string): Promise<void>;
  clear(): Promise<void>;
}

interface OutboxDeps {
  readonly serverUrl: string;
  readonly file: ReactionFile;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const RETRY_START_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const ATTEMPT_MS = 10_000;

/** A tap is saved before sending. Every retry keeps the id that the comment route deduplicates. */
export class ReactionOutbox {
  private readonly pending = new Map<string, PendingReaction>();
  private disk: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private flushing: Promise<void> | null = null;
  private request: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private delay = RETRY_START_MS;
  private generation = 0;

  constructor(private readonly deps: OutboxDeps) {}

  async keep(entry: PendingReaction): Promise<boolean> {
    const generation = this.generation;
    const write = this.onDisk(async () => {
      if (generation !== this.generation) return;
      await this.deps.file.write(entry);
      if (generation === this.generation) this.pending.set(entry.clientId, entry);
    });
    await write;
    if (generation !== this.generation) return false;
    void this.flush();
    return true;
  }

  clear(): Promise<void> {
    this.generation++;
    this.loaded = true;
    this.pending.clear();
    this.request?.abort();
    this.stopRetry();
    this.delay = RETRY_START_MS;
    return this.onDisk(() => this.deps.file.clear());
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.stopRetry();
    this.flushing = this.drain().catch(() => undefined).finally(() => {
      this.flushing = null;
      if (!this.loaded || this.pending.size > 0) {
        this.retryTimer = setTimeout(() => void this.flush(), this.delay);
        this.delay = Math.min(this.delay * 2, RETRY_MAX_MS);
      } else {
        this.delay = RETRY_START_MS;
      }
    });
    return this.flushing;
  }

  private onDisk(op: () => Promise<void>): Promise<void> {
    const result = this.disk.catch(() => undefined).then(op);
    this.disk = result;
    return result;
  }

  private stopRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async drain(): Promise<void> {
    if (!this.loaded) {
      await this.onDisk(async () => {
        if (this.loaded) return;
        await this.deps.file.read((entry) => {
          if (!this.loaded) this.pending.set(entry.clientId, entry);
        });
        this.loaded = true;
      }).catch(() => undefined); // Deliver what could be read; retry the rest.
    }
    if (this.pending.size === 0) return;
    const request = new AbortController();
    this.request = request;
    const timeout = setTimeout(() => request.abort(), ATTEMPT_MS);
    const init = { credentials: 'include', signal: request.signal } as const;
    const origin = this.deps.serverUrl.replace(/\/$/, '');
    try {
      for (const { userId, bookId, ...body } of [...this.pending.values()]) {
        if (request.signal.aborted) return;
        // The server compares this owner against the cookie on this same request.
        const response = await this.deps.fetch(`${origin}/api/books/${encodeURIComponent(bookId)}/comments`, {
          ...init, method: 'POST', headers: { 'content-type': 'application/json', 'x-bookclub-user': userId }, body: JSON.stringify(body),
        });
        if (request.signal.aborted || response.status === 401 || response.status === 408 || response.status === 429 || response.status >= 500) return;
        if (!response.ok && !(await refusedForGood(response))) continue;
        await this.onDisk(async () => {
          if (request.signal.aborted) return;
          await this.deps.file.remove(body.clientId);
          this.pending.delete(body.clientId);
        });
      }
    } finally {
      clearTimeout(timeout);
      this.request = null;
    }
  }
}

async function refusedForGood(response: Response): Promise<boolean> {
  // A missing book, invalid tap, or deleted comment will never take this id. A changed session
  // uses the same 409 status as a deleted comment but must leave the original person's tap alone.
  if ([400, 403, 404].includes(response.status)) return true;
  if (response.status !== 409) return false;
  const error = ApiErrorSchema.safeParse(await response.json().catch(() => null));
  return error.success && error.data.error.code === 'conflict';
}
