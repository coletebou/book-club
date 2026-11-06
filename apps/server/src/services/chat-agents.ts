import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CAL_AGENT_HANDLE, type ChatAgentAvatar, type ChatAgentView } from '@bookclub/shared';
import { type FastifyBaseLogger } from 'fastify';
import { RateLimiter } from '../auth/ratelimit';
import { type ChatModel } from '../cal/anthropic';
import { type ChatAgentConfig, type Config } from '../config';
import { type Db } from '../db/db';
import { ensureAgentUser } from '../repos/users';

/** Whether Cal is set up on this server (D160): a key for his model, or the test-only fake model. */
export function calEnabled(config: Pick<Config, 'ANTHROPIC_API_KEY' | 'CAL_TEST_FAKE_MODEL'>): boolean {
  return Boolean(config.ANTHROPIC_API_KEY) || config.CAL_TEST_FAKE_MODEL;
}

/**
 * An agent that takes part in a club's chat (D204, D205): Cal, and agents of other services
 * (`CHAT_AGENTS`). It is @-mentioned by its handle, writes as its own `users` row (migration 024,
 * never an account), and is shown as what it is.
 */
export interface ChatAgent {
  /** What it answers to after `@` (`cal`, `lux`). */
  readonly handle: string;
  readonly displayName: string;
  /** Its `users` row: the author of every message it writes. */
  readonly userId: string;
  readonly kind: 'cal' | 'webhook';
  /** One line for the composer's picker: what it is, and what happens to a message that names it. */
  readonly about: string;
  readonly avatar: ChatAgentAvatar | null;
}

/** Where an agent of another service is reached, and how it proves itself (D205). Never leaves the server. */
export interface WebhookSettings {
  readonly url: string;
  readonly secret: string;
  /** The clubs it is in: every one (`*`), or these. */
  readonly clubs: '*' | ReadonlySet<string>;
  readonly perMemberPerMinute: number;
  readonly perMinute: number;
  /** SHA-256 of its bearer token: tokens are compared as digests, in time that says nothing about them. */
  readonly tokenDigest: Buffer;
}

const CAL_ABOUT = 'The club’s AI librarian. He answers in the thread, from what you have read, hidden from anyone who has not read as far.';

function webhookAbout(config: ChatAgentConfig): string {
  const sent = `A message that names ${config.name} is sent to it, outside Book Club, with the conversation it is in.`;
  return config.about ? `${config.about} ${sent}` : sent;
}

function avatarOf(avatar: string | undefined): ChatAgentAvatar | null {
  if (!avatar) return null;
  return avatar.startsWith('data:') ? { kind: 'image', src: avatar } : { kind: 'text', text: avatar };
}

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest();

/**
 * The agents of this server, read from its configuration once at start (their `users` rows made
 * then), and the work they do in the background: a turn of Cal's (D204) and a delivery to an
 * agent's webhook (D205) run after the message that asked them is saved and answered, so they are
 * tracked here (`run`) for shutdown and for tests to wait on (`idle`), apart from `calJobs`, whose
 * one-at-a-time queue would put a friend's question behind a book's indexing.
 */
export class ChatAgents {
  private readonly agents: ChatAgent[] = [];
  private readonly webhooks = new Map<string, WebhookSettings>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly stopping = new AbortController();
  /** Signs the short-lived addresses an agent fetches a message's pictures by (D205); new each start, so they die with it. */
  private readonly mediaKey = randomBytes(32);
  /** Test seam: the model Cal's chat turns use instead of the configured one (the fake, or Anthropic's). */
  calModel: (() => ChatModel) | null = null;
  /** How long to wait before each retry of a delivery that did not get through (a test may shorten them). */
  retryDelaysMs: readonly number[] = [1000, 4000];

  constructor(
    db: Db,
    config: Config,
    private readonly log: FastifyBaseLogger,
  ) {
    if (calEnabled(config)) {
      const row = ensureAgentUser(db, { handle: CAL_AGENT_HANDLE, displayName: 'Cal' });
      this.agents.push({ handle: CAL_AGENT_HANDLE, displayName: row.display_name, userId: row.id, kind: 'cal', about: CAL_ABOUT, avatar: null });
    }
    for (const a of config.CHAT_AGENTS) {
      const row = ensureAgentUser(db, { handle: a.handle, displayName: a.name });
      this.agents.push({ handle: a.handle, displayName: a.name, userId: row.id, kind: 'webhook', about: webhookAbout(a), avatar: avatarOf(a.avatar) });
      this.webhooks.set(a.handle, {
        url: a.webhookUrl,
        secret: a.webhookSecret,
        clubs: a.clubs === '*' ? '*' : new Set(a.clubs),
        perMemberPerMinute: a.perMemberPerMinute,
        perMinute: a.perMinute,
        tokenDigest: digest(a.token),
      });
    }
  }

  /** Whether an agent can be @-mentioned in a club. Cal, when set up, is in every club, as his panel is. */
  enabledIn(agent: ChatAgent, clubId: string): boolean {
    if (agent.kind === 'cal') return true;
    const clubs = this.webhooks.get(agent.handle)?.clubs;
    return clubs === '*' || (clubs?.has(clubId) ?? false);
  }

  /** The agents that can be @-mentioned in a club. */
  forClub(clubId: string): readonly ChatAgent[] {
    return this.agents.filter((a) => this.enabledIn(a, clubId));
  }

  byHandle(handle: string): ChatAgent | undefined {
    return this.agents.find((a) => a.handle === handle);
  }

  /** A webhook agent's own settings (D205): where it is reached and how. */
  webhookOf(agent: ChatAgent): WebhookSettings | undefined {
    return this.webhooks.get(agent.handle);
  }

  /** The agent whose bearer token this is (D205), comparing it with every agent's, each in constant time. */
  byToken(token: string): ChatAgent | undefined {
    const offered = digest(token);
    let found: ChatAgent | undefined;
    for (const agent of this.agents) {
      const settings = this.webhooks.get(agent.handle);
      if (settings && timingSafeEqual(offered, settings.tokenDigest)) found = agent;
    }
    return found;
  }

  /** The signature of a picture's address for an agent, good until `expires` (ms). */
  mediaSignature(handle: string, attachmentId: string, expires: number): string {
    return createHmac('sha256', this.mediaKey).update(`${handle}.${attachmentId}.${expires}`).digest('base64url');
  }

  /** Whether a picture's address was signed here, for this agent and this picture, and is still good. */
  mediaSignatureValid(handle: string, attachmentId: string, expires: number, signature: string, now = Date.now()): boolean {
    if (!Number.isSafeInteger(expires) || expires < now) return false;
    const expected = Buffer.from(this.mediaSignature(handle, attachmentId, expires));
    const offered = Buffer.from(signature);
    return offered.length === expected.length && timingSafeEqual(offered, expected);
  }

  /** One limiter per purpose (an agent's limit per person, its limit overall, its API's), D168's sliding minute. */
  limiter(name: string, perMinute: number): RateLimiter {
    let limiter = this.limiters.get(name);
    if (!limiter) {
      limiter = new RateLimiter(perMinute, 60_000);
      this.limiters.set(name, limiter);
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

  /** Aborted when the server stops: work under way gives up at once, rather than hold the shutdown. */
  get shutdown(): AbortSignal {
    return this.stopping.signal;
  }

  /** The server is stopping: call off whatever agents are doing (each says so to whoever asked, if it can). */
  stop(): void {
    this.stopping.abort(new Error('the server is stopping'));
  }

  get pending(): number {
    return this.inFlight.size;
  }

  /** Resolves once no agent work is running (shutdown, tests' settle), including work started meanwhile. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}

/** An agent as the composer offers it (`GET /api/clubs/:clubId/chat/agents`): never where it is reached or how. */
export function toAgentView(agent: ChatAgent): ChatAgentView {
  return { handle: agent.handle, displayName: agent.displayName, kind: agent.kind, about: agent.about, avatar: agent.avatar };
}
