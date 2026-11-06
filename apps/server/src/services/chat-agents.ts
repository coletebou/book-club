import { CAL_AGENT_HANDLE, type ChatAgentView } from '@bookclub/shared';
import { type FastifyBaseLogger } from 'fastify';
import { RateLimiter } from '../auth/ratelimit';
import { type ChatModel } from '../cal/anthropic';
import { type Config } from '../config';
import { type Db } from '../db/db';
import { ensureAgentUser } from '../repos/users';

/** Whether Cal is set up on this server (D160): a key for his model, or the test-only fake model. */
export function calEnabled(config: Pick<Config, 'ANTHROPIC_API_KEY' | 'CAL_TEST_FAKE_MODEL'>): boolean {
  return Boolean(config.ANTHROPIC_API_KEY) || config.CAL_TEST_FAKE_MODEL;
}

/**
 * An agent that takes part in a club's chat (D204): Cal, and in time agents of other services
 * (D205). It is @-mentioned by its handle, writes as its own `users` row (migration 024, never an
 * account), and is shown as what it is.
 */
export interface ChatAgent {
  /** What it answers to after `@` (`cal`). */
  readonly handle: string;
  readonly displayName: string;
  /** Its `users` row: the author of every message it writes. */
  readonly userId: string;
  readonly kind: 'cal' | 'webhook';
  /** One line for the composer's picker: what it is, and what happens to a message that names it. */
  readonly about: string;
}

const CAL_ABOUT = 'The club’s AI librarian. He answers in the thread, from what you have read, hidden from anyone who has not read as far.';

/**
 * The agents of this server, read from its configuration once at start (their `users` rows made
 * then), and the work they do in the background: a turn of Cal's runs after the message that
 * asked him is saved and answered, so it is tracked here (`run`) for shutdown and for tests to
 * wait on (`idle`), apart from `calJobs`, whose one-at-a-time queue would put a friend's question
 * behind a book's indexing.
 */
export class ChatAgents {
  private readonly agents: ChatAgent[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly limiters = new Map<string, RateLimiter>();
  /** Test seam: the model Cal's chat turns use instead of the configured one (the fake, or Anthropic's). */
  calModel: (() => ChatModel) | null = null;

  constructor(
    db: Db,
    config: Config,
    private readonly log: FastifyBaseLogger,
  ) {
    if (calEnabled(config)) {
      const row = ensureAgentUser(db, { handle: CAL_AGENT_HANDLE, displayName: 'Cal' });
      this.agents.push({ handle: CAL_AGENT_HANDLE, displayName: row.display_name, userId: row.id, kind: 'cal', about: CAL_ABOUT });
    }
  }

  /** The agents that can be @-mentioned in a club. Cal, when set up, is in every club, as his panel is. */
  forClub(_clubId: string): readonly ChatAgent[] {
    return this.agents;
  }

  byHandle(handle: string): ChatAgent | undefined {
    return this.agents.find((a) => a.handle === handle);
  }

  /** One limiter per agent, per person asking (D168's sliding minute). */
  limiter(handle: string, perMinute: number): RateLimiter {
    let limiter = this.limiters.get(handle);
    if (!limiter) {
      limiter = new RateLimiter(perMinute, 60_000);
      this.limiters.set(handle, limiter);
    }
    return limiter;
  }

  /** Run an agent's work in the background, tracked; a failure is logged, never thrown at anyone. */
  run(name: string, task: () => Promise<void>): void {
    const job = (async () => {
      try {
        await task();
      } catch (err) {
        this.log.error({ err, task: name }, 'chat agent task failed');
      }
    })();
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
  }

  get pending(): number {
    return this.inFlight.size;
  }

  /** Resolves once no agent work is running (shutdown, tests' settle), including work started meanwhile. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}

/** An agent as the composer offers it (`GET /api/clubs/:clubId/chat/agents`). */
export function toAgentView(agent: ChatAgent): ChatAgentView {
  return { handle: agent.handle, displayName: agent.displayName, kind: agent.kind, about: agent.about };
}
