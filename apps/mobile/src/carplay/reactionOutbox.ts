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
const PERMANENT_ERRORS = new Map([[400, 'bad_request'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict']]);

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
  private sessionRevision = 0;
  private waitingForSession = false;
  private accountId: string | null = null;
  private readonly unavailableUsers = new Set<string>();

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
    if (this.canSend(entry.userId)) void this.flush();
    return true;
  }

  clear(): Promise<void> {
    this.generation++;
    this.loaded = true;
    this.pending.clear();
    this.waitingForSession = false;
    this.accountId = null;
    this.unavailableUsers.clear();
    this.request?.abort();
    this.stopRetry();
    this.delay = RETRY_START_MS;
    return this.onDisk(() => this.deps.file.clear());
  }

  /** A page can identify its account (D283). Foreground and connection events keep that filter. */
  refreshSession(accountId = this.accountId): Promise<void> {
    const switched = this.accountId !== null && accountId !== null && accountId !== this.accountId;
    const oldRequest = switched ? this.request : null;
    oldRequest?.abort();
    this.accountId = accountId;
    this.sessionRevision++;
    this.waitingForSession = false;
    this.unavailableUsers.clear();
    if (!switched) return this.flush();
    const flushNewAccount = () => {
      this.delay = RETRY_START_MS;
      return this.flush();
    };
    // A drain still reading disk has not started any requests and can use the new account itself.
    return oldRequest && this.flushing ? this.flushing.then(flushNewAccount) : flushNewAccount();
  }

  private canSend(userId: string): boolean {
    return (this.accountId === null || userId === this.accountId)
      && !this.waitingForSession && !this.unavailableUsers.has(userId);
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.stopRetry();
    this.flushing = this.drain().catch(() => undefined).finally(() => {
      this.flushing = null;
      if (!this.waitingForSession && (!this.loaded || [...this.pending.values()].some((entry) => this.canSend(entry.userId)))) {
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
        if (!this.canSend(userId)) continue;
        const sessionRevision = this.sessionRevision;
        // The server compares this owner against the cookie on this same request.
        const response = await this.deps.fetch(`${origin}/api/books/${encodeURIComponent(bookId)}/comments`, {
          ...init, method: 'POST', headers: { 'content-type': 'application/json', 'x-bookclub-user': userId }, body: JSON.stringify(body),
        });
        if (request.signal.aborted || response.status === 408 || response.status === 429 || response.status >= 500) return;
        if (!response.ok) {
          const code = await errorCode(response);
          if (request.signal.aborted) return;
          if (response.status === 401) {
            if (sessionRevision === this.sessionRevision) this.waitingForSession = code === 'unauthorized';
            return;
          }
          if (response.status === 409 && code === 'session_changed' && sessionRevision === this.sessionRevision) this.unavailableUsers.add(userId);
          if (!code || PERMANENT_ERRORS.get(response.status) !== code) continue;
        }
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

async function errorCode(response: Response): Promise<string | undefined> {
  // A proxy can return the same status as the app. Read the app's error before deciding.
  if (response.status !== 401 && !PERMANENT_ERRORS.has(response.status)) return undefined;
  const error = ApiErrorSchema.safeParse(await response.json().catch(() => null));
  return error.success ? error.data.error.code : undefined;
}
